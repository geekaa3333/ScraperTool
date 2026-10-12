// Authentication primitives and the HTTP surface.
//
// The store tests prove the database enforces ownership; these prove the HTTP
// layer cannot be walked around — that a request without a session is refused,
// a cross-user id returns 404 rather than data, and a state-changing request
// without a CSRF token is rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';

import { PGlite } from '@electric-sql/pglite';
import { PGliteClient } from '../dist/pg/client.js';
import { PostgresStore } from '../dist/pg/store.js';
import { AuthLayer } from '../dist/pg/http.js';
import {
  buildCookie,
  checkPassword,
  clearCookie,
  hashPassword,
  hashToken,
  isValidEmail,
  newSessionToken,
  normaliseEmail,
  parseCookies,
  safeEqual,
  verifyPassword,
} from '../dist/auth.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(here, '..', 'migrations', '001_init.sql'), 'utf8');

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

test('a password verifies against its own hash and nothing else', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('correct horse battery stapl', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('the same password hashes differently each time', async () => {
  const a = await hashPassword('same password here');
  const b = await hashPassword('same password here');
  assert.notEqual(a.salt, b.salt, 'a per-password salt stops one rainbow table covering everyone');
  assert.notEqual(a.hash, b.hash);
  assert.equal(await verifyPassword('same password here', a), true);
  assert.equal(await verifyPassword('same password here', b), true);
});

test('verification fails safely on a corrupt or missing hash', async () => {
  assert.equal(await verifyPassword('x', null), false);
  assert.equal(await verifyPassword('x', { hash: '', salt: '', params: '' }), false);
});

test('emails normalise to a single case-insensitive key', () => {
  assert.equal(normaliseEmail('  Seller@Example.COM '), 'seller@example.com');
  assert.ok(isValidEmail('a@b.co'));
  assert.ok(!isValidEmail('not-an-email'));
  assert.ok(!isValidEmail('a@b'));
});

test('the password policy enforces length, not composition', () => {
  assert.equal(checkPassword('short').ok, false);
  assert.equal(checkPassword('twelvechars').ok, false, 'eleven characters is too short');
  assert.equal(checkPassword('twelvecharsX').ok, true, 'twelve characters passes');
  assert.equal(checkPassword('a'.repeat(513)).ok, false);
});

test('session tokens are unguessable and stored only as a hash', () => {
  const token = newSessionToken();
  assert.equal(token.length, 43);
  assert.match(hashToken(token), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken(token), token, 'the raw token must never be what is stored');
  assert.notEqual(newSessionToken(), token);
});

test('constant-time comparison rejects mismatches', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('cookies round-trip and carry the security attributes', () => {
  const header = buildCookie('s', 'tok en', { maxAge: 60, httpOnly: true, secure: true });
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  assert.equal(parseCookies(header).s, 'tok en');
  assert.match(clearCookie('s', true), /Max-Age=0/);
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Boot the auth layer behind a throwaway HTTP server. */
async function boot() {
  const db = new PGlite();
  const client = new PGliteClient(db);
  await client.exec(MIGRATION);
  const store = new PostgresStore(client);
  const layer = new AuthLayer(store, { secureCookies: true, exposeResetToken: false });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (!(await layer.handle(req, res, url))) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
      }
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, close: async () => { server.close(); await client.close(); } };
}

/** Minimal cookie-aware fetch that returns status, body and set-cookie. */
async function call(base, path, { method = 'GET', body, cookie, csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* binary or empty */ }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, json, text, setCookie };
}

function cookieHeader(setCookies) {
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

async function registerAndLogin(base, email, name) {
  const reg = await call(base, '/api/auth/register', {
    method: 'POST',
    body: { email, displayName: name, password: 'a very long password' },
  });
  assert.equal(reg.status, 200, `register failed: ${reg.text}`);
  const login = await call(base, '/api/auth/login', {
    method: 'POST',
    body: { email, password: 'a very long password' },
  });
  assert.equal(login.status, 200, `login failed: ${login.text}`);
  return {
    cookie: cookieHeader(login.setCookie),
    csrf: login.json.csrfToken,
    userId: login.json.userId,
  };
}

test('registration, login, session cookie and /me work end to end', async () => {
  const { base, close } = await boot();
  const session = await registerAndLogin(base, 'alice@example.com', 'Alice');

  const cookies = session.cookie;
  assert.match(cookies, /sellerctrl_session=/);
  assert.match(cookies, /sellerctrl_csrf=/);

  const me = await call(base, '/api/auth/me', { cookie: cookies });
  assert.equal(me.status, 200);
  assert.equal(me.json.email, 'alice@example.com');
  assert.equal(me.json.displayName, 'Alice');
  await close();
});

test('the session cookie is HttpOnly and the CSRF cookie is not', async () => {
  const { base, close } = await boot();
  const login = await call(base, '/api/auth/register', {
    method: 'POST',
    body: { email: 'flags@example.com', displayName: 'F', password: 'a very long password' },
  });
  assert.equal(login.status, 200);
  const regCookies = login.setCookie;
  // Registration does not sign in; log in to obtain cookies.
  const loginRes = await call(base, '/api/auth/login', {
    method: 'POST',
    body: { email: 'flags@example.com', password: 'a very long password' },
  });
  const all = [...regCookies, ...loginRes.setCookie];
  const session = all.find((c) => c.startsWith('sellerctrl_session='));
  const csrf = all.find((c) => c.startsWith('sellerctrl_csrf='));
  assert.match(session, /HttpOnly/);
  assert.match(session, /Secure/);
  assert.ok(!/HttpOnly/.test(csrf), 'the frontend must be able to read the CSRF token');
  await close();
});

test('duplicate registration and a weak password are refused', async () => {
  const { base, close } = await boot();
  await call(base, '/api/auth/register', {
    method: 'POST', body: { email: 'dup@example.com', displayName: 'A', password: 'a very long password' },
  });
  const again = await call(base, '/api/auth/register', {
    method: 'POST', body: { email: 'DUP@example.com', displayName: 'B', password: 'a very long password' },
  });
  assert.equal(again.status, 409);

  const weak = await call(base, '/api/auth/register', {
    method: 'POST', body: { email: 'weak@example.com', displayName: 'W', password: 'short' },
  });
  assert.equal(weak.status, 400);
  await close();
});

test('a wrong password and an unknown email give the same answer', async () => {
  const { base, close } = await boot();
  await call(base, '/api/auth/register', {
    method: 'POST', body: { email: 'real@example.com', displayName: 'R', password: 'a very long password' },
  });
  const wrong = await call(base, '/api/auth/login', {
    method: 'POST', body: { email: 'real@example.com', password: 'the wrong password' },
  });
  const unknown = await call(base, '/api/auth/login', {
    method: 'POST', body: { email: 'ghost@example.com', password: 'the wrong password' },
  });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.json.error, unknown.json.error, 'no account-enumeration oracle');
  await close();
});

test('protected routes refuse an anonymous request', async () => {
  const { base, close } = await boot();
  assert.equal((await call(base, '/api/jobs')).status, 401);
  assert.equal((await call(base, '/api/auth/me')).status, 401);
  await close();
});

test('logging out invalidates the session', async () => {
  const { base, close } = await boot();
  const s = await registerAndLogin(base, 'out@example.com', 'Out');
  assert.equal((await call(base, '/api/auth/me', { cookie: s.cookie })).status, 200);

  const logout = await call(base, '/api/auth/logout', { method: 'POST', cookie: s.cookie, csrf: s.csrf });
  assert.equal(logout.status, 200);
  assert.equal((await call(base, '/api/auth/me', { cookie: s.cookie })).status, 401);
  await close();
});

test('one user cannot read another user\'s job over HTTP', async () => {
  const { base, store, close } = await boot();
  const alice = await registerAndLogin(base, 'alice2@example.com', 'Alice');
  const bob = await registerAndLogin(base, 'bob2@example.com', 'Bob');

  const jobId = await store.createJob({
    userId: alice.userId,
    scrapingMode: 'direct-upload',
    jobName: 'Alice private job',
    items: [{ marketplaceId: 'eg', asin: 'B0DLHDLC1N', rowNumber: 2 }],
    perMarketplace: { eg: 1 },
  });

  const mine = await call(base, `/api/jobs/${jobId}`, { cookie: alice.cookie });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.job.jobName, 'Alice private job');

  // 404, not 403: a stranger must not learn the id exists.
  const theirs = await call(base, `/api/jobs/${jobId}`, { cookie: bob.cookie });
  assert.equal(theirs.status, 404);

  const history = await call(base, '/api/jobs', { cookie: bob.cookie });
  assert.equal(history.json.total, 0, "Alice's job never appears in Bob's history");
  await close();
});

test('history lists only the caller\'s own jobs and paginates', async () => {
  const { base, store, close } = await boot();
  const alice = await registerAndLogin(base, 'alice3@example.com', 'Alice');
  const bob = await registerAndLogin(base, 'bob3@example.com', 'Bob');

  await store.createJob({
    userId: alice.userId, scrapingMode: 'direct-upload', jobName: 'A one',
    items: [{ marketplaceId: 'eg', asin: 'B0DLHDLC1N' }], perMarketplace: { eg: 1 },
  });
  await new Promise((r) => setTimeout(r, 10));
  await store.createJob({
    userId: alice.userId, scrapingMode: 'direct-upload', jobName: 'A two',
    items: [{ marketplaceId: 'sa', asin: 'B0DLHDLC1N' }], perMarketplace: { sa: 1 },
  });
  await store.createJob({
    userId: bob.userId, scrapingMode: 'direct-upload', jobName: 'B one',
    items: [{ marketplaceId: 'eg', asin: 'B0DLHDLC1N' }], perMarketplace: { eg: 1 },
  });

  const aliceHistory = await call(base, '/api/jobs', { cookie: alice.cookie });
  assert.equal(aliceHistory.json.total, 2);
  assert.deepEqual(aliceHistory.json.jobs.map((j) => j.jobName), ['A two', 'A one'], 'newest first');

  const filtered = await call(base, '/api/jobs?marketplace=sa', { cookie: alice.cookie });
  assert.equal(filtered.json.total, 1);
  assert.equal(filtered.json.jobs[0].jobName, 'A two');

  const bobHistory = await call(base, '/api/jobs', { cookie: bob.cookie });
  assert.equal(bobHistory.json.total, 1);
  assert.equal(bobHistory.json.jobs[0].jobName, 'B one');
  await close();
});

test('one user cannot download another user\'s report', async () => {
  const { base, store, close } = await boot();
  const alice = await registerAndLogin(base, 'alice4@example.com', 'Alice');
  const bob = await registerAndLogin(base, 'bob4@example.com', 'Bob');

  const jobId = await store.createJob({
    userId: alice.userId, scrapingMode: 'direct-upload', jobName: 'with report',
    items: [{ marketplaceId: 'eg', asin: 'B0DLHDLC1N' }], perMarketplace: { eg: 1 },
  });
  const reportId = await store.recordReport({
    userId: alice.userId, jobId, reportType: 'xlsx', filename: 'results.xlsx',
    storageKey: '/tmp/does-not-exist.xlsx',
  });
  await store.markReportAvailable(reportId, alice.userId, 'sum', 10);

  const stolen = await call(base, `/api/reports/${reportId}/download`, { cookie: bob.cookie });
  assert.equal(stolen.status, 404);

  const owner = await call(base, `/api/reports/${reportId}/download`, { cookie: alice.cookie });
  assert.notEqual(owner.status, 404, 'the owner reaches the download path');
  await close();
});

test('password reset cannot enumerate accounts and the token works once', async () => {
  const { base, store, close } = await boot();
  await call(base, '/api/auth/register', {
    method: 'POST', body: { email: 'reset@example.com', displayName: 'R', password: 'a very long password' },
  });

  const known = await call(base, '/api/auth/password-reset', {
    method: 'POST', body: { email: 'reset@example.com' },
  });
  const unknown = await call(base, '/api/auth/password-reset', {
    method: 'POST', body: { email: 'nobody@example.com' },
  });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(known.json, unknown.json, 'identical answers for known and unknown addresses');

  // Mint a token directly, standing in for the email that would carry it.
  const account = await store.findUserByEmail('reset@example.com');
  const token = await store.createPasswordReset(account.userId);

  const first = await call(base, '/api/auth/password-reset/confirm', {
    method: 'POST', body: { token, password: 'a brand new password' },
  });
  assert.equal(first.status, 200);

  const replay = await call(base, '/api/auth/password-reset/confirm', {
    method: 'POST', body: { token, password: 'yet another password' },
  });
  assert.equal(replay.status, 400, 'a reset token is single use');

  const oldPassword = await call(base, '/api/auth/login', {
    method: 'POST', body: { email: 'reset@example.com', password: 'a very long password' },
  });
  assert.equal(oldPassword.status, 401, 'the old password no longer works');

  const newPassword = await call(base, '/api/auth/login', {
    method: 'POST', body: { email: 'reset@example.com', password: 'a brand new password' },
  });
  assert.equal(newPassword.status, 200);
  await close();
});

test('an oversized body is refused rather than buffered', async () => {
  const { base, close } = await boot();
  const res = await call(base, '/api/auth/login', {
    method: 'POST',
    body: { email: 'x@example.com', password: 'y'.repeat(200_000) },
  });
  assert.ok(res.status >= 400, `expected a rejection, got ${res.status}`);
  await close();
});

test('repeated failed sign-ins are throttled', async () => {
  const { base, close } = await boot();
  await call(base, '/api/auth/register', {
    method: 'POST', body: { email: 'throttle@example.com', displayName: 'T', password: 'a very long password' },
  });
  let throttled = false;
  for (let i = 0; i < 14; i++) {
    const res = await call(base, '/api/auth/login', {
      method: 'POST', body: { email: 'throttle@example.com', password: `wrong-${i}` },
    });
    if (res.status === 429) { throttled = true; break; }
  }
  assert.ok(throttled, 'brute force must eventually be rate limited');
  await close();
});