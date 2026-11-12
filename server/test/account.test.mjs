// Explicit account id from the registry + session/registry identity check. Stubbed fetch, temp dir, no network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-acct-'));
process.env.ZAPIER_FACTORY_DIR = tmp;
process.env.ZAPIER_ACCOUNT_ID = '999'; // must be ignored now
const lib = await import('../lib.mjs');
const { callTool } = await import('../tools.mjs');
const { loadRegistry } = await import('../registry.mjs');

const writeReg = (logins) => fs.writeFileSync(path.join(tmp, 'clients.json'), JSON.stringify({ logins, clients: {} }));
const writeSession = (login) => {
  const d = path.join(tmp, 'logins', login);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'session.json'), JSON.stringify({ cookies: [{ name: 'sessionid', value: 'x', domain: '.zapier.com', path: '/', expires: -1 }] }));
};
let sess, urls;
const realFetch = globalThis.fetch;
beforeEach(() => {
  urls = [];
  sess = { is_logged_in: true, email: 'owner@agency.example', id: 5, current_account_id: 10000001 };
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const body = String(url).includes('/api/v4/session') ? sess : { results: [], count: 0 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  writeReg({ agency: { email: 'owner@agency.example', accountId: '10000001' } });
  writeSession('agency');
});
process.on('exit', () => { globalThis.fetch = realFetch; });

test('accountId comes from the registry, ignoring ZAPIER_ACCOUNT_ID and the session', async () => {
  sess.current_account_id = 1;
  assert.equal(await lib.accountId('agency'), '10000001');
  assert.equal(urls.length, 0);
});
test('accountId errors for unknown login or null/empty accountId', async () => {
  await assert.rejects(lib.accountId('nope'), /nope/);
  writeReg({ agency: { email: 'a@b.c', accountId: null } });
  await assert.rejects(lib.accountId('agency'), /login\.mjs agency/);
});
test('registry rejects empty-string accountId', () => {
  writeReg({ agency: { email: 'a@b.c', accountId: '' } });
  assert.throws(() => loadRegistry(), /accountId/);
});
test('whoami match true when email (case-insensitive) and account agree', async () => {
  sess.email = 'owner@agency.example';
  assert.deepEqual(await lib.whoami('agency'), { email: 'owner@agency.example', sessionAccountId: '10000001', registryAccountId: '10000001', match: true });
});
test('whoami match false on email or account mismatch', async () => {
  sess.email = 'other@x.com';
  assert.equal((await lib.whoami('agency')).match, false);
  sess.email = 'owner@agency.example'; sess.current_account_id = 42;
  const w = await lib.whoami('agency');
  assert.equal(w.match, false); assert.equal(w.sessionAccountId, '42');
});
test('tools refuse to run on mismatch, naming both emails, and make no data request', async () => {
  sess.email = 'other@x.com';
  await assert.rejects(callTool('list_zaps', { login: 'agency' }), (e) => e.code === 'ACCOUNT_MISMATCH' && /other@x\.com/.test(e.message) && /owner@agency.example/.test(e.message));
  assert.ok(urls.every((u) => u.includes('/api/v4/session')));
});
test('zapier_whoami tool returns the mismatch instead of throwing', async () => {
  sess.email = 'other@x.com';
  const r = await callTool('zapier_whoami', { login: 'agency' });
  assert.equal(r.match, false);
  assert.equal(r.registry_email, 'owner@agency.example');
});
test('verification is cached per session file and redone when session.json changes', async () => {
  await callTool('list_zaps', { login: 'agency' });
  await callTool('list_zaps', { login: 'agency' });
  assert.equal(urls.filter((u) => u.includes('/api/v4/session')).length, 1);
  sess.email = 'other@x.com';
  await callTool('list_zaps', { login: 'agency' }); // cached, still ok
  const f = path.join(tmp, 'logins', 'agency', 'session.json');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + ' ');
  const future = new Date(Date.now() + 5000); fs.utimesSync(f, future, future);
  await assert.rejects(callTool('list_zaps', { login: 'agency' }), /ACCOUNT_MISMATCH/);
});

test('cached account check is re-verified once it is older than 60 s', async () => {
  const f = path.join(tmp, 'logins', 'agency', 'session.json');
  const future = new Date(Date.now() + 60000); fs.utimesSync(f, future, future); // fresh load, empty cache
  await callTool('list_zaps', { login: 'agency' });
  sess.email = 'other@x.com';
  await callTool('list_zaps', { login: 'agency' }); // within 60 s: cached
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    await assert.rejects(callTool('list_zaps', { login: 'agency' }), /ACCOUNT_MISMATCH/);
  } finally { Date.now = realNow; }
  assert.equal(urls.filter((u) => u.includes('/api/v4/session')).length, 2);
});
