// contact_runs: stubbed fetch, temp registry, no network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-contact-'));
process.env.ZAPIER_FACTORY_DIR = tmp;
const { callTool } = await import('../tools.mjs');
const { contactRuns } = await import('../contact.mjs');

const REG = {
  logins: { agency: { email: 'owner@agency.example', accountId: '1' } },
  clients: {
    'client-a': { login: 'agency', folderIds: ['10'], namePrefixes: [] },
    other: { login: 'agency', folderIds: ['30'], namePrefixes: [] },
  },
};
fs.writeFileSync(path.join(tmp, 'clients.json'), JSON.stringify(REG));
const d = path.join(tmp, 'logins', 'agency');
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'session.json'), JSON.stringify({ cookies: [{ name: 'sessionid', value: 'x', domain: '.zapier.com', path: '/', expires: -1 }] }));

const TREE = { tree: [
  { id: 10, name: 'BS', assetCount: 1, children: [] },
  { id: 30, name: 'Other', assetCount: 1, children: [] },
] };
const zapA = (n) => ({ id: `00000000-0000-c000-8000-${String(n).padStart(12, '0')}`, type: 'zap', kind: 'workflow', currentVersion: { zapId: String(n) }, searchZap: { id: n } });
const ASSETS = { 10: [zapA(1)], 30: [zapA(3)] };
const wrap = (j) => ({ result: { data: { json: j } } });
const RUNS = [
  { id: 'r3', zap: { id: '3', title: 'Other zap' }, startTime: '2026-11-03T00:00:00Z', status: 'success' },
  { id: 'r5', zap: { id: '5', title: 'Agency ops' }, startTime: '2026-11-02T00:00:00Z', status: 'error' },
  { id: 'r1', zap: { id: '1', title: 'BS intake' }, startTime: '2026-11-01T00:00:00Z', status: 'success' },
  { id: 'r2', zap: { id: '1', title: 'BS intake' }, startTime: '2026-11-04T00:00:00Z', status: 'success' },
  { id: 'r7', zap: { id: '1', title: 'BS intake' }, startTime: '2026-11-05T00:00:00Z', status: 'success' },
  { id: 'r9', zap: { id: '1', title: 'BS intake' }, startTime: '2026-11-06T00:00:00Z', status: 'success' }, // detail 500s
];
const DETAIL = {
  r1: { email: 'Jane@Acme.com' },
  r2: { email: 'xjane@acme.com' }, // partial hit, must be dropped
  r3: { email: 'jane@acme.com' },
  r5: { note: 'JANE@ACME.COM' },
  r7: { phone: '(813) 555-0123' },
};
let gqlCalls, detailCalls;
const realFetch = globalThis.fetch;
beforeEach(() => {
  gqlCalls = []; detailCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/api/v4/session')) return json({ is_logged_in: true, email: 'owner@agency.example', id: 5, current_account_id: 1 });
    if (u.includes('folder.folderTree')) return json(wrap(TREE));
    if (u.includes('asset.getHydratedFolderAssets')) {
      const input = JSON.parse(new URL(u).searchParams.get('input'));
      return json(wrap({ results: ASSETS[input.folderId] || [], meta: { count: (ASSETS[input.folderId] || []).length } }));
    }
    if (u.includes('zap.searchZaps')) return json(wrap({ count: 3, next: null, results: [{ id: 1, title: 'BS intake' }, { id: 3, title: 'Other zap' }, { id: 5, title: 'Agency ops' }] }));
    if (u.includes('/api/reporting/graphql')) {
      const v = JSON.parse(init.body).variables; gqlCalls.push(v);
      const rows = v.zapIds ? RUNS.filter((r) => v.zapIds.includes(r.zap?.id)) : RUNS;
      return json({ data: { zapRuns: { totalCount: rows.length, totalActionable: 0, edges: rows.slice(v.offset, v.offset + v.limit) } } });
    }
    const m = u.match(/\/zap-history\/v2\/runs\/([^?]+)/);
    if (m) {
      detailCalls++;
      const x = DETAIL[m[1]];
      if (!x) return json({ detail: 'x' }, 500);
      return json({ zap_id: 1, status: 'success', steps_executions: [{ input: x, output: {} }] });
    }
    return json({});
  };
});
process.on('exit', () => { globalThis.fetch = realFetch; });

const target = () => ({ login: 'agency', accountId: '1', client: 'client-a', folderIds: ['10'], namePrefixes: [] });

test('run in both searches appears once as client; sorted ascending; partial email dropped', async () => {
  const r = await contactRuns(target(), { email: 'jane@acme.com' });
  assert.equal(r.client, 'client-a');
  assert.deepEqual(r.runs.map((x) => x.runId), ['r1', 'r5', 'r3']);
  assert.equal(r.runs[0].ownership, 'client');
  assert.equal(r.runs[0].zapTitle, 'BS intake');
  assert.equal(r.runs[0].startTime, '2026-11-01T00:00:00Z');
  assert.ok(!r.runs.some((x) => x.runId === 'r2'));
  assert.equal(gqlCalls[0].query, 'jane@acme.com');
  assert.deepEqual(gqlCalls[0].zapIds, ['1']);
  assert.equal(gqlCalls[1].zapIds, undefined);
});

test('other-client Zap is other-client; login-wide ops Zap labelled agency-wide', async () => {
  const r = await contactRuns(target(), { email: 'jane@acme.com' });
  const by = Object.fromEntries(r.runs.map((x) => [x.runId, x]));
  assert.equal(by.r3.ownership, 'other-client');
  assert.equal(by.r3.label, 'belongs to other — excluded from client-a conclusions');
  assert.equal(by.r5.ownership, 'login-wide');
  assert.equal(by.r5.label, "agency-wide Zap, not client-a's");
});

test('phone (813) 555-0123 matches 8135550123 by last 10 digits', async () => {
  const r = await contactRuns(target(), { phone: '8135550123' });
  assert.deepEqual(r.runs.map((x) => x.runId), ['r7']);
  assert.equal(gqlCalls[0].query, '8135550123');
});

test('exactly one of email/phone is required', async () => {
  await assert.rejects(contactRuns(target(), {}), /exactly one of email or phone/i);
  await assert.rejects(contactRuns(target(), { email: 'a@b.co', phone: '1' }), /exactly one of email or phone/i);
});

test('failed run-detail fetch is a warning, not silent', async () => {
  const r = await contactRuns(target(), { email: 'jane@acme.com' });
  assert.ok(r.warnings.some((w) => /r9/.test(w)));
});

test('detail fetches capped at 300 with a warning', async () => {
  const many = Array.from({ length: 350 }, (_, i) => ({ id: 'x' + i, zap: { id: '1', title: 't' }, startTime: '2026-11-01T00:00:00Z', status: 'success' }));
  RUNS.push(...many);
  try {
    const r = await contactRuns(target(), { email: 'jane@acme.com' });
    assert.equal(detailCalls, 300);
    assert.ok(r.warnings.some((w) => /300/.test(w)));
  } finally { RUNS.length -= 350; }
});

test('contact_runs tool requires a client', async () => {
  await assert.rejects(callTool('contact_runs', { login: 'agency', email: 'a@b.co' }), /client/i);
  const r = await callTool('contact_runs', { client: 'client-a', email: 'jane@acme.com' });
  assert.equal(r.runs.length, 3);
});

// ---- final fix wave: no false "no activity" (item 4) ----
test('contact_runs returns the window actually searched, first after warnings', async () => {
  const w = { periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-13T00:00:00.000Z' };
  const r = await contactRuns(target(), { email: 'jane@acme.com', ...w });
  assert.deepEqual(r.window, w);
  assert.deepEqual(Object.keys(r).slice(0, 2), ['warnings', 'window']);
  assert.ok(gqlCalls.every((v) => v.periodStart === w.periodStart && v.periodEnd === w.periodEnd));
  const t = await callTool('contact_runs', { client: 'client-a', email: 'jane@acme.com' });
  assert.deepEqual(Object.keys(t).slice(0, 2), ['warnings', 'window']);
  const start = Date.parse(t.window.periodStart), end = Date.parse(t.window.periodEnd);
  assert.ok(Math.abs(start - (Date.now() - 60 * 864e5)) < 60_000 && Math.abs(end - (Date.now() + 864e5)) < 60_000);
  assert.ok(!t.warnings.some((x) => /retention/.test(x)), 'default window must not warn');
});
test('periodStart older than now-60d warns about retention', async () => {
  const r = await contactRuns(target(), { email: 'jane@acme.com', periodStart: '2020-01-01T00:00:00Z' });
  assert.ok(r.warnings.some((x) => /2020-01-01/.test(x) && /before Zapier's ~60-day retention/.test(x)), JSON.stringify(r.warnings));
});
test('phone with fewer than 10 digits is rejected; phone search always carries the recall warning', async () => {
  await assert.rejects(contactRuns(target(), { phone: '555-0123' }), /10 digits/);
  const r = await contactRuns(target(), { phone: '(813) 555-0123' });
  assert.ok(r.warnings.includes("phone searched as NNNNNNNNNN, 1NNNNNNNNNN and 'NNN NNN NNNN' (covers plain, +1 and dash/space/parenthesis formats, proven live 2026-11-12); other formats (e.g. dots) unproven, so zero hits is not proof"), JSON.stringify(r.warnings));
});
test('reports how many candidate runs did not contain the exact contact', async () => {
  const r = await contactRuns(target(), { email: 'jane@acme.com' });
  assert.ok(r.warnings.some((x) => /^2 of 6 candidate runs did not contain the exact contact/.test(x)), JSON.stringify(r.warnings));
});
test('over-cap warning names the skipped window (oldest and newest skipped startTime)', async () => {
  const many = Array.from({ length: 350 }, (_, i) => ({ id: 'y' + i, zap: { id: '1', title: 't' }, startTime: new Date(Date.UTC(2026, 9, 1) + i * 60000).toISOString(), status: 'success' }));
  RUNS.push(...many);
  try {
    const r = await contactRuns(target(), { email: 'jane@acme.com' });
    const w = r.warnings.find((x) => /checked the newest 300/.test(x));
    assert.ok(w && /56/.test(w) && w.includes('2026-10-01T00:00:00.000Z') && w.includes('2026-10-01T00:55:00.000Z'), w);
  } finally { RUNS.length -= 350; }
});

// ---- loop r1 item 2: a run with no zap id is 'unknown', never login-wide ----
test('contact_runs: a run with a null/missing zap id is ownership unknown with zapId null', async () => {
  RUNS.push({ id: 'n1', zap: null, startTime: '2026-11-07T00:00:00Z', status: 'success' }, { id: 'n2', startTime: '2026-11-08T00:00:00Z', status: 'success' });
  DETAIL.n1 = { email: 'jane@acme.com' }; DETAIL.n2 = { email: 'jane@acme.com' };
  try {
    const r = await contactRuns(target(), { email: 'jane@acme.com' });
    for (const id of ['n1', 'n2']) {
      const run = r.runs.find((x) => x.runId === id);
      assert.deepEqual([run.zapId, run.ownership, run.label], [null, 'unknown', 'run has no zap_id — ownership unknown'], id);
    }
  } finally { RUNS.length -= 2; delete DETAIL.n1; delete DETAIL.n2; }
});

// ---- loop r1 item 8c: Zapier's search tokenizes stored phones; one query form misses the others ----
test('phone search runs the 3 live-proven query forms on both scopes and unions the candidates', async () => {
  const r = await contactRuns(target(), { phone: '+1 (813) 555-0123' });
  const qs = gqlCalls.map((v) => [v.query, v.zapIds ? 'client' : 'login']);
  for (const q of ['8135550123', '18135550123', '813 555 0123']) {
    assert.ok(qs.some(([x, s]) => x === q && s === 'client'), `client search ${q}`);
    assert.ok(qs.some(([x, s]) => x === q && s === 'login'), `login search ${q}`);
  }
  assert.deepEqual(r.runs.map((x) => x.runId), ['r7']);
  assert.equal(detailCalls, new Set(RUNS.map((x) => x.id)).size, 'each candidate run fetched once');
});
