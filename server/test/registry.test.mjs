import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-reg-'));
process.env.ZAPIER_FACTORY_DIR = tmp;
const { loadRegistry, resolveTarget } = await import('../registry.mjs');

const good = {
  logins: { agency: { email: 'owner@agency.example', accountId: '10000001' }, 'client-b': { email: 'support@client-b.example', accountId: null } },
  clients: {
    'client-a': { login: 'agency', folderIds: ['f1'], namePrefixes: ['Client A'], ghl: { server: 'uxie-ghl-internal-mcp', locationIds: [] } },
    'client-b-2': { login: 'client-b', folderIds: [], namePrefixes: [], ghl: { server: 'x', locationIds: [] } },
  },
};
const write = (obj) => fs.writeFileSync(path.join(tmp, 'clients.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
const clean = () => fs.rmSync(path.join(tmp, 'clients.json'), { force: true });

test('missing file gives empty registry', () => {
  clean();
  assert.deepEqual(loadRegistry(), { logins: {}, clients: {} });
});

test('explicit client resolves login and accountId', () => {
  write(good);
  const t = resolveTarget({ client: 'client-a' }, tmp);
  assert.equal(t.login, 'agency');
  assert.equal(t.accountId, '10000001');
  assert.equal(t.email, 'owner@agency.example');
  assert.equal(t.client, 'client-a');
  assert.deepEqual(t.folderIds, ['f1']);
  assert.deepEqual(t.namePrefixes, ['Client A']);
  assert.equal(t.ghl.server, 'uxie-ghl-internal-mcp');
});

test('explicit login resolves with client null', () => {
  write(good);
  const t = resolveTarget({ login: 'agency' }, tmp);
  assert.equal(t.client, null);
  assert.equal(t.accountId, '10000001');
  assert.deepEqual(t.folderIds, []);
});

test('client + a different login -> error; client + its own login is fine', () => {
  write(good);
  assert.throws(() => resolveTarget({ client: 'client-a', login: 'client-b' }, tmp), /client-a.*agency.*client-b|login "client-b"/);
  assert.equal(resolveTarget({ client: 'client-a', login: 'agency' }, tmp).login, 'agency');
});

test('.zapier-client in a parent dir resolves (whitespace trimmed)', () => {
  write(good);
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-proj-'));
  fs.writeFileSync(path.join(proj, '.zapier-client'), '  client-a \r\n');
  const deep = path.join(proj, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(resolveTarget({}, deep).client, 'client-a');
});

test('no client anywhere -> error listing known clients and logins', () => {
  write(good);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-none-'));
  assert.throws(() => resolveTarget({}, empty), (e) => /Known clients: client-a, client-b-2/.test(e.message) && /Known logins: agency, client-b/.test(e.message));
});

test('empty or whitespace-only namePrefixes / folderIds entries are rejected with the key path', () => {
  for (const [key, val] of [['namePrefixes', ''], ['namePrefixes', '   '], ['folderIds', ''], ['folderIds', ' 	']]) {
    const bad = structuredClone(good);
    bad.clients['client-a'][key] = ['ok', val];
    write(bad);
    assert.throws(() => loadRegistry(), new RegExp(String.raw`clients\.client-a\.${key}\[1\]`));
  }
});

test('unknown client error lists known clients', () => {
  write(good);
  assert.throws(() => resolveTarget({ client: 'nope' }, tmp), /client-a/);
});

test('unknown login errors', () => {
  write(good);
  assert.throws(() => resolveTarget({ login: 'zzz' }, tmp), /zzz/);
});

test('null accountId -> discovery hint', () => {
  write(good);
  assert.throws(() => resolveTarget({ client: 'client-b-2' }, tmp), /run node login\.mjs client-b to discover the account id/);
  assert.throws(() => resolveTarget({ login: 'client-b' }, tmp), /run node login\.mjs client-b to discover the account id/);
});

test('invalid JSON errors', () => {
  write('{nope');
  assert.throws(() => loadRegistry(), /clients\.json/);
});

test('schema errors name the bad key path', () => {
  const bad = structuredClone(good);
  bad.clients['client-a'].folderIds = 'x';
  write(bad);
  assert.throws(() => loadRegistry(), /clients\.client-a\.folderIds/);
  const bad2 = structuredClone(good);
  bad2.clients['client-a'].login = 'ghost';
  write(bad2);
  assert.throws(() => loadRegistry(), /clients\.client-a\.login/);
  const bad3 = structuredClone(good);
  bad3.logins.agency.email = 5;
  write(bad3);
  assert.throws(() => loadRegistry(), /logins\.agency\.email/);
  const bad4 = structuredClone(good);
  bad4.logins['Bad Name'] = { email: 'a@b.c', accountId: null };
  write(bad4);
  assert.throws(() => loadRegistry(), /logins\.Bad Name/);
  const bad5 = structuredClone(good);
  bad5.clients['Bad_Client'] = bad5.clients['client-b-2'];
  write(bad5);
  assert.throws(() => loadRegistry(), /clients\.Bad_Client/);
});
