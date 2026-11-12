// Offline tests: read-only guard, cookie rotation parsing, missing-session hint, MCP tool listing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertReadOnly, applySetCookie, buildZapRunsQuery, request } from '../lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GQL = 'https://zapier.com/api/reporting/graphql';
const q = (query) => JSON.stringify({ operationName: 'ZapRuns', query, variables: {} });
const rejects = (fn) => assert.throws(fn, (e) => e.code === 'READ_ONLY_VIOLATION');

test('guard accepts GET on zapier.com', () => {
  assert.equal(assertReadOnly('GET', 'https://zapier.com/api/v4/session'), true);
  assert.equal(assertReadOnly('get', '/api/gulliver/storage/v1/zaps/1?account_id=2'), true);
});
test('guard accepts the ZapRuns query POST', () => {
  assert.equal(assertReadOnly('POST', GQL, q(buildZapRunsQuery({ accountId: '1', limit: 10 }))), true);
  assert.equal(assertReadOnly('POST', GQL, q('  query X { a }')), true);
});
test('guard rejects PUT / DELETE / PATCH', () => {
  rejects(() => assertReadOnly('PUT', 'https://zapier.com/api/gulliver/storage/v1/zaps/1'));
  rejects(() => assertReadOnly('DELETE', 'https://zapier.com/api/gulliver/storage/v1/zaps/1'));
  rejects(() => assertReadOnly('PATCH', 'https://zapier.com/api/gulliver/storage/v1/zaps/1'));
});
test('guard rejects POST anywhere but /api/reporting/graphql', () => {
  rejects(() => assertReadOnly('POST', 'https://zapier.com/api/zap-history/v2/runs/replay', '{}'));
  rejects(() => assertReadOnly('POST', 'https://zapier.com/api/v4/jwt/refresh', '{}'));
  rejects(() => assertReadOnly('POST', 'https://zapier.com/api/reporting/graphql/x', q('query X { a }')));
});
test('guard rejects mutations, subscriptions, batches, persisted queries, non-query text', () => {
  rejects(() => assertReadOnly('POST', GQL, q('mutation Replay { replay(id: 1) }')));
  rejects(() => assertReadOnly('POST', GQL, q('query X { a } mutation Y { b }')));
  rejects(() => assertReadOnly('POST', GQL, q('subscription S { a }')));
  rejects(() => assertReadOnly('POST', GQL, q('{ a }')));
  rejects(() => assertReadOnly('POST', GQL, JSON.stringify([{ query: 'query X { a }' }])));
  rejects(() => assertReadOnly('POST', GQL, JSON.stringify({ extensions: { persistedQuery: { sha256Hash: 'x' } } })));
  rejects(() => assertReadOnly('POST', GQL, JSON.stringify({ query: 'query X { a }', extensions: { persistedQuery: { sha256Hash: 'x' } } })));
  rejects(() => assertReadOnly('POST', GQL, 'not json'));
});
test('guard rejects other hosts', () => {
  rejects(() => assertReadOnly('GET', 'https://evil.example.com/api/v4/session'));
  rejects(() => assertReadOnly('GET', 'http://zapier.com/api/v4/session'));
  rejects(() => assertReadOnly('GET', 'https://hooks.zapier.com/hooks/catch/1/x'));
});
test('guard blocks account switching for every method, including GET', () => {
  for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
    rejects(() => assertReadOnly(m, 'https://zapier.com/api/v4/accounts/1/switch'));
    rejects(() => assertReadOnly(m, 'https://zapier.com/api/v4/session/switch/'));
    rejects(() => assertReadOnly(m, 'https://zapier.com/api/v4/current_account'));
    rejects(() => assertReadOnly(m, 'https://zapier.com/api/v4/accounts/10000001/activate'));
    rejects(() => assertReadOnly(m, 'https://zapier.com/api/v4/accounts/10000001/activate/'));
    rejects(() => assertReadOnly(m, 'https://zapier.com/api/v4/accounts/1%2Fswitch'));
  }
  assert.equal(assertReadOnly('GET', 'https://zapier.com/api/v4/accounts/1/members'), true);
});
test('request() enforces the guard before any network or session access', async () => {
  await assert.rejects(request('agency', 'DELETE', '/api/gulliver/storage/v1/zaps/1'), (e) => e.code === 'READ_ONLY_VIOLATION');
  await assert.rejects(request('agency', 'POST', '/api/reporting/graphql', { body: { query: 'mutation M { x }' } }), (e) => e.code === 'READ_ONLY_VIOLATION');
});
test('Set-Cookie rotation updates, adds and removes cookies', () => {
  const jar = { cookies: [{ name: 'sessionid', value: 'old', domain: '.zapier.com', path: '/', expires: -1 }] };
  assert.equal(applySetCookie(jar, 'sessionid=new; Domain=.zapier.com; Path=/; HttpOnly; Secure'), true);
  assert.equal(jar.cookies[0].value, 'new');
  assert.equal(applySetCookie(jar, 'csrftoken=abc; Path=/; Max-Age=3600; SameSite=Lax'), true);
  assert.equal(jar.cookies.length, 2);
  assert.equal(applySetCookie(jar, 'csrftoken=; Path=/; Max-Age=0'), true);
  assert.equal(jar.cookies.length, 1);
});
test('cli without a session file prints SESSION_EXPIRED + login hint', () => {
  const env = { ...process.env, ZAPIER_FACTORY_DIR: path.join(os.tmpdir(), `no-such-zapier-factory-${process.pid}`) };
  const r = spawnSync(process.execPath, ['cli.mjs', 'list_zaps', '{"login":"agency","limit":1}'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SESSION_EXPIRED/);
  assert.match(r.stderr, /node login\.mjs/);
});
