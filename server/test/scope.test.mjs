// Client-scoped tools. Stubbed fetch, temp ZAPIER_FACTORY_DIR, no network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-scope-'));
process.env.ZAPIER_FACTORY_DIR = tmp;
const { callTool, tools } = await import('../tools.mjs');
const { clientZapIds, ownershipIndex } = await import('../scope.mjs');

const REG = {
  logins: { agency: { email: 'owner@agency.example', accountId: '1' } },
  clients: {
    acme: { login: 'agency', folderIds: ['10', '99'], namePrefixes: ['Acme -'], ghl: { server: 'uxie-ghl-internal-mcp-acme', locationIds: ['LOC1'] } },
    other: { login: 'agency', folderIds: ['30'], namePrefixes: [] },
  },
};
fs.writeFileSync(path.join(tmp, 'clients.json'), JSON.stringify(REG));
const d = path.join(tmp, 'logins', 'agency');
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'session.json'), JSON.stringify({ cookies: [{ name: 'sessionid', value: 'x', domain: '.zapier.com', path: '/', expires: -1 }] }));

const TREE = { tree: [
  { id: 10, name: 'Acme', assetCount: 3, children: [{ id: 11, name: 'Acme sub', assetCount: 1, children: [] }] },
  { id: 30, name: 'Other', assetCount: 1, children: [] },
  { id: 40, name: 'Loose', assetCount: 0, children: [] },
] };
// Real asset.getHydratedFolderAssets row shape (live 2026-11-12, redacted): `id` is a UUID that embeds the
// numeric Zap id, `type` is 'zap' | 'table', and the numeric id is in searchZap.id / currentVersion.zapId.
const uuid = (n) => `00000000-0000-c000-8000-${String(n).padStart(12, '0')}`;
const zapA = (n, o = {}) => ({ id: uuid(n), type: 'zap', kind: 'workflow', folderId: 'f', currentVersion: { id: 'v', zapId: String(n) }, draft: null, searchZap: { id: n, zapId: uuid(n) }, ...o });
const tableA = (id) => ({ id, type: 'table', kind: 'table', name: 'T' });
const ASSETS = {
  10: [zapA(1), tableA('01M0TABLE')],
  11: [zapA(2)],
  30: [zapA(3)],
};
const ZAPS = [{ id: 4, zapId: 'u4', title: 'ACME - lead intake' }, { id: 5, zapId: 'u5', title: 'Not Acme - x' }, { id: 1, zapId: 'u1', title: 'Dup' }, { id: 2, zapId: 'u2', title: 'Sub zap' }, { id: 3, zapId: 'u3', title: 'Other zap' }];
const wrap = (j) => ({ result: { data: { json: j } } });
let runStatus, zapBody, runZap, gqlVars, restUrl, assetPageCap, assetsKey, gqlTotal, versionsPages, storageUrls, extraEdges, extraRest, runSteps;
const realFetch = globalThis.fetch;
beforeEach(() => {
  assetPageCap = Infinity; assetsKey = 'results'; extraEdges = []; extraRest = []; runSteps = []; gqlTotal = 3; versionsPages = null; storageUrls = [];
  runStatus = 200; runZap = 1; gqlVars = null; restUrl = null; zapBody = { id: 7, current_version: { id: 'v', zdl: { steps: [{ id: 's' }] } } };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/api/v4/session')) return json({ is_logged_in: true, email: 'owner@agency.example', id: 5, current_account_id: 1 });
    if (u.includes('folder.folderTree')) return json(wrap(TREE));
    if (u.includes('asset.getHydratedFolderAssets')) {
      const input = JSON.parse(new URL(u).searchParams.get('input'));
      const all = ASSETS[input.folderId] || [];
      return json(wrap({ failedAssetTypes: [], hasServiceError: false, meta: { count: all.length, limit: input.limit, offset: input.offset }, [assetsKey]: all.slice(input.offset, input.offset + Math.min(input.limit, assetPageCap)) }));
    }
    if (u.includes('zap.searchZaps')) return json(wrap({ count: ZAPS.length, next: null, results: ZAPS }));
    if (u.includes('/api/reporting/graphql')) {
      gqlVars = JSON.parse(init.body).variables;
      const zs = [1, 3, 5];
      return json({ data: { zapRuns: { totalCount: gqlTotal, totalActionable: 0, edges: [...zs.map((z) => ({ id: 'r' + z, zap: { id: String(z), title: 't' } })), ...extraEdges] } } });
    }
    if (u.includes('/zap-history/v2/runs/')) return runStatus === 200 ? json({ id: 'r', zap_id: runZap, steps_executions: runSteps }) : json({ detail: 'x' }, runStatus);
    if (u.includes('/zap-history/v2/runs')) { restUrl = u; return json({ meta: { count: 3 }, runs: [{ id: 'a', zap_id: 1 }, { id: 'b', zap_id: 3 }, { id: 'c', zap_id: 5 }, ...extraRest] }); }
    if (u.includes('/redir')) return new Response(null, { status: 302, headers: { location: 'https://zapier.com/app/next?token=SECRET&x=1' } });
    if (u.includes('/storage/v1/zaps/')) {
      storageUrls.push(u);
      if (versionsPages && u.includes('/versions')) return json(versionsPages.shift() ?? { results: [], meta: {} });
      return json(zapBody);
    }
    if (u.includes('/trpc/')) return json(wrap({ results: [] }));
    return json({});
  };
});
process.on('exit', () => { globalThis.fetch = realFetch; });

const target = (o = {}) => ({ login: 'agency', accountId: '1', client: 'acme', folderIds: ['10'], namePrefixes: [], ...o });

test('folder recursion includes child-folder Zaps, drops tables', async () => {
  const r = await clientZapIds(target());
  assert.deepEqual(r.ids.sort(), ['1', '2']);
  assert.deepEqual(r.warnings, []);
});
test('prefix match is case-insensitive at title start only, unioned with folders', async () => {
  const r = await clientZapIds(target({ folderIds: ['10'], namePrefixes: ['acme -'] }));
  assert.deepEqual(r.ids.sort(), ['1', '2', '4']);
});
test('missing folder gives a warning, not a throw', async () => {
  const r = await clientZapIds(target({ folderIds: ['10', '99'] }));
  assert.deepEqual(r.warnings, ['folder 99 not found in agency']);
  assert.deepEqual(r.ids.sort(), ['1', '2']);
});
test('get_zap draft-only returns source draft; published returns published', async () => {
  zapBody = { id: 7, current_version: null, draft: { id: 'd', zdl: { steps: [{ id: 'x' }] } } };
  const r = await callTool('get_zap', { login: 'agency', zapId: 7, include_settings: false, include_hook: false });
  assert.equal(r.source, 'draft'); assert.equal(r.steps.length, 1);
  zapBody = { id: 7, current_version: { id: 'v', zdl: { steps: [{ id: 'a' }, { id: 'b' }] } } };
  const p = await callTool('get_zap', { login: 'agency', zapId: 7, include_settings: false, include_hook: false });
  assert.equal(p.source, 'published'); assert.equal(p.steps.length, 2);
});
test('get_run 500 and 404 -> RUN_NOT_FOUND <id>', async () => {
  for (const s of [500, 404]) {
    runStatus = s;
    await assert.rejects(callTool('get_run', { login: 'agency', runId: 'abc' }), /^Error: RUN_NOT_FOUND abc$/);
  }
});
test('list_clients shows login and counts', async () => {
  const r = await callTool('list_clients', {});
  const a = r.clients.find((c) => c.client === 'acme');
  assert.equal(a.login, 'agency'); assert.equal(a.folderIds, 2); assert.equal(a.namePrefixes, 1);
});
test('list_clients carries scope level registry and each client ghl server + locationIds', async () => {
  const r = await callTool('list_clients', {});
  assert.deepEqual(r.scope, { level: 'registry' });
  assert.equal(Object.keys(r)[0], 'scope');
  const a = r.clients.find((c) => c.client === 'acme');
  assert.deepEqual(a.ghl, { server: 'uxie-ghl-internal-mcp-acme', locationIdCount: 1, locationIds: ['LOC1'] });
  assert.equal(r.clients.find((c) => c.client === 'other').ghl, null);
});
test('unmapped_folders lists folders no client references (descendants of mapped ones are covered)', async () => {
  const r = await callTool('unmapped_folders', { login: 'agency' });
  assert.deepEqual(r.folders.map((f) => f.id), ['40']);
});
test('tool resolution: unknown client errors; 18 tools registered', async () => {
  await assert.rejects(callTool('list_zaps', { client: 'nope' }), /Unknown client/);
  assert.equal(Object.keys(tools).length, 18);
});

// ---- fix round 1: cross-client labelling ----
test("get_run of another client's Zap is labelled other-client and still returned", async () => {
  runZap = 3;
  const r = await callTool('get_run', { client: 'acme', runId: 'x' });
  assert.equal(r.ownership, 'other-client');
  assert.equal(r.label, 'belongs to other — excluded from acme conclusions');
  assert.deepEqual(r.scope, { client: 'acme', login: 'agency' });
  runZap = 5;
  const w = await callTool('get_run', { client: 'acme', runId: 'x' });
  assert.equal(w.ownership, 'login-wide'); assert.equal(w.label, "agency-wide Zap, not acme's");
  runZap = 1;
  assert.equal((await callTool('get_run', { client: 'acme', runId: 'x' })).ownership, 'client');
});
test('get_zap / list_zap_versions / step_gives carry ownership with a client', async () => {
  zapBody = { id: 3, current_version: { id: 'v', zdl: { steps: [] } } };
  assert.equal((await callTool('get_zap', { client: 'acme', zapId: 3, include_settings: false, include_hook: false })).ownership, 'other-client');
  assert.equal((await callTool('list_zap_versions', { client: 'acme', zapId: 5 })).ownership, 'login-wide');
  assert.equal((await callTool('step_gives', { client: 'acme', zapId: 1, stepId: 's', runId: 'r' })).ownership, 'client');
  assert.equal((await callTool('get_zap_version', { client: 'acme', zapId: 4, versionId: 'v' })).ownership, 'client');
});
test('list_zaps with a client returns only its Zaps; include_login_wide adds labelled rest', async () => {
  const r = await callTool('list_zaps', { client: 'acme' });
  assert.deepEqual(r.results.map((x) => x.id).sort(), [1, 2, 4]);
  assert.ok(r.results.every((x) => x.ownership === 'client'));
  assert.deepEqual(r.excluded, { login_wide: 1, other_client: 1, conflict: 0 });
  assert.ok(!('excluded_login_wide' in r));
  const w = await callTool('list_zaps', { client: 'acme', include_login_wide: true });
  assert.equal(w.results.find((x) => x.id === 5).label, "agency-wide Zap, not acme's");
  assert.deepEqual(w.excluded, { login_wide: 0, other_client: 0, conflict: 0 });
  assert.match(tools.list_zaps.description, /excluded: \{login_wide, other_client, conflict\}/);
});
test('list_runs_rest with a client restricts zap_ids; include_login_wide labels every run', async () => {
  const r = await callTool('list_runs_rest', { client: 'acme', zap_ids: [1, 3] });
  assert.match(restUrl, /zap_ids=1(&|$)/);
  assert.ok(r.warnings.some((x) => /zap 3 excluded: belongs to other/.test(x)));
  assert.equal(r.runs.find((x) => x.id === 'a').ownership, 'client');
  const w = await callTool('list_runs_rest', { client: 'acme', include_login_wide: true });
  assert.ok(!/zap_ids/.test(restUrl));
  assert.deepEqual(w.runs.map((x) => x.ownership), ['client', 'other-client', 'login-wide']);
});
test('search_runs with client + foreign zapId excludes it with a warning; include_login_wide keeps and labels', async () => {
  const r = await callTool('search_runs', { client: 'acme', zapIds: [1, 3] });
  assert.deepEqual(gqlVars.zapIds, ['1']);
  assert.ok(r.warnings.some((x) => /zap 3 excluded/.test(x)));
  assert.equal(r.scope.client, 'acme');
  const w = await callTool('search_runs', { client: 'acme', zapIds: [1, 3], include_login_wide: true });
  assert.deepEqual(gqlVars.zapIds, ['1', '3']);
  assert.deepEqual(w.edges.map((e) => e.ownership), ['client', 'other-client', 'login-wide']);
});
test('search_runs folderIds are intersected with the client folders and descendants', async () => {
  const r = await callTool('search_runs', { client: 'acme', folderIds: ['11', '30'] });
  assert.deepEqual(gqlVars.folderIds, ['11']);
  assert.ok(r.warnings.some((x) => /folder 30 excluded/.test(x)));
});
test('login-level tools say so in scope', async () => {
  const r = await callTool('list_folders', { client: 'acme' });
  assert.deepEqual(r.scope, { client: 'acme', login: 'agency', level: 'login' });
  const m = await callTool('list_tables', { login: 'agency' });
  assert.deepEqual(m.scope, { login: 'agency', client: null, level: 'login' });
  for (const n of ['list_folders', 'folder_assets', 'list_connections', 'list_members', 'list_tables', 'held_counts']) assert.match(tools[n].description, /Login-wide, not client-filtered/);
});
test('folder asset of an unknown type warns (tables are ignored silently)', async () => {
  ASSETS[10] = [{ id: 1, weird: 'zap' }, tableA('01M0TABLE')];
  try {
    const r = await clientZapIds(target({ folderIds: ['10'] }));
    assert.ok(r.warnings.includes('folder 10: 1 assets of unknown type ignored (expected type zap or table)'), JSON.stringify(r.warnings));
  } finally { ASSETS[10] = [zapA(1), tableA('01M0TABLE')]; }
});
test('overlapping client folders warn naming both clients', async () => {
  const reg = JSON.parse(fs.readFileSync(path.join(tmp, 'clients.json'), 'utf8'));
  const saved = JSON.stringify(reg);
  reg.clients.other.folderIds = ['10'];
  fs.writeFileSync(path.join(tmp, 'clients.json'), JSON.stringify(reg));
  try {
    const r = await clientZapIds(target({ folderIds: ['11'] }));
    assert.ok(r.warnings.some((x) => /acme/.test(x) && /other/.test(x) && /folder 11/.test(x)));
  } finally { fs.writeFileSync(path.join(tmp, 'clients.json'), saved); }
});

// ---- final fix wave: no silent login fallback ----
test('no client, no login, no .zapier-client -> error listing known clients and logins (no agency fallback)', async () => {
  const here = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'zf-nocli-')));
  try {
    await assert.rejects(callTool('list_zaps', {}), (e) => /Known clients: acme, other/.test(e.message) && /Known logins: agency/.test(e.message));
    await assert.rejects(callTool('zapier_whoami', {}), /Known logins: agency/);
  } finally { process.chdir(here); }
});
test('explicit-login-only calls carry scope {login, client:null, level:login} on every tool', async () => {
  const z = await callTool('get_zap', { login: 'agency', zapId: 7, include_settings: false, include_hook: false });
  assert.deepEqual(z.scope, { login: 'agency', client: null, level: 'login' });
  const l = await callTool('list_zaps', { login: 'agency' });
  assert.deepEqual(l.scope, { login: 'agency', client: null, level: 'login' });
});
test('client plus a different login is an error', async () => {
  await assert.rejects(callTool('list_zaps', { client: 'acme', login: 'client-b' }), /acme.*agency/);
});
test('no tool description or argument mentions a default agency login', () => {
  for (const [n, t] of Object.entries(tools)) {
    assert.doesNotMatch(t.description, /default.*agency|agency.*default/i, n);
    assert.doesNotMatch(t.schema.login.description ?? '', /agency/, n);
  }
});

// ---- final fix wave: one claim map per login (item 1) ----
const withReg = async (mut, fn) => {
  const file = path.join(tmp, 'clients.json');
  const saved = fs.readFileSync(file, 'utf8');
  const reg = JSON.parse(saved); mut(reg); fs.writeFileSync(file, JSON.stringify(reg));
  try { return await fn(); } finally { fs.writeFileSync(file, saved); }
};
const regTarget = (client) => { const c = JSON.parse(fs.readFileSync(path.join(tmp, 'clients.json'), 'utf8')).clients[client]; return { login: 'agency', accountId: '1', client, folderIds: c.folderIds, namePrefixes: c.namePrefixes }; };
const CONFLICT = 'claimed by acme and other — fix clients.json; excluded from conclusions';

test('nested folders: the deepest mapped folder wins; clientZapIds and ownershipOf agree', async () => {
  await withReg((r) => { r.clients.acme = { login: 'agency', folderIds: ['10'], namePrefixes: [] }; r.clients.other.folderIds = ['11']; }, async () => {
    const a = await clientZapIds(regTarget('acme'));
    assert.deepEqual(a.ids, ['1']);
    const ia = await ownershipIndex(regTarget('acme'));
    assert.equal(ia.ownershipOf(2).ownership, 'other-client');
    assert.equal(ia.ownershipOf(1).ownership, 'client');
    assert.ok(!ia.warnings.some((w) => /claimed by/.test(w)));
    const io = await ownershipIndex(regTarget('other'));
    assert.equal(io.ownershipOf(2).ownership, 'client');
    assert.deepEqual(io.clientIds, ['2']);
  });
});
test('same folder mapped by two clients -> conflict for both, excluded from both id lists, warning in both', async () => {
  await withReg((r) => { r.clients.acme = { login: 'agency', folderIds: ['10'], namePrefixes: [] }; r.clients.other.folderIds = ['10']; }, async () => {
    for (const who of ['acme', 'other']) {
      const ix = await ownershipIndex(regTarget(who));
      assert.deepEqual(ix.ownershipOf(1), { ownership: 'conflict', label: CONFLICT });
      assert.ok(!ix.clientIds.includes('1') && !ix.clientIds.includes('2'), who);
      assert.ok(ix.warnings.some((w) => /zap 1/.test(w) && w.includes(CONFLICT)), who);
      assert.deepEqual((await clientZapIds(regTarget(who))).ids, []);
    }
  });
});
test('prefix-only match by two clients -> conflict; a folder claim beats a prefix claim', async () => {
  await withReg((r) => { r.clients.acme = { login: 'agency', folderIds: ['10'], namePrefixes: ['acme'] }; r.clients.other = { login: 'agency', folderIds: [], namePrefixes: ['ACME -', 'dup'] }; }, async () => {
    const ia = await ownershipIndex(regTarget('acme'));
    assert.deepEqual(ia.ownershipOf(4), { ownership: 'conflict', label: CONFLICT });
    assert.equal(ia.ownershipOf(1).ownership, 'client'); // 'Dup' is in acme's folder 10: folder beats other's prefix
    const io = await ownershipIndex(regTarget('other'));
    assert.equal(io.ownershipOf(1).ownership, 'other-client');
    assert.ok(io.warnings.some((w) => /zap 4/.test(w)));
  });
});
test('same-depth folders of two clients holding one Zap -> conflict', async () => {
  ASSETS[30] = [zapA(3), zapA(1)];
  try {
    await withReg((r) => { r.clients.acme = { login: 'agency', folderIds: ['10'], namePrefixes: [] }; }, async () => {
      const ia = await ownershipIndex(regTarget('acme'));
      assert.equal(ia.ownershipOf(1).ownership, 'conflict');
      assert.deepEqual(ia.clientIds, ['2']);
    });
  } finally { ASSETS[30] = [zapA(3)]; }
});

// ---- final fix wave: folder-asset assumptions are checked (item 5) ----
test('folder asset ids not found among Zaps -> warning', async () => {
  ASSETS[11] = [zapA(2), zapA(77)];
  TREE.tree[0].children[0].assetCount = 2; TREE.tree[0].assetCount = 4;
  try {
    const r = await clientZapIds(target());
    assert.ok(r.warnings.includes('folder 11: 1 folder Zaps not found in zap.searchZaps (deleted or not visible to this login?)'), JSON.stringify(r.warnings));
  } finally { ASSETS[11] = [zapA(2)]; TREE.tree[0].children[0].assetCount = 1; TREE.tree[0].assetCount = 3; }
});
test('assetCount gap between folder tree and returned assets -> warning', async () => {
  TREE.tree[0].assetCount = 5;
  try {
    const r = await clientZapIds(target());
    assert.ok(r.warnings.includes('folder 10: folder tree assetCount 5 (counts subfolders), folder and subfolder assets returned 3'), JSON.stringify(r.warnings));
  } finally { TREE.tree[0].assetCount = 3; }
});
test('response without a results key for a non-empty folder -> warning, not a silent 0', async () => {
  assetsKey = 'items';
  const r = await clientZapIds(target());
  assert.ok(r.warnings.some((w) => /folder 10/.test(w) && /results/.test(w)), JSON.stringify(r.warnings));
});
test('paging continues past a short page until the total is reached', async () => {
  assetPageCap = 1; // server returns 1 row per page whatever the limit
  ASSETS[10] = [tableA('01M0TABLE'), zapA(1)]; // the Zap is on page 2
  try {
    const r = await clientZapIds(target());
    assert.deepEqual(r.ids.sort(), ['1', '2']);
  } finally { ASSETS[10] = [zapA(1), tableA('01M0TABLE')]; }
});
test('search_runs folderIds: a subfolder won by a deeper mapping of another client is not the client\'s', async () => {
  await withReg((r) => { r.clients.other.folderIds = ['11']; }, async () => {
    const res = await callTool('search_runs', { client: 'acme', folderIds: ['10', '11'] });
    assert.deepEqual(gqlVars.folderIds, ['10']);
    assert.ok(res.warnings.some((x) => /folder 11 excluded/.test(x)));
  });
});

// ---- final fix wave: warnings/window first, zap-level warnings, unknown ownership (item 4b + minors) ----
test('search_runs output starts with warnings then window; all=true merges scope and paging warnings', async () => {
  gqlTotal = 10000;
  const r = await callTool('search_runs', { client: 'acme', zapIds: [1, 3], all: true });
  assert.deepEqual(Object.keys(r).slice(0, 2), ['warnings', 'window']);
  assert.ok(r.warnings.some((x) => /zap 3 excluded/.test(x)), 'scope warning kept');
  assert.ok(r.warnings.some((x) => /capped at 10000/.test(x)), 'allRuns warning kept');
  const p = await callTool('search_runs', { client: 'acme', zapIds: [1, 3] });
  assert.deepEqual(Object.keys(p).slice(0, 2), ['warnings', 'window']);
});
test('list_runs_rest and list_zaps outputs start with warnings', async () => {
  assert.equal(Object.keys(await callTool('list_runs_rest', { client: 'acme', zap_ids: [1, 3] }))[0], 'warnings');
  assert.equal(Object.keys(await callTool('list_zaps', { client: 'acme' }))[0], 'warnings'); // folder 99 not found
});
test("zap-level tools include the client's scope warnings", async () => {
  const r = await callTool('get_zap', { client: 'acme', zapId: 1, include_settings: false, include_hook: false });
  assert.ok(r.warnings.includes('folder 99 not found in agency'), JSON.stringify(r.warnings));
  assert.equal(Object.keys(r)[0], 'warnings');
});
test('get_run without zap_id -> ownership unknown', async () => {
  runZap = undefined;
  const r = await callTool('get_run', { client: 'acme', runId: 'x' });
  assert.equal(r.ownership, 'unknown');
  assert.equal(r.label, 'run has no zap_id — ownership unknown');
});
test("search_runs: the caller's zapIds all excluded vs the client having no Zaps are different messages", async () => {
  const r = await callTool('search_runs', { client: 'acme', zapIds: [3] });
  assert.ok(r.warnings.some((x) => /none of the requested zapIds belong to acme/.test(x)), JSON.stringify(r.warnings));
  assert.ok(!r.warnings.some((x) => /no Zaps found for client/.test(x)));
  await withReg((reg) => { reg.clients.other.folderIds = ['40']; }, async () => {
    const o = await callTool('search_runs', { client: 'other' });
    assert.ok(o.warnings.some((x) => /no Zaps found for client other/.test(x)));
  });
});
test('versions cursor: only a cursor URL for the same Zap versions path is followed', async () => {
  await assert.rejects(callTool('list_zap_versions', { login: 'agency', zapId: 7, all: false, cursor: 'https://zapier.com/api/gulliver/storage/v1/zaps/9/versions?cursor=x' }), /cursor/i);
  await assert.rejects(callTool('list_zap_versions', { login: 'agency', zapId: 7, all: false, cursor: '/api/v4/session' }), /cursor/i);
  await callTool('list_zap_versions', { login: 'agency', zapId: 7, all: false, cursor: '/api/gulliver/storage/v1/zaps/7/versions?cursor=x' });
  assert.match(storageUrls.at(-1), /\/zaps\/7\/versions\?cursor=x/);
  versionsPages = [{ results: [{ id: 'a' }], meta: { next_cursor: '/api/gulliver/storage/v1/zaps/999/versions?cursor=y' } }];
  await assert.rejects(callTool('list_zap_versions', { login: 'agency', zapId: 7 }), /cursor/i);
  versionsPages = [{ results: [{ id: 'a' }], meta: { next_cursor: 'https://zapier.com/api/gulliver/storage/v1/zaps/7/versions?cursor=y' } }, { results: [{ id: 'b' }], meta: {} }];
  const ok = await callTool('list_zap_versions', { login: 'agency', zapId: 7 });
  assert.deepEqual(ok.versions.map((v) => v.id), ['a', 'b']);
});
test('HTTP_REDIRECT error strips the query string from location', async () => {
  const { request } = await import('../lib.mjs');
  await assert.rejects(request('agency', 'GET', '/api/redir'), (e) => e.code === 'HTTP_REDIRECT' && /app\/next/.test(e.message) && !/SECRET|token|\?/.test(e.message.split('→')[1]));
});

// ---- loop r1 item 1: real folder-asset shape ----
test('real asset shape: numeric Zap id from searchZap.id, else currentVersion/draft zapId, else the UUID', async () => {
  ASSETS[11] = [zapA(2, { searchZap: undefined, currentVersion: null, draft: { zapId: '2' } })];
  ASSETS[30] = [zapA(3, { searchZap: null, currentVersion: null })];
  try {
    const r = await clientZapIds(target());
    assert.deepEqual(r.ids.sort(), ['1', '2']);
    assert.deepEqual(r.warnings, []);
    await withReg((reg) => { reg.clients.acme = { login: 'agency', folderIds: ['30'], namePrefixes: [] }; reg.clients.other.folderIds = []; }, async () => {
      assert.deepEqual((await clientZapIds(regTarget('acme'))).ids, ['3']);
    });
  } finally { ASSETS[11] = [zapA(2)]; ASSETS[30] = [zapA(3)]; }
});
test('a Zap asset with no recognisable numeric id warns and is not claimed', async () => {
  ASSETS[11] = [zapA(2), { id: 'not-a-zap-uuid', type: 'zap', kind: 'workflow' }];
  TREE.tree[0].children[0].assetCount = 2; TREE.tree[0].assetCount = 4;
  try {
    const r = await clientZapIds(target());
    assert.deepEqual(r.ids.sort(), ['1', '2']);
    assert.ok(r.warnings.includes('folder 11: 1 Zap assets without a numeric Zap id (asset ids: not-a-zap-uuid)'), JSON.stringify(r.warnings));
  } finally { ASSETS[11] = [zapA(2)]; TREE.tree[0].children[0].assetCount = 1; TREE.tree[0].assetCount = 3; }
});
test('folder tree assetCount counts subfolders: a parent with fewer own assets than assetCount is not a warning', async () => {
  const r = await clientZapIds(target()); // folder 10: own 2, subtree 3, assetCount 3
  assert.deepEqual(r.warnings, []);
});

// ---- loop r1 item 2: runs with no zap id are 'unknown', not login-wide via String(undefined) ----
const UNKNOWN = { ownership: 'unknown', label: 'run has no zap_id — ownership unknown' };
test('search_runs labels an edge with a null/missing zap as ownership unknown', async () => {
  extraEdges = [{ id: 'n1', zap: null }, { id: 'n2' }];
  const r = await callTool('search_runs', { client: 'acme', include_login_wide: true });
  for (const id of ['n1', 'n2']) {
    const e = r.edges.find((x) => x.id === id);
    assert.deepEqual({ ownership: e.ownership, label: e.label }, UNKNOWN, id);
  }
});
test('list_runs_rest labels a run with a null/missing zap_id as ownership unknown', async () => {
  extraRest = [{ id: 'n1', zap_id: null }, { id: 'n2' }];
  const r = await callTool('list_runs_rest', { client: 'acme', include_login_wide: true });
  for (const id of ['n1', 'n2']) {
    const e = r.runs.find((x) => x.id === id);
    assert.deepEqual({ ownership: e.ownership, label: e.label }, UNKNOWN, id);
  }
});
test('ownershipOf(null/undefined/empty) is unknown', async () => {
  const ix = await ownershipIndex(target());
  for (const v of [null, undefined, '']) assert.deepEqual(ix.ownershipOf(v), UNKNOWN, String(v));
});

// ---- loop r1 item 3: step_gives describes the 60 s session check honestly ----
test('step_gives description says the account is verified at most 60 s earlier, not before every call', async () => {
  const { VERIFY_TTL_MS } = await import('../lib.mjs');
  assert.equal(VERIFY_TTL_MS, 60_000);
  assert.doesNotMatch(tools.step_gives.description, /before every call/);
  assert.match(tools.step_gives.description, /at most 60 s/);
});

// ---- loop r1 item 4: README labels are the code's labels, character for character ----
test('README ownership labels match the code labels exactly (em dash)', async () => {
  const { LABELS, NO_ZAP_ID } = await import('../scope.mjs');
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const expected = [
    LABELS.client('<client>'), LABELS.loginWide('<login>', '<client>'), LABELS.otherClient('<other client>', '<client>'),
    LABELS.conflict(['<a>', '<b>']), NO_ZAP_ID.label,
  ];
  for (const l of expected) assert.ok(readme.includes(`\`"${l}"\``), `README lacks \`"${l}"\``);
  assert.doesNotMatch(readme.split('## Ownership labels')[1].split('##')[0], / - (excluded|fix|ownership)/);
});

// ---- loop r1 item 6: list_zaps counts what it left out by ownership ----
test('list_zaps excluded counts conflicts separately', async () => {
  await withReg((r) => { r.clients.acme = { login: 'agency', folderIds: ['10'], namePrefixes: [] }; r.clients.other.folderIds = ['10']; }, async () => {
    const z = await callTool('list_zaps', { client: 'acme' });
    assert.deepEqual(z.excluded, { login_wide: 3, other_client: 0, conflict: 2 });
  });
});

// ---- loop r1 item 8a: step_errors is ONE object on live error runs (2026-11-12), not an array ----
test('get_run reads step_errors whether it is an object (live shape), an array, or absent', async () => {
  runSteps = [
    { step_id: 1, app: 'A', action: 'a', status: 'success', input: {}, output: {} },
    { step_id: 2, app: 'B', action: 'b', status: 'error', step_errors: { id: 'e1', error_msg: 'Bad request (redacted)', title: 'Failed', code: 'ERR', status: null, version: 1 } },
    { step_id: 3, app: 'C', action: 'c', status: 'error', step_errors: [{ error_msg: 'm1' }, { message: 'm2' }] },
  ];
  const r = await callTool('get_run', { login: 'agency', runId: 'x' });
  assert.deepEqual(r.steps.map((s) => s.errors), [[], ['Bad request (redacted)'], ['m1', 'm2']]);
});
