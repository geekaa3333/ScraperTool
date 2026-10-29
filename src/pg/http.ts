/**
 * HTTP surface for authentication, ownership-scoped history and report access.
 *
 * This module is deliberately self-contained. It intercepts `/api/auth/*`,
 * `/api/jobs*` and `/api/reports/*` before the existing API router runs, so the
 * scraping code in `server.ts` is untouched and its behaviour cannot regress.
 *
 * Ownership is enforced in two independent places:
 *   1. Every route here requires a session and passes its `userId` into the
 *      store, whose queries are scoped by that id.
 *   2. A report id that belongs to someone else returns 404, not 403 — telling
 *      an attacker "this exists but is not yours" is itself a leak.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { SessionUser } from './store.js';
import type { DataStore } from './store-contract.js';
import { archiveJobReports, readReportForDownload, signedReportUrl } from '../reports.js';
import { buildExportRows } from '../exports.js';
import type { ReportStorage } from '../storage/index.js';
import { createReportStorage } from '../storage/index.js';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  buildCookie,
  checkPassword,
  clearCookie,
  dummyPasswordVerify,
  isValidEmail,
  normaliseEmail,
  parseCookies,
  safeEqual,
  verifyPassword,
} from '../auth.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface AuthLayerOptions {
  secureCookies: boolean;
  /** Return the reset link instead of mailing it. Development aid only. */
  exposeResetToken?: boolean;
  /** Private report storage. Defaults to the configured backend. */
  storage?: ReportStorage;
}

export class AuthLayer {
  /**
   * Login attempts per IP.
   *
   * In-process and therefore per-instance. That is enough to blunt credential
   * stuffing against a single backend, and it is stated plainly rather than
   * implied to be distributed; a multi-instance deployment moves this to a
   * shared store without changing the call sites.
   */
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  private readonly storage: ReportStorage;

  constructor(
    private readonly store: DataStore,
    private readonly options: AuthLayerOptions,
  ) {
    this.maxAttempts = Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 10);
    this.windowMs = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS ?? 15 * 60_000);
    this.storage = options.storage ?? createReportStorage();
  }

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------

  /** Returns true when this layer handled the request. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;

    if (path === '/api/auth/register') return this.post(req, res, () => this.register(req));
    if (path === '/api/auth/login') return this.post(req, res, () => this.login(req));
    if (path === '/api/auth/logout') return this.post(req, res, () => this.logout(req, res));
    if (path === '/api/auth/password-reset') return this.post(req, res, () => this.requestReset(req));
    if (path === '/api/auth/password-reset/confirm') {
      return this.post(req, res, () => this.confirmReset(req));
    }
    if (path === '/api/auth/me') return this.get(req, res, () => this.me(req));

    if (path === '/api/jobs' || path.startsWith('/api/jobs/')) {
      // Generating reports mutates state, so it takes the POST branch and the
      // CSRF check; reading them stays on GET.
      const reportMatch = /^\/api\/jobs\/([0-9a-fA-F-]{36})\/reports$/.exec(path);
      if (reportMatch && req.method === 'POST') {
        return this.post(req, res, () => this.generateReports(req, res, reportMatch[1]!));
      }
      return this.get(req, res, () => this.jobs(req, res, path, url));
    }
    if (path.startsWith('/api/reports/')) {
      return this.get(req, res, () => this.downloadReport(req, res, path));
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Session helpers
  // -------------------------------------------------------------------------

  /** Resolve the caller, or null. Never throws for a missing or bad cookie. */
  async currentUser(req: IncomingMessage): Promise<SessionUser | null> {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (!token) return null;
    return this.store.resolveSession(token);
  }

  /**
   * Require a signed-in user and a matching CSRF token.
   *
   * CSRF is enforced on every state-changing request because the session
   * cookie is sent automatically by the browser; without this check any site
   * the user visits could drive their account.
   */
  private async requireUser(
    req: IncomingMessage,
    res: ServerResponse,
    mutating: boolean,
  ): Promise<SessionUser | null> {
    const user = await this.currentUser(req);
    if (!user) {
      sendJson(res, 401, { error: 'Authentication required' });
      return null;
    }
    if (mutating) {
      const provided = String(req.headers[CSRF_HEADER] ?? '');
      if (!provided || !safeEqual(provided, user.csrfToken)) {
        sendJson(res, 403, { error: 'Invalid or missing CSRF token' });
        return null;
      }
    }
    return user;
  }

  private issueSession(res: ServerResponse, user: SessionUser, token: string, csrfToken: string, expiresAt: Date): void {
    const secure = this.options.secureCookies;
    const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));

    // The session cookie is httpOnly: JavaScript cannot read it, so an XSS bug
    // cannot exfiltrate a usable credential.
    //
    // The CSRF cookie is deliberately readable, because the frontend has to
    // copy it into the request header. It is not a credential on its own.
    res.setHeader(
      'set-cookie',
      [
        buildCookie(SESSION_COOKIE, token, { maxAge, httpOnly: true, secure, sameSite: 'Lax' }),
        buildCookie(CSRF_COOKIE, csrfToken, { maxAge, httpOnly: false, secure, sameSite: 'Lax' }),
      ],
    );
    void user;
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  private async register(req: IncomingMessage): Promise<unknown> {
    const body = await readJson(req);
    const email = String(body.email ?? '');
    const password = String(body.password ?? '');
    const displayName = String(body.displayName ?? '').trim();

    if (!isValidEmail(email)) return httpError(400, 'Enter a valid email address.');
    const policy = checkPassword(password);
    if (!policy.ok) return httpError(400, policy.reason!);
    if (!displayName) return httpError(400, 'A display name is required.');

    const existing = await this.store.findUserByEmail(email);
    if (existing) return httpError(409, 'An account with that email already exists.');

    const user = await this.store.createUser({ email, displayName, password });
    return { userId: user.userId, email: user.email, displayName: user.displayName, role: user.role };
  }

  private async login(req: IncomingMessage): Promise<unknown> {
    const ip = clientIp(req);
    if (this.throttled(ip)) return httpError(429, 'Too many sign-in attempts. Try again later.');

    const body = await readJson(req);
    const email = String(body.email ?? '');
    const password = String(body.password ?? '');

    const user = await this.store.findUserByEmail(email);
    if (!user) {
      // Spend the same work as a real verification so an unknown email cannot
      // be detected by how quickly the response arrives.
      await dummyPasswordVerify(password);
      return httpError(401, 'Incorrect email or password.');
    }

    const ok = await verifyPassword(password, {
      hash: user.hash,
      salt: user.salt,
      params: user.params,
    });
    if (!ok) {
      this.recordFailure(ip);
      return httpError(401, 'Incorrect email or password.');
    }

    this.attempts.delete(ip);
    await this.store.recordLogin(user.userId);

    const session = await this.store.createSession(user.userId, {
      userAgent: req.headers['user-agent'] ?? null,
      ip,
    });
    const resolved = await this.store.resolveSession(session.token);
    if (!resolved) return httpError(500, 'Could not start a session.');

    this.pendingCookies = {
      token: session.token,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      user: resolved,
    };
    return {
      userId: resolved.userId,
      email: resolved.email,
      displayName: resolved.displayName,
      role: resolved.role,
      csrfToken: resolved.csrfToken,
    };
  }

  private pendingCookies: {
    token: string;
    csrfToken: string;
    expiresAt: Date;
    user: SessionUser;
  } | null = null;

  private async logout(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    const user = await this.currentUser(req);
    if (!user) return { ok: true };
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (token) await this.store.deleteSession(token);

    const secure = this.options.secureCookies;
    res.setHeader('set-cookie', [clearCookie(SESSION_COOKIE, secure), clearCookie(CSRF_COOKIE, secure)]);
    void user;
    return { ok: true };
  }

  private async me(req: IncomingMessage): Promise<unknown> {
    const user = await this.currentUser(req);
    if (!user) return httpError(401, 'Not signed in.');
    return {
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      csrfToken: user.csrfToken,
    };
  }

  /**
   * Start a password reset.
   *
   * Always reports success whether or not the address exists. A different
   * response would turn this endpoint into an account-enumeration oracle.
   */
  private async requestReset(req: IncomingMessage): Promise<unknown> {
    const body = await readJson(req);
    const email = String(body.email ?? '');
    const account = isValidEmail(email) ? await this.store.findUserByEmail(email) : null;

    if (account) {
      const token = await this.store.createPasswordReset(account.userId);
      // In production this is handed to an email provider. Until one is
      // configured, surface it only when explicitly asked to, so a deployment
      // cannot accidentally leak reset links into API responses.
      if (this.options.exposeResetToken) {
        console.error(`[auth] password reset for ${normaliseEmail(email)}: ${token}`);
      }
    }
    return { ok: true, message: 'If that address has an account, a reset link has been sent.' };
  }

  private async confirmReset(req: IncomingMessage): Promise<unknown> {
    const body = await readJson(req);
    const token = String(body.token ?? '');
    const password = String(body.password ?? '');
    if (!token) return httpError(400, 'A reset token is required.');

    const policy = checkPassword(password);
    if (!policy.ok) return httpError(400, policy.reason!);

    const userId = await this.store.consumePasswordReset(token);
    if (!userId) return httpError(400, 'That reset link is invalid or has expired.');
    await this.store.updatePassword(userId, password);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  private async jobs(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<unknown> {
    const user = await this.requireUser(req, res, false);
    if (!user) return undefined;

    const jobMatch = /^\/api\/jobs\/([0-9a-fA-F-]{36})(\/[^/]*)?$/.exec(path);
    if (jobMatch) {
      const jobId = jobMatch[1]!;
      const job = await this.store.getJob(user.userId, jobId);
      // 404 rather than 403: a stranger must not learn that this id exists.
      if (!job) return httpError(404, 'No such job.');

      if (jobMatch[2] === '/reports') {
        return { jobId, reports: await this.store.listReports(user.userId, jobId) };
      }
      const [progress, quality, files] = await Promise.all([
        this.store.getMarketplaceProgress(user.userId, jobId),
        this.store.dataQuality(user.userId, jobId),
        this.store.listUploads(user.userId, jobId),
      ]);
      return { job, progress, quality, files, reports: await this.store.listReports(user.userId, jobId) };
    }

    const result = await this.store.listJobs(user.userId, {
      status: url.searchParams.get('status'),
      marketplaceId: url.searchParams.get('marketplace'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      search: url.searchParams.get('q'),
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      offset: url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : undefined,
    });
    return result;
  }

  /**
   * Generate and archive XLSX + TSV for a job.
   *
   * Reads the stored results rather than re-scraping, which is the point of
   * archiving: a report can be regenerated weeks later from what was captured,
   * and stays consistent with the accuracy rules because it goes through the
   * same `rowsForProduct` the live path uses.
   */
  private async generateReports(
    req: IncomingMessage,
    res: ServerResponse,
    jobId: string,
  ): Promise<unknown> {
    const user = await this.requireUser(req, res, true);
    if (!user) return undefined;

    const job = await this.store.getJob(user.userId, jobId);
    if (!job) return httpError(404, 'No such job.');

    const results = await this.store.loadJobResults(user.userId, jobId);
    if (results.length === 0) {
      return httpError(409, 'This job has no stored results to export yet.');
    }

    const archived = await archiveJobReports(this.store, this.storage, {
      userId: user.userId,
      jobId,
      rows: buildExportRows(results as never[]),
    });

    return {
      jobId,
      reports: archived.map((r) => ({
        reportId: r.reportId,
        reportType: r.reportType,
        filename: r.filename,
        size: r.size,
        checksum: r.checksum,
        status: r.status,
        ...(r.error ? { error: r.error } : {}),
      })),
      available: archived.filter((r) => r.status === 'AVAILABLE').length,
    };
  }

  private async downloadReport(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<unknown> {
    const user = await this.requireUser(req, res, false);
    if (!user) return undefined;

    const match = /^\/api\/reports\/([0-9a-fA-F-]{36})\/download$/.exec(path);
    if (!match) return false;

    const reportId = match[1]!;
    const record = await this.store.getReport(user.userId, reportId);
    // 404 for "does not exist", "not yours" and "not stored" alike: telling them
    // apart would let a caller probe which report ids are real.
    if (!record || !record.storageKey) return httpError(404, 'No such report.');

    // Large files bypass the API process when the backend supports it. The
    // bucket stays private; the URL expires on its own.
    const direct = await signedReportUrl(this.storage, record.storageKey, record.filename, 300);
    if (direct) {
      res.writeHead(302, {
        location: direct,
        // The signed URL itself is private to this user for the next five
        // minutes, so it is not cached beyond that by any shared cache.
        'cache-control': 'no-store, private',
      });
      res.end();
      return undefined;
    }

    const payload = await readReportForDownload(this.store, this.storage, user.userId, reportId);
    if (!payload) return httpError(410, 'The stored report file is no longer available.');

    // Private data: never held in a proxy cache or the browser disk cache.
    res.writeHead(200, {
      'content-type': payload.contentType,
      'content-length': String(payload.bytes.length),
      'content-disposition': `attachment; filename="${payload.filename.replace(/["\\]/g, '')}"`,
      'cache-control': 'no-store, private',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      etag: `"${payload.checksum.slice(0, 32)}"`,
    });
    res.end(payload.bytes);
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private async post(
    req: IncomingMessage,
    res: ServerResponse,
    handler: () => Promise<unknown>,
  ): Promise<boolean> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    let result: unknown;
    try {
      result = await handler();
    } catch (error) {
      // A rejected body is a client error, not a crash: answer and move on.
      const status = (error as { status?: number }).status ?? 500;
      sendJson(res, status, {
        error: status === 413 ? 'Request body too large' : 'Invalid request',
      });
      return true;
    }
    if (result === undefined) return true; // handler already responded
    if (this.pendingCookies) {
      const pending = this.pendingCookies;
      this.pendingCookies = null;
      this.issueSession(res, pending.user, pending.token, pending.csrfToken, pending.expiresAt);
    }
    const status = (result as { status?: number }).status;
    sendJson(res, typeof status === 'number' ? status : 200, result);
    return true;
  }

  private async get(
    req: IncomingMessage,
    res: ServerResponse,
    handler: () => Promise<unknown>,
  ): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    let result: unknown;
    try {
      result = await handler();
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      sendJson(res, status, {
        error: status === 413 ? 'Request body too large' : 'Invalid request',
      });
      return true;
    }
    if (result === false) return false;
    if (result === undefined) return true;
    // Honour the status an error result carries. Without this a handler that
    // returned `httpError(401, ...)` was answered 200, so an unauthenticated
    // /api/auth/me reported success and the UI would believe a user was signed
    // in when nobody was.
    const status = (result as { status?: number }).status;
    sendJson(res, typeof status === 'number' ? status : 200, result);
    return true;
  }

  /**
   * Does this user own this job?
   *
   * Used to guard the pre-existing SQLite scraping routes, whose data model
   * predates users. Returns false rather than throwing so the caller can
   * answer 404 without leaking that the id exists.
   */
  async ownsJob(userId: string, jobId: string): Promise<boolean> {
    return (await this.store.getJob(userId, jobId)) !== null;
  }

  /** Require a session for any API route. Returns false when already answered. */
  async requireUserForRequest(
    req: IncomingMessage,
    res: ServerResponse,
    mutating: boolean,
  ): Promise<SessionUser | null> {
    return this.requireUser(req, res, mutating);
  }

  private throttled(ip: string): boolean {
    const entry = this.attempts.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
      this.attempts.delete(ip);
      return false;
    }
    return entry.count >= this.maxAttempts;
  }

  private recordFailure(ip: string): void {
    const entry = this.attempts.get(ip);
    if (!entry || Date.now() > entry.resetAt) {
      this.attempts.set(ip, { count: 1, resetAt: Date.now() + this.windowMs });
      return;
    }
    entry.count += 1;
  }
}

// ---------------------------------------------------------------------------

function httpError(status: number, message: string): { error: string; kind: string; status: number } {
  return { error: message, kind: 'error', status };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

class BodyTooLarge extends Error {
  readonly status = 413;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // Bound the body: an unbounded read is a trivial memory-exhaustion vector.
    // Keep draining rather than returning early, so the client's upload is not
    // left blocking on a socket that will never be read again.
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(buf);
  }
  if (tooLarge) throw new BodyTooLarge('Request body too large');
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (header ?? req.socket.remoteAddress ?? 'unknown').split(',')[0]!.trim();
}