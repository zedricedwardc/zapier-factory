import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-'));
process.env.ZAPIER_FACTORY_DIR = tmp;
fs.mkdirSync(path.join(tmp, 'logins', 'agency'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'logins', 'agency', 'session.json'), JSON.stringify({ cookies: [{ name: 'sessionid', value: 'AgencyCOOKIE', domain: '.zapier.com', path: '/', expires: -1 }] }));
const { loginDir, session, FACTORY_DIR } = await import('../lib.mjs');

test('loginDir builds logins/<login> and rejects bad names', () => {
  assert.equal(FACTORY_DIR, tmp);
  assert.ok(loginDir('agency').endsWith(path.join('logins', 'agency')));
  assert.throws(() => loginDir('../x'));
  assert.throws(() => loginDir('Bad'));
});
test('session(client-b) without a session file says SESSION_EXPIRED + login name + command', async () => {
  await assert.rejects(session('client-b'), (e) => /SESSION_EXPIRED.*client-b.*node login\.mjs client-b/.test(e.message));
});
test('session(agency) sends the agency cookie jar', async () => {
  const orig = globalThis.fetch; let seen;
  globalThis.fetch = async (url, opts) => { seen = opts.headers.cookie; return new Response('{"is_logged_in":true}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  try { const s = await session('agency'); assert.equal(s.is_logged_in, true); assert.match(seen, /sessionid=AgencyCOOKIE/); }
  finally { globalThis.fetch = orig; }
});
