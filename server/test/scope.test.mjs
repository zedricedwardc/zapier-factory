// Client-scoped tools. Stubbed fetch, temp ZAPIER_FACTORY_DIR, no network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-scope-'));
process.env.ZAPIER_FACTORY_DIR = tmp;
const { callTool, tools } = await import('../tools.mjs');
const scope = await import('../scope.mjs');
const { clientZapIds, ownershipIndex } = scope;

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
let gqlBodies = [];
let searchZapsInputs = [], zapGqlFail = false, trpcDead = false, zapPage = 25;
const FOLDER_OF = { 1: '10', 2: '11', 3: '30' };
let runStatus, zapBody, runZap, gqlVars, restUrl, assetPageCap, assetsKey, gqlTotal, versionsPages, storageUrls, extraEdges, extraRest, runSteps;
const realFetch = globalThis.fetch;
beforeEach(() => {
  scope._resetScopeCache?.();
  gqlBodies = []; searchZapsInputs = []; zapGqlFail = false; trpcDead = false; zapPage = 25; assetPageCap = Infinity; assetsKey = 'results'; extraEdges = []; extraRest = []; runSteps = []; gqlTotal = 3; versionsPages = null; storageUrls = [];
  runStatus = 200; runZap = 1; gqlVars = null; restUrl = null; zapBody = { id: 7, current_version: { id: 'v', zdl: { steps: [{ id: 's' }] } } };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/api/v4/session')) return json({ is_logged_in: true, email: 'owner@agency.example', id: 5, current_account_id: 1 });
    if (trpcDead && u.includes('/trpc/') && !u.includes('zap.searchZaps')) return json({ error: 'unauthorized' }, 401);
    if (u.includes('folder.folderTree')) return json(wrap(TREE));
    if (u.includes('asset.getHydratedFolderAssets')) {
      const input = JSON.parse(new URL(u).searchParams.get('input'));
      const all = ASSETS[input.folderId] || [];
      return json(wrap({ failedAssetTypes: [], hasServiceError: false, meta: { count: all.length, limit: input.limit, offset: input.offset }, [assetsKey]: all.slice(input.offset, input.offset + Math.min(input.limit, assetPageCap)) }));
    }
    if (u.includes('zap.searchZaps')) {
      searchZapsInputs.push(JSON.parse(new URL(u).searchParams.get('input')));
      if (trpcDead) return json({ error: 'unauthorized' }, 401);
      // status filter honoured like Zapier (on/off); odd ids are on, as in the GraphQL mock below
      const inp = searchZapsInputs.at(-1); const zs = inp.status ? ZAPS.filter((z) => (z.id % 2 === 1) === (inp.status === 'on')) : ZAPS;
      return json(wrap({ count: zs.length, next: null, results: zs }));
    }
    if (u.includes('/api/v4/jwt/refresh')) return new Response('', { status: 401 });
    if (u.includes('/api/reporting/graphql')) {
      const gb = JSON.parse(init.body);
      gqlBodies.push(gb);
      if (gb.operationName === 'BillableTaskUsage') { gqlVars = gb.variables; return json({ data: USAGE }); }
      // ZapSearch / ZapsById (live 2026-11-12, redacted): ids are strings, 25 edges per page/call, container = folder.
      const gqlZap = (z) => ({ id: String(z.id), title: z.title, isEnabled: z.id % 2 === 1, ...(gb.variables.includeFolder ? { container: { __typename: 'Folder', id: FOLDER_OF[z.id] ?? 'root', title: 'F' } } : {}) });
      if (gb.operationName === 'ZapsById') { if (zapGqlFail) return json({ errors: [{ message: 'Bad Request' }] }); return json({ data: { zaps: { edges: ZAPS.filter((z) => gb.variables.ids.includes(String(z.id))).slice(0, 25).map(gqlZap) } } }); }
      if (gb.operationName === 'ZapSearch') {
        if (zapGqlFail) return json({ errors: [{ message: 'Bad Request' }] });
        const start = Number(gb.variables.cursor ?? 0); const page = ZAPS.slice(start, start + zapPage);
        return json({ data: { zaps: { cursor: start + zapPage < ZAPS.length ? String(start + zapPage) : null, edges: page.map(gqlZap), totalCount: ZAPS.length } } });
      }
      if (gb.operationName === 'AppsWithCurrentImplementationId') return json({ data: { appsByCurrentImplementationId: APPS.filter((a) => gb.variables.ids.includes(a.currentImplementation.id)) } });
      gqlVars = JSON.parse(init.body).variables;
      const zs = [1, 3, 5];
      return json({ data: { zapRuns: { totalCount: gqlTotal, totalActionable: 0, edges: [...zs.map((z) => ({ id: 'r' + z, zap: { id: String(z), title: 't' } })), ...extraEdges] } } });
    }
    if (u.includes('/zap-history/v2/runs/')) return runStatus === 200 ? json({ id: 'r', zap_id: runZap, zap_title: 'Trigger: Booking Cancelled', steps_executions: runSteps }) : json({ detail: 'x' }, runStatus);
    // Real REST list shape (live 2026-11-12, redacted): rows under `results`, zap_id a string, full steps_executions.
    if (u.includes('/zap-history/v2/runs')) { restUrl = u; const row = (id, z) => ({ id, attempt: 'att-' + id, zap_id: z, status: 'success', zap_title: 'Trigger: X', stop_reason: null, start_time: '2026-11-12T14:24:15.233000Z', steps_executions: [{ step_id: 1, input: { email: 'person@customer.example' }, output: {} }] }); return json({ meta: { offset: 0, limit: 50, count: 3, total_actionable: 3 }, results: [row('a', '1'), row('b', '3'), row('c', '5'), ...extraRest] }); }
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

const RUN_ID = '0a1b2c3d-0000-4000-8000-00000000000a';
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
    await assert.rejects(callTool('get_run', { login: 'agency', runId: RUN_ID }), new RegExp(`^Error: RUN_NOT_FOUND ${RUN_ID}$`));
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
test('tool resolution: unknown client errors; 20 tools registered', async () => {
  await assert.rejects(callTool('list_zaps', { client: 'nope' }), /Unknown client/);
  assert.equal(Object.keys(tools).length, 20);
});

// ---- fix round 1: cross-client labelling ----
test("get_run of another client's Zap is labelled other-client and still returned", async () => {
  runZap = 3;
  const r = await callTool('get_run', { client: 'acme', runId: RUN_ID });
  assert.equal(r.ownership, 'other-client');
  assert.equal(r.label, 'belongs to other — excluded from acme conclusions');
  const { claim_map_built_at, ...sc } = r.scope;
  assert.deepEqual(sc, { client: 'acme', login: 'agency' });
  assert.match(claim_map_built_at, /^\d{4}-/);
  runZap = 5;
  const w = await callTool('get_run', { client: 'acme', runId: RUN_ID });
  assert.equal(w.ownership, 'login-wide'); assert.equal(w.label, "agency-wide Zap, not acme's");
  runZap = 1;
  assert.equal((await callTool('get_run', { client: 'acme', runId: RUN_ID })).ownership, 'client');
});
test('get_zap / list_zap_versions / step_gives carry ownership with a client', async () => {
  zapBody = { id: 3, current_version: { id: 'v', zdl: { steps: [] } } };
  assert.equal((await callTool('get_zap', { client: 'acme', zapId: 3, include_settings: false, include_hook: false })).ownership, 'other-client');
  assert.equal((await callTool('list_zap_versions', { client: 'acme', zapId: 5 })).ownership, 'login-wide');
  assert.equal((await callTool('step_gives', { client: 'acme', zapId: 1, stepId: 7, runId: RUN_ID })).ownership, 'client');
  assert.equal((await callTool('get_zap_version', { client: 'acme', zapId: 4, versionId: RUN_ID })).ownership, 'client');
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
  assert.equal(r.results.find((x) => x.id === 'a').ownership, 'client');
  const w = await callTool('list_runs_rest', { client: 'acme', include_login_wide: true });
  assert.ok(!/zap_ids/.test(restUrl));
  assert.deepEqual(w.results.map((x) => x.ownership), ['client', 'other-client', 'login-wide']);
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
    assert.ok(r.warnings.includes("folder 11: 1 folder Zaps not found in the account's Zap list (deleted or not visible to this login?)"), JSON.stringify(r.warnings));
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
  const r = await callTool('get_run', { client: 'acme', runId: RUN_ID });
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
    const e = r.results.find((x) => x.id === id);
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
  const r = await callTool('get_run', { login: 'agency', runId: RUN_ID });
  assert.deepEqual(r.steps.map((s) => s.errors), [[], ['Bad request (redacted)'], ['m1', 'm2']]);
});

// ---- loop r2 C-1 + I-5: list_runs_rest reads `results`, is compact by default, has a default window ----
test('list_runs_rest (client) returns the live `results` rows labelled, not an empty runs list', async () => {
  const r = await callTool('list_runs_rest', { client: 'acme' });
  assert.equal(r.results.length, 3);
  assert.ok(!('runs' in r));
  assert.deepEqual(r.results.map((x) => x.ownership), ['client', 'other-client', 'login-wide']);
  assert.equal(r.meta.count, 3);
});
test('list_runs_rest rows are compact by default (no step data), full:true keeps steps_executions', async () => {
  for (const args of [{ client: 'acme' }, { login: 'agency' }]) {
    const r = await callTool('list_runs_rest', args);
    const text = JSON.stringify(r);
    assert.ok(!text.includes('person@customer.example'), JSON.stringify(args));
    assert.ok(r.results.every((x) => !('steps_executions' in x) && x.steps === 1));
    assert.equal(r.results[0].attempt, 'att-a');
  }
  const f = await callTool('list_runs_rest', { login: 'agency', full: true });
  assert.equal(f.results[0].steps_executions.length, 1);
});
test('list_runs_rest defaults from_date/to_date to now-60d..now+1d and returns window first', async () => {
  const r = await callTool('list_runs_rest', { login: 'agency' });
  const u = new URL(restUrl);
  assert.ok(u.searchParams.get('from_date') && u.searchParams.get('to_date'));
  assert.ok(Date.parse(u.searchParams.get('to_date')) > Date.now());
  assert.ok(Date.parse(u.searchParams.get('from_date')) < Date.now() - 59 * 864e5);
  assert.deepEqual(r.window, { from_date: u.searchParams.get('from_date'), to_date: u.searchParams.get('to_date') });
  assert.equal(Object.keys(r)[0], 'window');
  await callTool('list_runs_rest', { login: 'agency', from_date: '2026-11-01T00:00:00Z' });
  assert.equal(new URL(restUrl).searchParams.get('from_date'), '2026-11-01T00:00:00Z');
});

// ---- loop r2 I-3: task_usage (BillableTaskUsage) and list_apps (AppsWithCurrentImplementationId) ----
// Redacted live shapes (2026-11-12).
const topEdge = (z, n) => ({ apps: ['AppOneCLIAPI@1.0.0', 'FilterAPI'], billableTasks: n, lastRun: '2026-11-12T15:00:00.000Z', zap: { id: String(z), isEnabled: true, owner: { id: '900000002', imageUrl: null, name: 'Owner Name' }, title: 'Client A | zap ' + z }, zapId: String(z) });
const USAGE = {
  billableTaskUsage: { interval: 'month', tasksByDate: [{ billableCount: 100, date: '2026-10-01' }, { billableCount: 50, date: '2026-11-01' }], totalBillableCount: 150 },
  billableTopZaps: { deletedZaps: null, edges: [topEdge(1, 100), topEdge(5, 50)], totalMatchedZapCount: 2 },
};
const APPS = [{ currentImplementation: { id: 'AppOneCLIAPI@1.0.0' }, id: '900000010', images: { url16X16: 'u' }, name: 'App One', slug: 'app-one' }];
test('task_usage sends the captured BillableTaskUsage text with the default window; client mode passes only its zapIds and labels top Zaps', async () => {
  const r = await callTool('task_usage', { client: 'acme' });
  const b = gqlBodies.find((x) => x.operationName === 'BillableTaskUsage');
  assert.match(b.query, /^query BillableTaskUsage\( \$apps: \[String!\] /);
  assert.match(b.query, /billableTopZaps\( customuserIds: \$customuserIds periodEnd: \$periodEnd periodStart: \$periodStart zapIds: \$zapIds \)/);
  assert.deepEqual(gqlVars.zapIds.sort(), ['1', '2', '4']);
  assert.ok(gqlVars.periodStart && gqlVars.periodEnd);
  assert.deepEqual(Object.keys(r).slice(0, 2), ['warnings', 'window']);
  assert.equal(r.window.periodStart, gqlVars.periodStart);
  assert.equal(r.totalBillableCount, 150);
  assert.equal(r.topZaps.find((e) => e.zapId === '1').ownership, 'client');
  assert.equal(r.topZaps.find((e) => e.zapId === '5').ownership, 'login-wide');
});
test('task_usage with login only is login-wide and sends no zapIds', async () => {
  const r = await callTool('task_usage', { login: 'agency', periodStart: '2026-11-01T00:00:00Z' });
  assert.equal(gqlVars.zapIds, undefined);
  assert.equal(gqlVars.periodStart, '2026-11-01T00:00:00Z');
  assert.equal(r.scope.level, 'login');
});
test('list_apps sends the captured query with the fragment AFTER the query and names ids not found', async () => {
  const r = await callTool('list_apps', { login: 'agency', ids: ['AppOneCLIAPI@1.0.0', 'AppOneCLIAPI'] });
  const b = gqlBodies.find((x) => x.operationName === 'AppsWithCurrentImplementationId');
  assert.match(b.query, /^query AppsWithCurrentImplementationId\(\$ids: \[ID!\]!\) \{ appsByCurrentImplementationId\(ids: \$ids\) \{ \.\.\.AppResult \} \}\s+fragment AppResult on App /);
  assert.deepEqual(r.apps.map((a) => a.name), ['App One']);
  assert.ok(r.warnings.some((w) => /AppOneCLIAPI(?!@)/.test(w) && /versioned/.test(w)), JSON.stringify(r.warnings));
});

// ---- loop r2 I-4 + M-5: list_zaps on/off, folder, status/apps filters, apps deduped ----
test('list_zaps sends status and apps (string) filters to zap.searchZaps', async () => {
  await callTool('list_zaps', { login: 'agency', status: 'on', apps: 'AppOneCLIAPI' });
  assert.equal(searchZapsInputs.at(-1).status, 'on');
  assert.equal(searchZapsInputs.at(-1).apps, 'AppOneCLIAPI');
  await callTool('list_zaps', { client: 'acme', status: 'off' });
  assert.equal(searchZapsInputs.at(-1).status, 'off');
});
test('list_zaps rows carry isEnabled and folder {id,title} from GraphQL; apps deduped to versioned ids; no state key', async () => {
  const saved = ZAPS[0].apps;
  ZAPS[0].apps = ['SlackCLIAPI', 'SlackCLIAPI@1.39.3', 'FilterAPI'];
  try {
    for (const args of [{ login: 'agency' }, { client: 'acme' }, { login: 'agency', all: true }]) {
      const r = await callTool('list_zaps', args);
      const one = r.results.find((x) => String(x.id) === '1');
      assert.equal(one.isEnabled, true, JSON.stringify(args));
      assert.deepEqual(one.folder, { id: '10', title: 'F' });
      assert.ok(!('state' in one));
      const four = r.results.find((x) => String(x.id) === '4');
      assert.deepEqual(four.apps, ['SlackCLIAPI@1.39.3', 'FilterAPI']);
      assert.equal(four.isEnabled, false);
    }
  } finally { ZAPS[0].apps = saved; }
});
test('list_zaps: hydration failure is a warning with isEnabled/folder null, not a crash', async () => {
  zapGqlFail = true;
  const r = await callTool('list_zaps', { login: 'agency' });
  assert.ok(r.warnings.some((w) => /on\/off and folder could not be read/.test(w)), JSON.stringify(r.warnings));
  assert.ok(r.results.every((x) => x.isEnabled === null && x.folder === null));
});

// ---- loop r4 I-1 step 3: the claim map's Zap list is ONE trpc zap.searchZaps call (500 rows); GraphQL only as fallback ----
test('claim map reads the Zap list from one trpc zap.searchZaps page of 500, not GraphQL ZapSearch', async () => {
  zapPage = 2;
  const r = await clientZapIds(target({ folderIds: ['10'], namePrefixes: ['acme -'] }));
  assert.deepEqual(r.ids.sort(), ['1', '2', '4']);
  assert.equal(searchZapsInputs.length, 1);
  assert.equal(searchZapsInputs[0].limit, 500);
  assert.equal(gqlBodies.filter((b) => b.operationName === 'ZapSearch').length, 0);
});
test('claim map falls back to GraphQL ZapSearch (all cursor pages) when the trpc Zap list is unavailable', async () => {
  trpcDead = true; zapPage = 2; // 5 Zaps over 3 pages
  const r = await clientZapIds(target({ folderIds: ['10'], namePrefixes: ['acme -'] }));
  assert.deepEqual(r.ids.sort(), ['1', '4']);
  assert.equal(gqlBodies.filter((b) => b.operationName === 'ZapSearch').length, 3);
});
test('folder reads failing (trpc token expired, renewal refused) -> direct-folder + prefix claims with a loud warning naming the unchecked folders', async () => {
  trpcDead = true;
  const r = await clientZapIds(target({ folderIds: ['10'], namePrefixes: ['acme -'] }));
  assert.deepEqual(r.ids.sort(), ['1', '4']); // 1: directly in folder 10 (GraphQL container); 4: prefix; 2 sits in subfolder 11 -> not found
  const w = r.warnings.find((x) => /FOLDER READS FAILED/.test(x));
  assert.ok(w, JSON.stringify(r.warnings));
  assert.match(w, /folder 10/); assert.match(w, /subfolders/); assert.match(w, /node login\.mjs agency/);
  const z = await callTool('list_zaps', { client: 'acme' });
  assert.ok(z.warnings.some((x) => /FOLDER READS FAILED/.test(x)));
});
test('folder reads failing for a folder-only client is never a silent empty list', async () => {
  trpcDead = true;
  await withReg((reg) => { reg.clients.other.folderIds = ['40']; }, async () => {
    const r = await callTool('search_runs', { client: 'other' });
    assert.ok(r.warnings.some((x) => /FOLDER READS FAILED/.test(x)) && r.warnings.some((x) => /no Zaps found for client other/.test(x)), JSON.stringify(r.warnings));
  });
});

// ---- loop r2 M-1: REST zap_title is the trigger step's title, not the Zap title ----
test('get_run and compact list_runs_rest rows call it trigger_title, not zap_title', async () => {
  const r = await callTool('get_run', { login: 'agency', runId: RUN_ID });
  assert.equal(r.trigger_title, 'Trigger: Booking Cancelled');
  assert.ok(!('zap_title' in r));
  const l = await callTool('list_runs_rest', { login: 'agency' });
  assert.equal(l.results[0].trigger_title, 'Trigger: X');
  assert.ok(!('zap_title' in l.results[0]));
  assert.match(tools.get_run.description, /trigger_title/);
});

// ---- loop r2 M-6 / I-7: list_tables says where its rows are, and that table rows are not mapped ----
test('list_tables description: rows under data, meta.count; table rows and Storage not mapped', () => {
  assert.match(tools.list_tables.description, /`data`/);
  assert.match(tools.list_tables.description, /meta\.count/);
  assert.match(tools.list_tables.description, /tables\.zapier\.com/);
});

// ---- loop r4 I-1/I-2: the claim map is cached per login (TTL, keyed by registry contents + session) ----
const countingFetch = () => {
  const inner = globalThis.fetch; const c = { reads: 0 };
  globalThis.fetch = (url, init) => { if (/folderTree|getHydratedFolderAssets|zap\.searchZaps|ZapSearch/.test(String(url) + (init?.body ?? ''))) c.reads++; return inner(url, init); };
  return c;
};
test('claim map is built once per login: a second ownershipIndex within the TTL (any client on the login) makes no reads', async () => {
  const c = countingFetch();
  const a1 = await ownershipIndex(regTarget('acme'));
  const built = c.reads; assert.ok(built > 0);
  const a2 = await ownershipIndex(regTarget('acme'));
  const o = await ownershipIndex(regTarget('other'));
  assert.equal(c.reads, built);
  assert.deepEqual(a2.clientIds.sort(), a1.clientIds.sort());
  assert.deepEqual(o.clientIds, ['3']);
  assert.equal(a2.ownershipOf(3).ownership, 'other-client');
});
test('claim map cache: clients.json change, TTL expiry and a degraded (trpc expired) build all rebuild', async () => {
  const c = countingFetch();
  await ownershipIndex(regTarget('acme'));
  let n = c.reads;
  await withReg((r) => { r.clients.other.folderIds = ['40']; }, async () => {
    const o = await ownershipIndex(regTarget('other'));
    assert.ok(c.reads > n, 'registry change rebuilds');
    assert.deepEqual(o.clientIds, []);
  });
  n = c.reads;
  const realNow = Date.now;
  try {
    await ownershipIndex(regTarget('acme')); // registry restored -> new key -> rebuild
    n = c.reads;
    Date.now = () => realNow() + scope.CLAIM_MAP_TTL_MS + 1000;
    await ownershipIndex(regTarget('acme'));
    assert.ok(c.reads > n, 'TTL expiry rebuilds');
  } finally { Date.now = realNow; }
  scope._resetScopeCache();
  trpcDead = true;
  await ownershipIndex(regTarget('acme'));
  n = c.reads;
  await ownershipIndex(regTarget('acme'));
  assert.ok(c.reads > n, 'a degraded build is not cached');
});
test('client-scoped results say when the claim map was built (scope.claim_map_built_at)', async () => {
  const before = Date.now();
  const r1 = await callTool('list_zaps', { client: 'acme' });
  const r2 = await callTool('search_runs', { client: 'acme' });
  assert.match(r1.scope.claim_map_built_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(r2.scope.claim_map_built_at, r1.scope.claim_map_built_at);
  assert.ok(Date.parse(r1.scope.claim_map_built_at) >= before - 1000);
  const l = await callTool('list_folders', { client: 'acme' });
  assert.ok(!('claim_map_built_at' in l.scope));
});
test('folder assets are read with bounded concurrency (4), each folder once', async () => {
  const kids = TREE.tree[0].children; const saved = [...kids];
  for (let i = 0; i < 8; i++) kids.push({ id: 200 + i, name: 'S', assetCount: 0, children: [] });
  const inner = globalThis.fetch; let inFlight = 0, peak = 0; const seen = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('getHydratedFolderAssets')) return inner(url, init);
    seen.push(JSON.parse(new URL(String(url)).searchParams.get('input')).folderId);
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 15));
    try { return await inner(url, init); } finally { inFlight--; }
  };
  try {
    const r = await clientZapIds(regTarget('acme'));
    assert.deepEqual(r.ids.sort(), ['1', '2', '4']);
    assert.equal(peak, 4);
    assert.equal(new Set(seen).size, seen.length);
  } finally { kids.length = 0; kids.push(...saved); }
});

// ---- loop r4 M-1: list_zaps excluded does not depend on the on/off filter; the cached Zap list is reused ----
test('list_zaps (client) excluded is the same with status on, off or none', async () => {
  const none = await callTool('list_zaps', { client: 'acme' });
  const on = await callTool('list_zaps', { client: 'acme', status: 'on' });
  const off = await callTool('list_zaps', { client: 'acme', status: 'off' });
  assert.deepEqual(none.excluded, { login_wide: 1, other_client: 1, conflict: 0 });
  assert.deepEqual(on.excluded, none.excluded);
  assert.deepEqual(off.excluded, none.excluded);
  assert.equal(on.count + off.count, none.count);
  assert.ok(on.results.every((r) => r.isEnabled === true) && off.results.every((r) => r.isEnabled === false));
});
test('list_zaps (client, no filter) reuses the claim map Zap list: one zap.searchZaps call in total', async () => {
  await callTool('list_zaps', { client: 'acme', all: true });
  await callTool('list_zaps', { client: 'acme', all: true });
  assert.equal(searchZapsInputs.length, 1);
});

// ---- loop r4 M-2: id arguments are validated, so '..' or slashes never reach a GET path ----
test('id arguments are checked against strict patterns before any request', async () => {
  const sent = []; const inner = globalThis.fetch;
  globalThis.fetch = (url, init) => { sent.push(String(url)); return inner(url, init); };
  const bad = [
    ['get_zap', { zapId: '..' }], ['get_zap', { zapId: '1/../2' }], ['list_zap_versions', { zapId: '%2e%2e' }],
    ['get_zap_version', { zapId: 4, versionId: '..' }], ['get_zap_version', { zapId: 4, versionId: 'a/b' }],
    ['get_run', { runId: '../held-count' }], ['get_run', { runId: 'x' }],
    ['step_gives', { zapId: 1, stepId: '..', runId: RUN_ID }], ['step_gives', { zapId: 1, stepId: 7, runId: '../..' }],
    ['folder_assets', { folderId: '../x' }], ['search_runs', { zapIds: ['1', '..'] }], ['list_runs_rest', { zap_ids: ['a/b'] }],
  ];
  for (const [name, args] of bad) await assert.rejects(callTool(name, { login: 'agency', ...args }), /Invalid|must be|pattern/i, `${name} ${JSON.stringify(args)}`);
  assert.deepEqual(sent, []);
  // Real shapes pass: numeric Zap/step ids, UUID run/version ids, UUID or numeric folder ids.
  await callTool('get_zap_version', { login: 'agency', zapId: 4, versionId: RUN_ID.toUpperCase() });
  await callTool('step_gives', { login: 'agency', zapId: '1', stepId: '7', runId: RUN_ID });
  await callTool('folder_assets', { login: 'agency', folderId: '0100000a-0000-4000-8000-000000000001' });
});
