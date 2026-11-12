// Tool definitions shared by server.mjs (MCP) and cli.mjs. All READ-ONLY.
import { z } from 'zod';
import { resolveTarget, loadRegistry } from './registry.mjs';
import { contactRuns } from './contact.mjs';
import { clientFolderSet, ownershipIndex, flattenTree, NO_ZAP_ID } from './scope.mjs';
import {
  qs,
  RUN_STATUSES, defaultPeriod,
  get, trpc, session, accountId, whoamiDetail, assertSessionMatchesRegistry, zapRuns, allZaps, allRuns, allVersions, versionsUrl,
} from './lib.mjs';

const enc = encodeURIComponent;
const id = (d) => z.union([z.string(), z.number()]).transform(String).describe(d);
const ids = (d) => z.array(z.union([z.string(), z.number()]).transform(String)).optional().describe(d);
const RUNS_NOTE = 'Run history retention is about 60 days; all times are UTC (the Zapier UI shows the account timezone).';

// step_errors on a live error run (2026-11-12) is ONE object {id, error_msg, title, code, status, version};
// an array is accepted too, absent/null means no error.
export const stepErrors = (se) => (se == null ? [] : Array.isArray(se) ? se : [se]).map((e) => e?.error_msg ?? e?.message ?? e);
function stepSummary(s) {
  return {
    step_id: s.step_id ?? s.id, parent_id: s.parent_id ?? null, app: s.app, action: s.action, title: s.title,
    status: s.status ?? null,
    errors: stepErrors(s.step_errors),
  };
}

export const tools = {
  zapier_whoami: {
    description: 'Who the saved Zapier session belongs to: email, user id, current account id, for the given login. Run this first if anything fails with SESSION_EXPIRED.',
    schema: {},
    handler: async (_a, L) => {
      const w = await L.whoamiDetail();
      return {
        is_logged_in: w.isLoggedIn, email: w.email, user_id: w.userId, current_account_id: w.sessionAccountId,
        login: L.login, registry_email: w.registryEmail, registry_account_id: w.registryAccountId, match: w.match,
        ...(w.match ? {} : { warning: 'Session does not match the registry for this login: every other tool refuses to run until fixed.' }),
      };
    },
  },

  list_clients: {
    description: "Clients in the registry (clients.json) with their login, account id, counts of mapped folders / name prefixes, and ghl: {server, locationIdCount, locationIds} (the client's GHL internal MCP server name and its GHL location ids) or null. scope.level is 'registry'. No Zapier call; does not read .zapier-client.",
    schema: {},
    handler: async () => {
      const reg = loadRegistry();
      return { scope: { level: 'registry' }, clients: Object.entries(reg.clients).map(([client, c]) => ({
        client, login: c.login, accountId: reg.logins[c.login]?.accountId ?? null,
        folderIds: (c.folderIds ?? []).length, namePrefixes: (c.namePrefixes ?? []).length,
        ghl: c.ghl ? { server: c.ghl.server, locationIdCount: (c.ghl.locationIds ?? []).length, locationIds: [...(c.ghl.locationIds ?? [])] } : null,
      })) };
    },
  },

  unmapped_folders: {
    description: "Folders in the login's tree that no client references (neither the folder nor any ancestor is in a client's folderIds). Use it to find Zaps that belong to nobody.",
    schema: {},
    handler: async (_a, L) => {
      const reg = loadRegistry();
      const mapped = new Set(Object.values(reg.clients).filter((c) => c.login === L.login).flatMap((c) => (c.folderIds ?? []).map(String)));
      const flat = flattenTree(await L.trpc('folder.folderTree', {}));
      const byId = new Map(flat.map((f) => [f.id, f]));
      const covered = (f) => { for (let n = f; n; n = byId.get(n.parentId)) if (mapped.has(n.id)) return true; return false; };
      return { login: L.login, folders: flat.filter((f) => !covered(f)) };
    },
  },

  list_zaps: {
    description: 'List Zaps (trpc zap.searchZaps). Rows carry a numeric `id` (use it for get_zap / runs) and a UUID `zapId`. `search` is the text filter (other filter keys are silently ignored by Zapier). Set all=true to page through everything (500 per page). With a client: only its Zaps, and `excluded: {login_wide, other_client, conflict}` counts the login Zaps left out, by ownership (all 0 with include_login_wide).',
    schema: {
      search: z.string().optional().describe('Text filter on Zap title etc.'),
      limit: z.number().int().min(1).max(500).optional().describe('Page size, default 100, max 500'),
      offset: z.number().int().min(0).optional(),
      order: z.string().optional().describe("Default '-updated_at'"),
      all: z.boolean().optional().describe('Page through every Zap'),
      compact: z.boolean().optional().describe('Default true: only id, zapId, title, state, apps, lastRunAt, folder'),
      include_login_wide: z.boolean().optional().describe("With a client: also return the login's other Zaps, labelled (default: only the client's Zaps)"),
    },
    handler: async ({ search, limit = 100, offset = 0, order = '-updated_at', all, compact = true, include_login_wide }, L) => {
      if (L.target?.client) {
        const idx = await L.ownership();
        const every = (await L.allZaps({ search, order })).results.map((r) => ({ ...r, ...idx.ownershipOf(r.id) }));
        const kept = include_login_wide ? every : every.filter((r) => r.ownership === 'client');
        const rows = all ? kept : kept.slice(offset, offset + limit);
        const pickC = (r) => ({ id: r.id, zapId: r.zapId, title: r.title, state: r.state ?? r.status ?? r.isEnabled ?? r.is_enabled, apps: (r.apps || []).map(a => a?.title || a?.name || a?.selectedApi || a), lastRunAt: r.lastRunAt, updatedAt: r.updatedAt ?? r.updated_at, folder: r.folder?.title ?? r.folderTitle ?? r.folderId ?? r.folder_id, ownership: r.ownership, label: r.label });
        const left = include_login_wide ? [] : every.filter((r) => r.ownership !== 'client');
        const excluded = { login_wide: 0, other_client: 0, conflict: 0 };
        for (const r of left) { const k = r.ownership.replace('-', '_'); excluded[k] = (excluded[k] ?? 0) + 1; }
        return { count: kept.length, excluded, returned: rows.length, ...(idx.warnings.length ? { warnings: idx.warnings } : {}), results: compact ? rows.map(pickC) : rows };
      }
      const page = all ? await L.allZaps({ search, order }) : await L.trpc('zap.searchZaps', { limit, offset, order, ...(search ? { search } : {}) });
      const rows = page?.results || [];
      const pick = (r) => ({
        id: r.id, zapId: r.zapId, title: r.title, state: r.state ?? r.status ?? r.isEnabled ?? r.is_enabled,
        apps: (r.apps || []).map(a => a?.title || a?.name || a?.selectedApi || a), lastRunAt: r.lastRunAt,
        updatedAt: r.updatedAt ?? r.updated_at, folder: r.folder?.title ?? r.folderTitle ?? r.folderId ?? r.folder_id,
      });
      return { count: page?.count, next: all ? null : page?.next, returned: rows.length, results: compact ? rows.map(pick) : rows };
    },
  },

  list_folders: {
    description: 'Folder tree (trpc folder.folderTree): nested folders with ids, names and assetCount. assetCount counts the folder AND all its subfolders, so it is larger than folder_assets for a folder with subfolders. Login-wide, not client-filtered.',
    schema: {},
    handler: async (_a, L) => L.trpc('folder.folderTree', {}),
  },

  folder_assets: {
    description: "Assets in one folder, not its subfolders (trpc asset.getHydratedFolderAssets): rows have type 'zap' or 'table'; a Zap row's id is a UUID, its numeric Zap id (for get_zap / runs) is searchZap.id. meta.count = this folder's own total. Login-wide, not client-filtered.",
    schema: { folderId: id('Folder id from list_folders'), limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() },
    handler: async ({ folderId, limit = 100, offset = 0 }, L) => L.trpc('asset.getHydratedFolderAssets', { folderId, limit, offset }),
  },

  get_zap: {
    description: 'One Zap definition (gulliver storage). Returns is_enabled, folder, and the steps (app, action, params = field mapping) from current_version.zdl; Zaps with current_version null (draft-only) use draft.zdl, and `source` (published or draft) says which. Optionally adds Zap settings (autoreplay, error ratio, flood protection, polling) and the catch-hook URL (subscriptions).',
    schema: {
      zapId: id('Numeric Zap id (list_zaps `id`)'),
      include_settings: z.boolean().optional().describe('Default true'),
      include_hook: z.boolean().optional().describe('Default true: catch-hook URL + trigger_type'),
      raw: z.boolean().optional().describe('Return the full Zapier object instead of the merged view'),
    },
    handler: async ({ zapId, include_settings = true, include_hook = true, raw }, L) => {
      const A = await L.accountId();
      const z0 = await L.get(`/api/gulliver/storage/v1/zaps/${enc(zapId)}?account_id=${A}`);
      const out = raw ? { zap: z0 } : (() => {
        const src = z0.current_version ? 'published' : (z0.draft ? 'draft' : null);
        const ver = src === 'published' ? z0.current_version : (src === 'draft' ? z0.draft : null);
        const { current_version, draft, ...rest } = z0;
        return {
          ...rest, source: src, version_id: ver?.id ?? null,
          has_unpublished_draft: !!(z0.current_version && z0.draft),
          steps: ver?.zdl?.steps ?? null,
        };
      })();
      const extra = async (key, url) => { try { out[key] = await L.get(url); } catch (e) { out[key] = { error: e.message }; } };
      if (include_settings) await extra('settings', `/api/gulliver/zapsettings/v1/zaps/${enc(zapId)}/settings?account_id=${A}`);
      if (include_hook) await extra('subscriptions', `/api/gulliver/steptesting/v1/zaps/${enc(zapId)}/subscriptions?account_id=${A}`);
      return out;
    },
  },

  list_zap_versions: {
    description: 'Version history of a Zap (who/when changed it). Cursor-paged 25 per page via meta.next_cursor; no zdl in the list (use get_zap_version). all=true walks every page.',
    schema: { zapId: id('Numeric Zap id'), all: z.boolean().optional().describe('Walk all cursor pages (default true)'), cursor: z.string().optional().describe('meta.next_cursor from a previous page (only when all=false)') },
    handler: async ({ zapId, all = true, cursor }, L) => {
      if (all) return L.allVersions(zapId);
      return L.get(versionsUrl(zapId, await L.accountId(), cursor));
    },
  },

  get_zap_version: {
    description: 'One Zap version including its zdl (steps + params) — compare with get_zap to see what changed.',
    schema: { zapId: id('Numeric Zap id'), versionId: id('Version id from list_zap_versions') },
    handler: async ({ zapId, versionId }, L) => L.get(`/api/gulliver/storage/v1/zaps/${enc(zapId)}/versions/${enc(versionId)}?account_id=${await L.accountId()}`),
  },

  search_runs: {
    description: `Search Zap runs (Zap History) via the reporting GraphQL ZapRuns query. ${RUNS_NOTE} Default window: now-60d to now+1d (periodEnd must be in the future or today's UTC runs are dropped — this tool handles that). Sorted newest first only ('-start_time'; ascending is ignored — use list_runs_rest for oldest-first). \`query\` is whole-word, case-insensitive, and ALL words must match; email/phone searches are the reliable ones — always confirm a hit with get_run. limit max 100; totalCount caps at 10000 and totalActionable at 5000. status values: ${RUN_STATUSES.join(', ')} ('running' is rejected). With client and no zapIds the search is scoped to that client's Zaps. Set all=true to page everything (warns at the 10000 cap). apps/channel/channelError/customuserIds/heldReasons/heldStaleAuthIds exist on the API but their GraphQL types are unverified.`,
    schema: {
      zapIds: ids('Numeric Zap ids'), folderIds: ids('Folder ids'),
      status: z.array(z.enum(RUN_STATUSES)).optional(),
      query: z.string().optional().describe('Whole-word search in run data (e.g. an email or phone)'),
      periodStart: z.string().optional().describe('ISO UTC; default now-60d'),
      periodEnd: z.string().optional().describe('ISO UTC; default now+1d (keep it in the future)'),
      limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(),
      all: z.boolean().optional().describe('Page through all matches (100 per call)'),
      max: z.number().int().min(1).max(10000).optional().describe('Cap for all=true, default 2000'),
      apps: z.array(z.string()).optional(), channel: z.string().optional(), channelError: z.string().optional(),
      include_login_wide: z.boolean().optional().describe("With a client: keep (and label: login-wide | other-client | conflict) runs of Zaps that are not the client's instead of excluding them"),
      customuserIds: ids('Owner (member) ids'), heldReasons: z.array(z.string()).optional(), heldStaleAuthIds: ids('Stale auth ids'),
    },
    handler: async ({ all, max = 2000, include_login_wide, ...v }, L) => {
      let idx; const warnings = [];
      if (L.target?.client) {
        idx = await L.ownership(); warnings.push(...idx.warnings);
        if (!include_login_wide) {
          const mine = new Set(idx.clientIds);
          const asked = v.zapIds;
          if (asked) {
            for (const z of asked.filter((z) => !mine.has(z))) warnings.push(`zap ${z} excluded: ${idx.ownershipOf(z).label}`);
            v.zapIds = asked.filter((z) => mine.has(z));
          } else v.zapIds = idx.clientIds;
          if (v.folderIds) {
            const allowed = await clientFolderSet(L.target);
            for (const f of v.folderIds.filter((f) => !allowed.has(f))) warnings.push(`folder ${f} excluded: not one of ${L.target.client}'s folders`);
            v.folderIds = v.folderIds.filter((f) => allowed.has(f));
            if (!v.folderIds.length) delete v.folderIds;
          }
          if (!v.zapIds.length) {
            const why = asked?.length && idx.clientIds.length
              ? `none of the requested zapIds belong to ${L.target.client}: all ${asked.length} excluded (see above); nothing searched`
              : `no Zaps found for client ${L.target.client}; nothing searched`;
            return { warnings: [...warnings, why], client: L.target.client, scopedZapIds: 0, edges: [] };
          }
        }
      }
      const label = (r) => (idx && r?.edges ? { ...r, edges: r.edges.map((e) => ({ ...e, ...idx.ownershipOf(e.zap?.id) })) } : r);
      const d = defaultPeriod();
      const vars = { ...v, periodStart: v.periodStart || d.periodStart, periodEnd: v.periodEnd || d.periodEnd };
      const window = { periodStart: vars.periodStart, periodEnd: vars.periodEnd };
      const r = all ? await L.allRuns(vars, { max }) : await L.zapRuns({ limit: 50, ...vars });
      // warnings (scope + paging, merged) and window first, so output truncation never cuts them.
      const { warnings: pageWarnings = [], ...rest } = r || {};
      const merged = [...warnings, ...pageWarnings];
      return { ...(merged.length ? { warnings: merged } : {}), window, ...label(rest) };
    },
  },

  list_runs_rest: {
    description: `Zap runs via REST (/api/zap-history/v2/runs). Unlike search_runs this supports ascending order (order_by e.g. 'start_time' or '-start_time') and returns stop_reason / held_reason per run. Returns meta.count + runs. ${RUNS_NOTE} limit max 100. List filters are sent comma-joined.`,
    schema: {
      zap_ids: ids('Numeric Zap ids'), statuses: z.array(z.string()).optional(), query: z.string().optional(),
      from_date: z.string().optional().describe('ISO UTC'), to_date: z.string().optional().describe('ISO UTC (keep in the future to include today)'),
      limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(),
      order_by: z.string().optional().describe("e.g. 'start_time' (oldest first) or '-start_time'"),
      include_login_wide: z.boolean().optional().describe("With a client: do not restrict to the client's Zaps; every run is labelled by owner"),
    },
    handler: async ({ limit = 50, offset = 0, include_login_wide, ...p }, L) => {
      const call = async (q) => L.get(`/api/zap-history/v2/runs${qs({ account_id: await L.accountId(), limit, offset, ...q })}`);
      if (!L.target?.client) return call(p);
      const idx = await L.ownership();
      const warnings = [...idx.warnings];
      if (!include_login_wide) {
        const mine = new Set(idx.clientIds);
        const asked = p.zap_ids;
        const keep = asked ? asked.filter((z) => mine.has(z)) : idx.clientIds;
        if (asked) for (const z of asked.filter((z) => !mine.has(z))) warnings.push(`zap ${z} excluded: ${idx.ownershipOf(z).label}`);
        if (!keep.length) {
          const why = asked?.length && idx.clientIds.length
            ? `none of the requested zap_ids belong to ${L.target.client}: all ${asked.length} excluded (see above); nothing listed`
            : `no Zaps found for client ${L.target.client}; nothing listed`;
          return { warnings: [...warnings, why], meta: { count: 0 }, runs: [] };
        }
        p = { ...p, zap_ids: keep };
      }
      const r = await call(p);
      const label = (run) => ({ ...run, ...idx.ownershipOf(run.zap_id ?? run.zap?.id) });
      return { ...(warnings.length ? { warnings } : {}), ...r, runs: (r?.runs || []).map(label) };
    },
  },

  get_run: {
    description: 'One run in detail (/api/zap-history/v2/runs/{runId}). Summary: status, stop_reason (a Filter stop shows its rules in stop_reason.rule_dumps), held_reason, delayed_reason, has_paths, can_replay, replay_count, start/end_time (UTC), zap_version_id, and each step (step_id, parent_id — Paths branches hang under BranchingAPI steps; status null/skipped = branch not run — app, action, errors). full=true adds every step input (sent) and output (received). A wrong run id gives RUN_NOT_FOUND.',
    schema: { runId: id('Run id from search_runs / list_runs_rest'), full: z.boolean().optional().describe('Include step input/output') },
    handler: async ({ runId, full }, L) => {
      let r;
      try { r = await L.get(`/api/zap-history/v2/runs/${enc(runId)}?account_id=${await L.accountId()}`); } catch (e) {
        if (e.status === 500 || e.status === 404) throw Object.assign(new Error(`RUN_NOT_FOUND ${runId}`), { code: 'RUN_NOT_FOUND' });
        throw e;
      }
      const keys = ['id', 'zap_id', 'zap_title', 'status', 'stop_reason', 'held_reason', 'delayed_reason', 'has_paths', 'can_replay', 'replay_count', 'start_time', 'end_time', 'zap_version_id'];
      const out = {};
      for (const k of keys) if (k in r) out[k] = r[k];
      out.steps = (r.steps_executions || []).map(s => full ? { ...stepSummary(s), input: s.input, output: s.output } : stepSummary(s));
      return out;
    },
  },

  held_counts: {
    description: 'Held-run counts grouped by reason (/api/zap-history/v2/runs/held-count). Login-wide, not client-filtered.',
    schema: {},
    handler: async (_a, L) => L.get(`/api/zap-history/v2/runs/held-count?account_id=${await L.accountId()}&group_by=reason&include_shared_with=false`),
  },

  step_gives: {
    description: 'Fields (keys + sample values) a step produced in a given run — handy to see exactly what a trigger handed to later steps. Note: this endpoint was captured without account_id and is called that way (whether it accepts account_id is unverified), so it reads the session\'s current account. That account was verified against the registry at most 60 s earlier (the session check is cached for 60 s), not on this exact call.',
    schema: { zapId: id('Numeric Zap id'), stepId: id('step_id from get_run / get_zap'), runId: id('Run id') },
    handler: async ({ zapId, stepId, runId }, L) => L.get(`/api/gulliver/steptesting/v1/zaps/${enc(zapId)}/steps/${enc(stepId)}/output/run/${enc(runId)}/gives`),
  },

  list_connections: {
    description: "App connections (trpc authentication.authentications): rows carry title, isStale, zapCount. Login-wide, not client-filtered. status: 'active' | 'expired' | 'all'. limit max 100.",
    schema: {
      status: z.enum(['active', 'expired', 'all']).optional().describe("Default 'all'"),
      search: z.string().optional(), selectedApi: z.string().optional(), owner: z.string().optional(), ordering: z.string().optional(),
      includeZapCount: z.boolean().optional().describe('Default true'),
      limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(),
    },
    handler: async ({ status = 'all', includeZapCount = true, limit = 100, offset = 0, ...rest }, L) => {
      const input = { includeZapCount, limit, offset, status };
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) input[k] = v;
      return L.trpc('authentication.authentications', input);
    },
  },

  contact_runs: {
    description: "Every run that touched one contact (give exactly one of email or phone) in the client's Zaps AND the rest of the login's Zaps, labelled by owner (client | login-wide | other-client | conflict | unknown). Searches Zap History, then keeps only runs whose step data contains the exact email (case-insensitive) or the phone's last 10 digits (a phone needs at least 10 digits; it is searched as NNNNNNNNNN, 1NNNNNNNNNN and 'NNN NNN NNNN', because Zapier's search tokenizes stored phones). Sorted oldest first. Requires a client. Output starts with `warnings` and `window` (the periodStart/periodEnd actually searched; quote it): zero runs means none found in that window, never proof of no activity. Warns when periodStart is older than ~60-day retention, when candidate runs are skipped over the 300-detail cap (naming their startTime range), how many candidates did not contain the exact contact, and that phone formats other than those three are unproven. " + RUNS_NOTE,
    schema: {
      email: z.string().optional().describe('Contact email (exact match)'),
      phone: z.string().optional().describe('Contact phone, any format; matched on the last 10 digits'),
      periodStart: z.string().optional().describe('ISO UTC; default now-60d'),
      periodEnd: z.string().optional().describe('ISO UTC; default now+1d'),
    },
    handler: async (a, L) => {
      if (!L.target?.client) throw new Error('contact_runs requires a client (client name from clients.json or a .zapier-client file)');
      return contactRuns(L.target, a);
    },
  },

  list_members: {
    description: 'Account members (/api/v4/accounts/{A}/members) — maps zapOwner / customuser ids to names. Login-wide, not client-filtered.',
    schema: {},
    handler: async (_a, L) => L.get(`/api/v4/accounts/${await L.accountId()}/members`),
  },

  list_tables: {
    description: "Zapier Tables (trpc table.search, kind 'both'). Login-wide, not client-filtered.",
    schema: { limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional(), orderBy: z.string().optional() },
    handler: async ({ limit = 100, offset = 0, orderBy }, L) => L.trpc('table.search', { limit, offset, kind: 'both', ...(orderBy ? { orderBy } : {}) }),
  },
};

// Every tool takes an optional `client` or `login`. There is no default login: with neither (and no
// .zapier-client file walking up from the cwd) the call fails and lists the known clients and logins.
const LOGIN_ARG = z.string().optional().describe("Saved Zapier login name from clients.json. Login only = login-wide results (scope.level 'login'). With client, it must be that client's login or be left out");
const CLIENT_ARG = z.string().optional().describe('Client name from clients.json (or a .zapier-client file): selects its login and account');
for (const t of Object.values(tools)) t.schema = { client: CLIENT_ARG, login: LOGIN_ARG, ...t.schema };

// Lib functions with the login bound as first argument.
function bind(login, target) {
  let own;
  return {
    login, target, ownership: () => (own ??= ownershipIndex(target)),
    get: (...a) => get(login, ...a), trpc: (...a) => trpc(login, ...a), session: () => session(login),
    accountId: () => accountId(login), whoamiDetail: () => whoamiDetail(login), zapRuns: (...a) => zapRuns(login, ...a), allZaps: (...a) => allZaps(login, ...a),
    allRuns: (...a) => allRuns(login, ...a), allVersions: (...a) => allVersions(login, ...a),
  };
}

// Login-level resources: not filtered by client, and labelled so. Zap-level tools: result gets ownership + label of that Zap.
for (const n of ['list_folders', 'folder_assets', 'list_connections', 'list_members', 'list_tables', 'held_counts']) tools[n].level = 'login';
tools.get_zap.zapOf = (a) => a.zapId;
tools.get_run.zapOf = (a, r) => r?.zap_id;
tools.get_run.noZapLabel = NO_ZAP_ID.label;
tools.list_zap_versions.zapOf = (a) => a.zapId;
tools.get_zap_version.zapOf = (a) => a.zapId;
tools.step_gives.zapOf = (a) => a.zapId;

// TODO (not exposed): GraphQL BillableTaskUsage and AppsWithCurrentImplementationId exist on
// /api/reporting/graphql, but their query texts were not captured. Do not invent them — capture the
// real query text from the browser's network tab first, then add tools here.

// Output size control
export const MAX_CHARS = Number(process.env.ZAPIER_MCP_MAX_CHARS || 60000);
export function renderResult(value, max = MAX_CHARS) {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n…[TRUNCATED: showed ${max} of ${text.length} chars. Narrow the call (limit/offset, a filter, compact view, or full=false) to see the rest.]`;
}

export async function callTool(name, args = {}) {
  const t = tools[name];
  if (!t) throw Object.assign(new Error(`UNKNOWN_TOOL: ${name}. Known: ${Object.keys(tools).join(', ')}`), { code: 'UNKNOWN_TOOL' });
  const parsed = z.object(t.schema).strict().parse(args ?? {});
  const { client, login: loginArg, ...rest } = parsed;
  if (name === 'list_clients') return t.handler(rest, bind(null, null));
  // No silent fallback: client (or a .zapier-client file) selects the login; login alone is login-wide.
  let target = null; let login = loginArg;
  if (client || !loginArg) { target = resolveTarget({ client, login: loginArg }, process.cwd()); login = target.login; }
  if (name !== 'zapier_whoami') await assertSessionMatchesRegistry(login);
  const L = bind(login, target);
  const result = await t.handler(rest, L);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  // warnings and window go first in every output, so the 60k-char truncation never cuts them.
  const { warnings: resultWarnings, window, ...body } = result;
  const front = (warnings, scope, extra = {}) => ({
    ...(warnings?.length ? { warnings } : {}), ...(window ? { window } : {}), scope, ...extra, ...body,
  });
  if (t.level === 'login' || !target?.client) return front(resultWarnings, { client: target?.client ?? null, login, level: 'login' });
  const extra = {}; let warnings = resultWarnings;
  if (t.zapOf) {
    const idx = await L.ownership();
    // Zap-level results carry the client's scope warnings (e.g. a mapped folder not found, a conflict).
    if (idx.warnings.length) warnings = [...new Set([...idx.warnings, ...(resultWarnings || [])])];
    const zid = t.zapOf(rest, result);
    Object.assign(extra, zid != null ? idx.ownershipOf(zid) : { ownership: 'unknown', label: t.noZapLabel ?? 'no Zap id — ownership unknown' });
  }
  return front(warnings, { client: target.client, login }, extra);
}
