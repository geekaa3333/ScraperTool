/**
 * Minimal, strict multipart/form-data reader for single spreadsheet uploads.
 *
 * Hand-rolled rather than pulling in a framework because the requirement is
 * exactly one file field, and a narrow parser is easier to audit than a
 * general-purpose one.
 *
 * Security properties:
 *  - the request body is capped, and the cap is enforced *while streaming* so a
 *    hostile client cannot exhaust memory before the limit is noticed;
 *  - the file is validated by magic bytes, not by the client-supplied filename
 *    or content-type, both of which are trivially spoofed;
 *  - parsing operates on a Buffer with explicit index arithmetic rather than
 *    unbounded regexes over the whole payload.
 */

/** Largest accepted upload. 10 MB is far beyond any realistic ASIN list. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export class UploadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface UploadedFile {
  filename: string;
  contentType: string;
  data: Buffer;
  /**
   * Form field name the file arrived under.
   *
   * In Multi-Region Direct Upload this IS the marketplace declaration, so it
   * must survive parsing. Optional because the legacy single-file path does not
   * use it.
   */
  fieldName?: string;
}

function indexOfBuffer(haystack: Buffer, needle: Buffer, from = 0): number {
  return haystack.indexOf(needle, from);
}

/** Extract the boundary token from a multipart Content-Type header. */
function getBoundary(contentType: string | undefined): Buffer {
  if (!contentType) throw new UploadError('Missing Content-Type header');
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const value = match?.[1] ?? match?.[2];
  if (!value) throw new UploadError('Missing multipart boundary');
  return Buffer.from(`--${value.trim()}`);
}

/**
 * Read a request body with a hard byte cap.
 *
 * `req.destroy()` is called as soon as the cap is exceeded so the client stops
 * sending rather than the server buffering the rest.
 */
export function readBodyLimited(
  req: NodeJS.ReadableStream & { destroy?: (error?: Error) => void },
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (error: Error | null, value?: Buffer) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value as Buffer);
    };

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy?.();
        finish(new UploadError(`Upload exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit`, 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks)));
    req.on('error', (error: Error) => finish(error));
  });
}

/**
 * Pull the first file part out of a multipart body.
 *
 * @param fieldName Name of the form field holding the file.
 */
/**
 * Parse every file part, keeping the form field name on each.
 *
 * Multi-Region Direct Upload posts one part per marketplace, and the **field
 * name is the marketplace declaration** — that is the whole mechanism by which
 * a file knows which Amazon site it belongs to. The previous single-file helper
 * would have thrown the field name away, so it is preserved here.
 */
export function parseMultipartFiles(
  body: Buffer,
  contentType: string | undefined,
): UploadedFile[] {
  if (body.length === 0) throw new UploadError('Empty upload');

  const boundary = getBoundary(contentType);
  const parts: UploadedFile[] = [];

  let cursor = indexOfBuffer(body, boundary);
  if (cursor === -1) throw new UploadError('Malformed multipart body: no boundary found');

  while (cursor !== -1) {
    const partStart = cursor + boundary.length + 2;
    if (partStart > body.length) break;

    const headerEnd = indexOfBuffer(body, Buffer.from('\r\n\r\n'), partStart);
    if (headerEnd === -1) break;

    const headerText = body.subarray(partStart, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;

    const nextBoundary = indexOfBuffer(body, boundary, contentStart);
    if (nextBoundary === -1) break;

    const contentEnd =
      body[nextBoundary - 2] === 0x0d && body[nextBoundary - 1] === 0x0a ? nextBoundary - 2 : nextBoundary;

    const disposition = /content-disposition:[^\r\n]*/i.exec(headerText)?.[0] ?? '';
    const nameMatch = /name="([^"]*)"/i.exec(disposition);
    const filenameMatch = /filename="([^"]*)"/i.exec(disposition);
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);

    if (nameMatch?.[1] && filenameMatch?.[1]) {
      parts.push({
        filename: filenameMatch[1],
        contentType: typeMatch?.[1]?.trim() ?? 'application/octet-stream',
        data: body.subarray(contentStart, contentEnd),
        fieldName: nameMatch[1],
      });
    }

    cursor = nextBoundary;
  }

  if (parts.length === 0) {
    throw new UploadError('No file parts found in the upload');
  }
  return parts.filter((part) => part.data.length > 0);
}

export function parseMultipartFile(
  body: Buffer,
  contentType: string | undefined,
  fieldName = 'file',
): UploadedFile {
  if (body.length === 0) throw new UploadError('Empty upload');

  const boundary = getBoundary(contentType);
  const parts: UploadedFile[] = [];

  let cursor = indexOfBuffer(body, boundary);
  if (cursor === -1) throw new UploadError('Malformed multipart body: no boundary found');

  while (cursor !== -1) {
    // Step past the boundary and its CRLF to reach this part's headers.
    const partStart = cursor + boundary.length + 2;
    if (partStart > body.length) break;

    const headerEnd = indexOfBuffer(body, Buffer.from('\r\n\r\n'), partStart);
    if (headerEnd === -1) break;

    const headerText = body.subarray(partStart, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;

    // Find the next boundary; the CRLF immediately before it belongs to the
    // delimiter, not to the content.
    const nextBoundary = indexOfBuffer(body, boundary, contentStart);
    if (nextBoundary === -1) break;

    const contentEnd =
      body[nextBoundary - 2] === 0x0d && body[nextBoundary - 1] === 0x0a ? nextBoundary - 2 : nextBoundary;

    const disposition = /content-disposition:[^\r\n]*/i.exec(headerText)?.[0] ?? '';
    const nameMatch = /name="([^"]*)"/i.exec(disposition);
    const filenameMatch = /filename="([^"]*)"/i.exec(disposition);
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);

    if (nameMatch?.[1] === fieldName && filenameMatch?.[1]) {
      parts.push({
        filename: filenameMatch[1],
        contentType: typeMatch?.[1]?.trim() ?? 'application/octet-stream',
        data: body.subarray(contentStart, contentEnd),
      });
    }

    cursor = nextBoundary;
  }

  const file = parts[0];
  if (!file) throw new UploadError(`No "${fieldName}" file part found in the upload`);
  if (file.data.length === 0) throw new UploadError('Uploaded file is empty');

  return file;
}

export type WorkbookKind = 'xlsx' | 'xls' | 'unknown';

/**
 * Identify a spreadsheet by its magic bytes.
 *
 * A `.xlsx` is a ZIP archive (`PK\x03\x04`). A legacy `.xls` is an OLE2 compound
 * file (`D0 CF 11 E0 A1 B1 1A E1`). Checking content rather than the filename
 * means a renamed `.exe` cannot get parsed as a workbook.
 */
export function detectWorkbookKind(data: Buffer): WorkbookKind {
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    return 'xlsx';
  }
  if (
    data.length >= 8 &&
    data[0] === 0xd0 &&
    data[1] === 0xcf &&
    data[2] === 0x11 &&
    data[3] === 0xe0 &&
    data[4] === 0xa1 &&
    data[5] === 0xb1 &&
    data[6] === 0x1a &&
    data[7] === 0xe1
  ) {
    return 'xls';
  }
  return 'unknown';
}

/**
 * Validate an upload before any parsing is attempted.
 *
 * @throws UploadError with an actionable message.
 */
export function validateWorkbookUpload(file: UploadedFile): void {
  const kind = detectWorkbookKind(file.data);

  if (kind === 'xls') {
    throw new UploadError(
      'This is a legacy binary .xls file. Open it in Excel or LibreOffice and use "Save As → Excel Workbook (.xlsx)", then upload that file. ' +
        'The .xls container cannot be read by the spreadsheet parser used here.',
      415,
    );
  }

  if (kind === 'unknown') {
    throw new UploadError(
      'That file is not a recognised Excel workbook. Upload an .xlsx file exported from Excel, LibreOffice Calc or Google Sheets.',
      415,
    );
  }
}