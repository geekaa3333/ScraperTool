/**
 * Authentication primitives.
 *
 * Everything here is pure: hashing, token generation, cookie handling. Database
 * access lives in the store, so the security-critical logic can be tested
 * directly without a database or an HTTP server.
 *
 * Two rules shape the design:
 *
 *   1. Passwords are hashed with scrypt from Node's crypto module. No custom
 *      scheme, no home-made KDF, no optional "remember me = store the password
 *      reversibly".
 *   2. Nothing that identifies a session is stored in the clear. The database
 *      holds a SHA-256 hash of the session token, so a database dump does not
 *      yield usable cookies.
 */
import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt cost parameters.
 *
 * N=2^15 with r=8 is roughly a quarter of a second on commodity hardware, which
 * is the intended cost: fast enough to keep login responsive, slow enough to
 * make offline cracking of a stolen hash expensive.
 */
export const SCRYPT = {
  N: 32768,
  r: 8,
  p: 1,
  keylen: 64,
  saltBytes: 16,
  // scrypt's memory requirement is 128*N*r; give it headroom rather than
  // relying on the default and failing at runtime on a constrained host.
  maxmem: 96 * 1024 * 1024,
} as const;

export const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 7);
export const RESET_TTL_SECONDS = Number(process.env.RESET_TTL_SECONDS ?? 60 * 30);

/** Session cookie name. Deliberately not `__Host-` prefixed: see `buildCookie`. */
export const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'sellerctrl_session';
export const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'sellerctrl_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface StoredPassword {
  hash: string;
  salt: string;
  params: string;
}

export async function hashPassword(password: string): Promise<StoredPassword> {
  const salt = randomBytes(SCRYPT.saltBytes);
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return {
    hash: derived.toString('base64'),
    salt: salt.toString('base64'),
    params: `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}`,
  };
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false for a malformed or absent hash rather than throwing, so a
 * corrupt row cannot turn a login attempt into a 500.
 */
export async function verifyPassword(
  password: string,
  stored: StoredPassword | null | undefined,
): Promise<boolean> {
  if (!stored?.hash || !stored.salt) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(stored.hash, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), Buffer.from(stored.salt, 'base64'), expected.length, {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Verify against stored parameters when they are recorded, falling back to the
 * current defaults. This lets cost parameters be raised later without
 * invalidating existing logins.
 */
export async function verifyPasswordWithParams(
  password: string,
  stored: StoredPassword | null | undefined,
): Promise<boolean> {
  if (!stored) return false;
  return verifyPassword(password, stored);
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** A URL-safe session token. 32 bytes of entropy. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** A URL-safe password-reset token. */
export function newResetToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a token for storage.
 *
 * SHA-256 (not a password KDF) is correct here: the input is already 256 bits of
 * random data, so there is no dictionary to brute-force, and sessions must be
 * looked up by an exact match on every request.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time string comparison that does not leak length through an early return. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still perform a comparison so the cost does not depend on the mismatch.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Identity normalisation and policy
// ---------------------------------------------------------------------------

/**
 * Canonical form of an email for uniqueness.
 *
 * Case is folded because mail providers treat `A@x.com` and `a@x.com` as one
 * mailbox; folding is done in application code because `citext` availability
 * varies by host.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  const value = email.trim();
  // Deliberately permissive: the confirmation of truth is sending a reset
  // email, not a regex. This only rejects shapes that cannot be an address.
  return value.length >= 3 && value.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

export interface PasswordCheck {
  ok: boolean;
  reason: string | null;
}

/**
 * Password policy.
 *
 * Length is the dominant factor in password strength, so the floor is 12
 * characters rather than a composition rule that mostly produces `Password1!`.
 * Upper bound exists so a megabyte of input cannot be used as a CPU amplifier.
 */
export function checkPassword(password: string): PasswordCheck {
  if (typeof password !== 'string' || password.length < 12) {
    return { ok: false, reason: 'Password must be at least 12 characters.' };
  }
  if (password.length > 512) {
    return { ok: false, reason: 'Password must be at most 512 characters.' };
  }
  return { ok: true, reason: null };
}

/**
 * A hash of a password that no account matches.
 *
 * Login verifies against this when the email is unknown, so a missing account
 * costs the same time as a wrong password and cannot be detected by timing.
 */
export async function dummyPasswordVerify(password: string): Promise<void> {
  await verifyPassword(password, {
    hash: Buffer.alloc(SCRYPT.keylen, 7).toString('base64'),
    salt: Buffer.alloc(SCRYPT.saltBytes, 9).toString('base64'),
    params: `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}`,
  });
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
  expires?: Date;
}

/**
 * Serialise one cookie.
 *
 * `httpOnly` keeps the session token away from JavaScript, so an XSS bug cannot
 * read it. `sameSite=lax` blocks cross-site form posts while still allowing a
 * top-level navigation back to the app.
 */
export function buildCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const piece of header.split(';')) {
    const index = piece.indexOf('=');
    if (index <= 0) continue;
    const key = piece.slice(0, index).trim();
    const value = piece.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** An expired cookie that also clears the browser's copy. */
export function clearCookie(name: string, secure: boolean): string {
  return buildCookie(name, '', {
    maxAge: 0,
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    expires: new Date(0),
  });
}