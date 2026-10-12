/**
 * Private report storage.
 *
 * Generated reports must outlive the process that made them. Keeping them on
 * the container filesystem means a redeploy deletes every report a user is
 * still entitled to download, so this module persists them and the backend is
 * recorded on the report row.
 *
 * Two backends are provided:
 *   - local: a private directory, never inside the static web root
 *   - s3:    any S3-compatible bucket, reached with short-lived signed URLs
 *
 * Both satisfy one interface so nothing above this layer branches on which one
 * is in use.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface StoredObject {
  /** Opaque key handed to the storage backend. Never exposed to a browser. */
  key: string;
  size: number;
  /** Hex SHA-256 of the bytes, so tampering is detectable after the fact. */
  checksum: string;
}

export interface ReportStorage {
  readonly backend: 'local' | 's3';
  put(key: string, bytes: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Time-limited direct URL, or null when the backend serves bytes itself. */
  signedUrl?(key: string, expiresInSeconds: number, filename: string): Promise<string | null>;
}

export function checksumOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Key construction
// ---------------------------------------------------------------------------

/**
 * Build a storage key scoped to one user and report.
 *
 * The user id is part of the key so a listing of the bucket cannot be used to
 * enumerate another account's files, and a leaked key is still useless without
 * the ownership check that gates the download route.
 */
export function reportKey(input: {
  userId: string;
  reportId: string;
  filename: string;
}): string {
  // Separators are stripped, and leading dots are collapsed, so a supplied
  // filename can never form a path segment even if it is used as the last
  // component. The user and report ids come from the database, never from a
  // request, so they are used as-is.
  const safe =
    input.filename
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/\.{2,}/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 120) || 'report';
  return `reports/${input.userId}/${input.reportId}/${safe}`;
}

// ---------------------------------------------------------------------------
// Local backend
// ---------------------------------------------------------------------------

export class LocalReportStorage implements ReportStorage {
  readonly backend = 'local' as const;

  constructor(private readonly root: string) {}

  /** Resolve a key to an absolute path, refusing anything that escapes the root. */
  private resolveKey(key: string): string {
    const root = resolve(this.root);
    const target = resolve(root, key);
    // Path traversal guard: a key like `../../etc/passwd` must not resolve.
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error('Refusing to resolve a storage key outside the storage root');
    }
    return target;
  }

  async put(key: string, bytes: Buffer): Promise<StoredObject> {
    const target = this.resolveKey(key);
    await mkdir(dirname(target), { recursive: true });
    // Write to a temporary name and rename, so a crash mid-write cannot leave a
    // half-written report that later reads as a valid download.
    const temp = `${target}.${process.pid}.part`;
    await writeFile(temp, bytes);
    const { rename } = await import('node:fs/promises');
    await rename(temp, target);
    return { key, size: bytes.length, checksum: checksumOf(bytes) };
  }

  // The traversal guard is applied *before* the I/O try/catch in each method.
  // Inside it, a rejected key would be indistinguishable from a missing object,
  // so an attempt to escape the storage root would read as "not found" and go
  // unrecorded.

  async get(key: string): Promise<Buffer | null> {
    const target = this.resolveKey(key);
    try {
      return await readFile(target);
    } catch {
      // A missing object is an expected state (expired retention, bad key), not
      // an error worth propagating.
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.resolveKey(key);
    try {
      await unlink(target);
    } catch {
      /* already gone */
    }
  }

  async exists(key: string): Promise<boolean> {
    const target = this.resolveKey(key);
    try {
      const info = await stat(target);
      return info.isFile();
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// S3 backend
// ---------------------------------------------------------------------------

export interface S3StorageOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class S3ReportStorage implements ReportStorage {
  readonly backend = 's3' as const;

  constructor(
    private readonly options: S3StorageOptions,
    private readonly client?: unknown,
  ) {}

  private async s3() {
    if (this.client) return this.client;
    const { S3Client } = await import('@aws-sdk/client-s3');
    this.resolved = new S3Client({
      region: this.options.region ?? 'auto',
      ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}),
      forcePathStyle: this.options.forcePathStyle ?? true,
      ...(this.options.accessKeyId && this.options.secretAccessKey
        ? {
            credentials: {
              accessKeyId: this.options.accessKeyId,
              secretAccessKey: this.options.secretAccessKey,
            },
          }
        : {}),
    });
    return this.resolved;
  }
  private resolved: unknown = null;

  async put(key: string, bytes: Buffer, contentType: string): Promise<StoredObject> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = (await this.s3()) as { send: (c: unknown) => Promise<unknown> };
    await client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        // Bucket-level encryption where the provider supports it.
        ServerSideEncryption: 'AES256',
      }),
    );
    return { key, size: bytes.length, checksum: checksumOf(bytes) };
  }

  async get(key: string): Promise<Buffer | null> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const client = (await this.s3()) as { send: (c: unknown) => Promise<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }> };
      const result = await client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = (await this.s3()) as { send: (c: unknown) => Promise<unknown> };
    await client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const client = (await this.s3()) as { send: (c: unknown) => Promise<unknown> };
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A short-lived signed URL.
   *
   * The bucket stays private and no long-lived URL is ever minted. The default
   * of five minutes bounds the window in which a leaked link is useful.
   */
  async signedUrl(key: string, expiresInSeconds: number, filename: string): Promise<string | null> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = await this.s3();
    return getSignedUrl(
      client as never,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"`,
      }),
      { expiresIn: expiresInSeconds },
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the configured backend.
 *
 * Defaults to a private local directory outside `public/`, so reports are never
 * reachable by a static URL even in a single-operator deployment.
 */
export function createReportStorage(): ReportStorage {
  const bucket = process.env.S3_BUCKET;
  if (bucket) {
    return new S3ReportStorage({
      bucket,
      region: process.env.S3_REGION ?? 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    });
  }
  return new LocalReportStorage(
    resolve(process.env.REPORT_STORAGE_DIR ?? join(process.cwd(), 'data', 'reports')),
  );
}

/** Content type for a report, so downloads are served with the right type. */
export function contentTypeFor(reportType: string): string {
  return reportType === 'tsv'
    ? 'text/tab-separated-values; charset=utf-8'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}