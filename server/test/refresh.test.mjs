// The one non-read call (trpc token renewal), TRPC_TOKEN_EXPIRED, and whoami trpc_token. Stubbed fetch, temp dir.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-refresh-'));
process.env.ZAPIER_FACTORY_DIR = tmp;
const lib = await import('../lib.mjs');
const { callTool } = await import('../tools.mjs');
const { assertReadOnly, JWT_REFRESH_PATH } = lib;

const REFRESH = 'https://zapier.com/api/v4/jwt/refresh';
const rejects = (fn) => assert.throws(fn, (e) => e.code === 'READ_ONLY_VIOLATION');

test('guard: the exact token renewal call passes (POST, exact path, no query, no body)', () => {
  assert.equal(JWT_REFRESH_PATH, '/api/v4/jwt/refresh');
  assert.equal(assertReadOnly('POST', REFRESH), true);
  assert.equal(assertReadOnly('POST', REFRESH, undefined), true);
  assert.equal(assertReadOnly('post', '/api/v4/jwt/refresh', null), true);
});
test('guard: every variant of the renewal call is refused', () => {
  rejects(() => assertReadOnly('POST', REFRESH + '?x=1'));
  rejects(() => assertReadOnly('POST', REFRESH + '?'));
  rejects(() => assertReadOnly('POST', REFRESH + '#x'));
  rejects(() => assertReadOnly('POST', REFRESH + '/'));
  rejects(() => assertReadOnly('POST', REFRESH + '/x'));
  rejects(() => assertReadOnly('POST', 'https://zapier.com/api/v4/jwt/refreshx'));
  rejects(() => assertReadOnly('POST', 'https://zapier.com/api/v4/jwt/'));
  rejects(() => assertReadOnly('POST', 'https://zapier.com/api/v4/jwt/revoke'));
  rejects(() => assertReadOnly('POST', 'https://zapier.com/api/v4/jwt/obtain'));
  rejects(() => assertReadOnly('POST', 'https://zapier.com/API/v4/jwt/refresh'));
  rejects(() => assertReadOnly('POST', 'https://zapier.com/api/v4/jwt/%72efresh'));
  rejects(() => assertReadOnly('POST', 'https://hooks.zapier.com/api/v4/jwt/refresh'));
  rejects(() => assertReadOnly('POST', 'https://evil.example/api/v4/jwt/refresh'));
  rejects(() => assertReadOnly('POST', 'http://zapier.com/api/v4/jwt/refresh'));
  // r4 M-3: only the exact text passes, not a form that normalises onto it.
  rejects(() => assertReadOnly('POST', 'https://zapier.com/api/v4/jwt/x/../refresh'));
  rejects(() => assertReadOnly('POST', 'https://zapier.com/api/v4/jwt/%2e%2e/jwt/refresh'));
  rejects(() => assertReadOnly('POST', '/api/v4/jwt/./refresh'));
  rejects(() => assertReadOnly('POST', 'https://zapier.com:443/api/v4/jwt/refresh'));
  rejects(() => assertReadOnly('POST', 'https://ZAPIER.com/api/v4/jwt/refresh'));
  rejects(() => assertReadOnly('POST', '//zapier.com/api/v4/jwt/refresh'));
  rejects(() => assertReadOnly('POST', REFRESH, '{}'));
  rejects(() => assertReadOnly('POST', REFRESH, 'x'));
  rejects(() => assertReadOnly('POST', REFRESH, ''));
  for (const m of ['PUT', 'PATCH', 'DELETE']) rejects(() => assertReadOnly(m, REFRESH));
  // other POSTs stay blocked
  rejects(() => assertReadOnly('POST', 'https://zapier.com/api/v4/session'));
  rejects(() => assertReadOnly('POST', 'https://zapier.com/api/asset-management-bff/trpc/folder.folderTree'));
});

// ---- renewal flow with a stubbed fetch ----
const writeSession = () => {
  const d = path.join(tmp, 'logins', 'agency');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'session.json'), JSON.stringify({ cookies: [
    { name: 'sessionid', value: 'x', domain: '.zapier.com', path: '/', expires: -1 },
    { name: 'csrftoken', value: 'csrf-test', domain: 'zapier.com', path: '/', expires: -1 },
    { name: 'tokenjwt', value: 'old', domain: '.zapier.com', path: '/', expires: -1 },
  ] }));
};
fs.writeFileSync(path.join(tmp, 'clients.json'), JSON.stringify({ logins: { agency: { email: 'owner@agency.example', accountId: '900000001' } }, clients: {} }));
let calls, jwtOk, refreshStatus;
const realFetch = globalThis.fetch;
beforeEach(() => {
  lib._resetRenewalCache();
  writeSession();
  calls = []; jwtOk = false; refreshStatus = 200;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname, headers: init.headers, body: init.body, cookie: init.headers?.cookie });
    const json = (b, status = 200, extra = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...extra } });
    if (u.pathname === '/api/v4/session') return json({ is_logged_in: true, email: 'owner@agency.example', id: 5, current_account_id: 900000001 });
    if (u.pathname === '/api/v4/jwt/refresh') {
      if (refreshStatus !== 200) return new Response('', { status: refreshStatus });
      jwtOk = true;
      return new Response('', { status: 200, headers: { 'set-cookie': 'tokenjwt=new; Domain=.zapier.com; Path=/; Max-Age=900; Secure; HttpOnly' } });
    }
    if (u.pathname === '/api/bridge/session-cookie-status') return jwtOk ? json({ ok: true }) : json({ detail: 'x' }, 401);
    if (u.pathname.startsWith('/api/asset-management-bff/trpc/')) {
      const hasNew = /tokenjwt=new/.test(init.headers.cookie);
      return jwtOk && hasNew ? json({ result: { data: { json: { tree: [] } } } }) : json({ error: 'unauthorized' }, 401);
    }
    return json({});
  };
});
process.on('exit', () => { globalThis.fetch = realFetch; });

test('trpc 401 -> one renewal (exact app request: no body, X-CSRFToken) -> retry succeeds; renewed cookie persisted', async () => {
  const r = await callTool('list_folders', { login: 'agency' });
  assert.deepEqual(r.tree, []);
  const ref = calls.filter((c) => c.path === '/api/v4/jwt/refresh');
  assert.equal(ref.length, 1);
  assert.equal(ref[0].method, 'POST');
  assert.equal(ref[0].body, undefined);
  assert.equal(ref[0].headers['x-csrftoken'], 'csrf-test');
  assert.ok(!('content-type' in ref[0].headers));
  assert.equal(calls.filter((c) => c.path.includes('/trpc/')).length, 2);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'logins', 'agency', 'session.json'), 'utf8'));
  assert.equal(saved.cookies.find((c) => c.name === 'tokenjwt').value, 'new');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^renewed at \d{4}-\d\d-\d\dT[\d:.]+Z$/);
});
test('renewal refused -> TRPC_TOKEN_EXPIRED naming the tools that still work and node login.mjs', async () => {
  refreshStatus = 401;
  await assert.rejects(callTool('list_folders', { login: 'agency' }), (e) => e.code === 'TRPC_TOKEN_EXPIRED'
    && /search_runs/.test(e.message) && /get_run/.test(e.message) && /node login\.mjs agency/.test(e.message));
  assert.equal(calls.filter((c) => c.path === '/api/v4/jwt/refresh').length, 1);
  assert.equal(calls.filter((c) => c.path.includes('/trpc/')).length, 1, 'no retry after a failed renewal');
});
test('429 from the renewal counts as success (as in the app), then the retry decides', async () => {
  refreshStatus = 429;
  await assert.rejects(callTool('list_folders', { login: 'agency' }), (e) => e.code === 'TRPC_TOKEN_EXPIRED');
  assert.equal(calls.filter((c) => c.path.includes('/trpc/')).length, 2);
});
test('whoami reports trpc_token: valid after renewing an expired token, expired when renewal fails', async () => {
  const w = await callTool('zapier_whoami', { login: 'agency' });
  assert.equal(w.trpc_token, 'valid');
  assert.ok(w.warnings.some((x) => /^renewed at /.test(x)));
  writeSession(); jwtOk = false; refreshStatus = 401; lib._resetRenewalCache();
  const x = await callTool('zapier_whoami', { login: 'agency' });
  assert.equal(x.trpc_token, 'expired');
  assert.match(x.trpc_note, /node login\.mjs agency/);
});
test('whoami with a valid token makes no renewal call', async () => {
  jwtOk = true;
  const w = await callTool('zapier_whoami', { login: 'agency' });
  assert.equal(w.trpc_token, 'valid');
  assert.equal(calls.filter((c) => c.path === '/api/v4/jwt/refresh').length, 0);
  assert.ok(!w.warnings);
});

test('a refused renewal is not retried within 30 s (no POST loop across calls)', async () => {
  refreshStatus = 401;
  await assert.rejects(callTool('list_folders', { login: 'agency' }), (e) => e.code === 'TRPC_TOKEN_EXPIRED');
  await assert.rejects(callTool('list_tables', { login: 'agency' }), (e) => e.code === 'TRPC_TOKEN_EXPIRED');
  assert.equal(calls.filter((c) => c.path === '/api/v4/jwt/refresh').length, 1);
});
