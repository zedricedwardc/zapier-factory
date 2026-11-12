// Client scoping: which Zap ids belong to a registry client (folders recursively + title prefixes),
// and who owns any given Zap (this client / another client / a conflict / login-wide).
//
// ONE claim map per login, across every registry client on it:
//   - a folder claim beats a prefix claim;
//   - among folder claims the deepest (most specific) mapped folder wins;
//   - a tie left after that (same folder, same-depth folders, or prefix-only matches by 2+ clients) is a
//     'conflict': the Zap belongs to nobody, every involved client gets a warning, and it is excluded
//     from every client's conclusions until clients.json is fixed.
// clientZapIds and ownershipIndex read the same map, so they always agree.
import { trpc, allZaps, allZapsGql, sessionGen } from './lib.mjs';
import { loadRegistry } from './registry.mjs';

// Flatten the nested folder tree into [{id, name, assetCount, parentId}].
export function flattenTree(tree) {
  const out = [];
  const walk = (nodes, parentId) => {
    for (const n of nodes || []) {
      out.push({ id: String(n.id), name: n.name, assetCount: n.assetCount, parentId });
      walk(n.children, String(n.id));
    }
  };
  walk(Array.isArray(tree) ? tree : tree?.tree, null);
  return out;
}

// Folder asset rows (asset.getHydratedFolderAssets, verified live 2026-11-12): { meta: {count, limit, offset},
// links, results: [...] }. Each row has `type` 'zap' | 'table'. A Zap row's `id` is a UUID that embeds the
// numeric Zap id (00000000-0000-c000-8000-000900000001 -> 900000001); the numeric id is also in
// searchZap.id and currentVersion.zapId / draft.zapId. Limit is honoured (a page can be shorter than it).
const assetType = (a) => String(a?.type ?? '').toLowerCase();
const ZAP_UUID = /^00000000-0000-c000-8000-(\d{12})$/i;
export function assetZapId(a) {
  for (const v of [a?.searchZap?.id, a?.currentVersion?.zapId, a?.draft?.zapId]) {
    if (v != null && /^\d+$/.test(String(v))) return String(Number(v));
  }
  const m = ZAP_UUID.exec(String(a?.id ?? ''));
  return m ? String(Number(m[1])) : null;
}

// All assets of one folder (that folder only, not its subfolders). Paging stops on an empty page or once
// meta.count is reached; a response without `results` is a warning (not a silent 0).
async function folderZapIds(login, folder, { pageSize = 100, maxPages = 200 } = {}) {
  const ids = []; const warnings = []; let assets = 0; let readOk = true; let unknown = 0; const noId = [];
  for (let page = 0; ; page++) {
    if (page >= maxPages) { warnings.push(`folder ${folder.id}: stopped after ${maxPages} pages (${assets} assets read)`); readOk = false; break; }
    const p = await trpc(login, 'asset.getHydratedFolderAssets', { folderId: folder.id, limit: pageSize, offset: assets }); // offset = rows read so far
    if (!Array.isArray(p?.results)) {
      readOk = false;
      if (folder.assetCount !== 0) warnings.push(`folder ${folder.id}: folder assets response has no results key (folder tree assetCount ${folder.assetCount ?? 'unknown'}) — its Zaps were not read`);
      break;
    }
    const rows = p.results;
    if (!rows.length) break;
    assets += rows.length;
    for (const a of rows) {
      const t = assetType(a);
      if (t === 'table') continue;
      if (t !== 'zap') { unknown++; continue; }
      const z = assetZapId(a);
      if (z) ids.push(z); else noId.push(String(a?.id));
    }
    const total = [p.meta?.count, p.count, p.total].find((x) => typeof x === 'number');
    if (total !== undefined && assets >= total) break;
  }
  if (unknown) warnings.push(`folder ${folder.id}: ${unknown} assets of unknown type ignored (expected type zap or table)`);
  if (noId.length) warnings.push(`folder ${folder.id}: ${noId.length} Zap assets without a numeric Zap id (asset ids: ${noId.join(', ')})`);
  return { ids, assets, readOk, warnings };
}

export const FOLDER_CONCURRENCY = 4;
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const childrenMap = (flat) => {
  const kids = new Map();
  for (const f of flat) kids.set(f.parentId, [...(kids.get(f.parentId) || []), f.id]);
  return kids;
};
const descendants = (kids, root) => {
  const out = []; const stack = [root];
  while (stack.length) { const f = stack.pop(); out.push(f); stack.push(...(kids.get(f) || [])); }
  return out;
};
const depthOf = (byId, id) => { let d = 0; for (let n = byId.get(id); n?.parentId != null; n = byId.get(n.parentId)) d++; return d; };
const names = (list) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
export const NO_ZAP_ID = Object.freeze({ ownership: 'unknown', label: 'run has no zap_id — ownership unknown' });
export const conflictLabel = (clients) => `claimed by ${names(clients)} — fix clients.json; excluded from conclusions`;
// Every ownership label, in one place (the README quotes these exactly; a test checks it).
export const LABELS = Object.freeze({
  client: (client) => `${client}'s Zap`,
  loginWide: (login, client) => `${login}-wide Zap, not ${client}'s`,
  otherClient: (other, client) => `belongs to ${other} — excluded from ${client} conclusions`,
  conflict: conflictLabel,
});

// Every registry client on the target's login, with the target's own folders/prefixes for its name.
function loginClients(target) {
  const reg = loadRegistry();
  const me = target.client ?? '(target)';
  const clients = new Map();
  for (const [n, c] of Object.entries(reg.clients)) if (c.login === target.login) clients.set(n, { folderIds: (c.folderIds ?? []).map(String), namePrefixes: c.namePrefixes ?? [] });
  clients.set(me, { folderIds: (target.folderIds ?? []).map(String), namePrefixes: target.namePrefixes ?? [] });
  return { me, clients };
}

// The claim map of one login: zapId -> owning client name, or { conflict: [names] }, plus every client's warnings.
// It is the same for every client on the login, so it is built once and cached (see loginClaims below).
async function buildClaims(login, clients) {
  const all = [...clients.keys()];
  const warnings = new Map(all.map((c) => [c, []]));
  const warn = (who, w) => { for (const c of [who].flat()) { const l = warnings.get(c); if (l && !l.includes(w)) l.push(w); } };
  let degraded = false;
  const anyFolders = [...clients.values()].some((c) => c.folderIds.length);
  const anyPrefixes = [...clients.values()].some((c) => c.namePrefixes.length);
  // The Zap list (id, title): one trpc zap.searchZaps call (500 rows per page, ~1.5 s live). When the trpc token is
  // expired and cannot be renewed, the reporting GraphQL ZapSearch (session auth, 25 per page, ~11 s for ~300 Zaps)
  // is the fallback; it also carries each Zap's own folder, which the degraded folder claims below need.
  let zaps = null; let zapsSource = null; let trpcRows = null; // trpcRows: the raw zap.searchZaps rows (list_zaps reuses them)
  const gqlList = async () => {
    const list = await allZapsGql(login);
    zaps = list.results; zapsSource = 'graphql';
    if (!list.complete) warn(all, `the account's Zap list stopped before its end (${zaps.length} of ${list.totalCount} read): Zaps beyond that are not claimed`);
  };
  if (anyFolders || anyPrefixes) {
    try {
      const list = await allZaps(login);
      trpcRows = list.results;
      zaps = list.results.filter((z) => z?.id != null).map((z) => ({ ...z, id: String(z.id) })); zapsSource = 'trpc';
      if (zaps.length < list.count) warn(all, `the account's Zap list stopped before its end (${zaps.length} of ${list.count} read): Zaps beyond that are not claimed`);
    } catch (e) {
      if (e.code !== 'TRPC_TOKEN_EXPIRED') throw e;
      await gqlList();
    }
  }
  const zapIdSet = new Set((zaps ?? []).filter((z) => z.id != null).map((z) => String(z.id)));

  const folderClaims = new Map(); // zapId -> Map(client -> depth of its deepest mapped folder holding it)
  if (anyFolders) {
   try {
    const flat = flattenTree(await trpc(login, 'folder.folderTree', {}));
    const byId = new Map(flat.map((f) => [f.id, f]));
    const kids = childrenMap(flat);
    const read = new Map(); // folderId -> promise of folderZapIds (each folder read once)
    const readFolder = (id) => { if (!read.has(id)) read.set(id, folderZapIds(login, byId.get(id))); return read.get(id); };
    // Every mapped folder and its descendants, read FOLDER_CONCURRENCY at a time (one at a time took ~1 s each live).
    const wanted = [...new Set([...clients.values()].flatMap((c) => c.folderIds.filter((r) => byId.has(r)).flatMap((r) => descendants(kids, r))))];
    await pool(wanted, FOLDER_CONCURRENCY, readFolder);
    for (const [client, c] of clients) {
      for (const root of c.folderIds) {
        if (!byId.has(root)) { warn(client, `folder ${root} not found in ${login}`); continue; }
        const depth = depthOf(byId, root);
        const sub = descendants(kids, root);
        for (const f of sub) {
          const r = await readFolder(f);
          for (const w of r.warnings) warn(client, w);
          const missing = r.ids.filter((z) => !zapIdSet.has(z)).length;
          if (missing) warn(client, `folder ${f}: ${missing} folder Zaps not found in the account's Zap list (deleted or not visible to this login?)`);
          for (const z of r.ids) {
            const m = folderClaims.get(z) ?? new Map();
            m.set(client, Math.max(m.get(client) ?? -1, depth));
            folderClaims.set(z, m);
          }
        }
        // The folder tree's assetCount counts the folder AND its subfolders (verified live 2026-11-12).
        const reads = await Promise.all(sub.map(readFolder));
        const total = reads.reduce((n, r) => n + r.assets, 0);
        const ac = byId.get(root).assetCount;
        if (reads.every((r) => r.readOk) && typeof ac === 'number' && ac !== total) warn(client, `folder ${root}: folder tree assetCount ${ac} (counts subfolders), folder and subfolder assets returned ${total}`);
      }
    }
    // Nested mappings are legal (the deeper one wins) but worth saying, to every client involved.
    for (const [client, c] of clients) {
      for (const root of c.folderIds) {
        for (let n = byId.get(byId.get(root)?.parentId); n; n = byId.get(n.parentId)) {
          for (const [other, o] of clients) {
            if (other === client || !o.folderIds.includes(n.id)) continue;
            warn([client, other], `folder ${root} (${client}) is nested inside folder ${n.id} mapped to ${other}: the deeper mapping wins for Zaps in folder ${root}`);
          }
        }
      }
    }
   } catch (e) {
    if (e.code !== 'TRPC_TOKEN_EXPIRED') throw e;
    // Degrade honestly: the folder tree and folder assets are trpc-only. Each Zap's OWN folder is known from GraphQL,
    // so a Zap sitting directly in a mapped folder is still claimed; Zaps in subfolders cannot be, and we say so.
    degraded = true;
    folderClaims.clear();
    if (zapsSource !== 'graphql') await gqlList(); // a Zap's own folder is only in the GraphQL list
    for (const [client, c] of clients) {
      for (const root of c.folderIds) {
        for (const z of zaps) {
          if (z.folder?.id !== root) continue;
          const m = folderClaims.get(z.id) ?? new Map(); m.set(client, 0); folderClaims.set(z.id, m);
        }
      }
      if (c.folderIds.length) warn(client, `FOLDER READS FAILED (the trpc token expired and renewal was refused): the subfolders of folder ${c.folderIds.join(', folder ')} were NOT checked, and folders nested inside other clients' folders could not be resolved. ${client}'s Zaps are matched only by their own folder (GraphQL) and name prefixes, so this list can be incomplete. Run \`node login.mjs ${login}\` for a complete scope.`);
    }
   }
  }

  const prefixClaims = new Map(); // zapId -> Set(client)
  if (anyPrefixes) {
    for (const z of zaps) {
      if (z.id == null) continue;
      const t = String(z.title ?? '').toLowerCase();
      for (const [client, c] of clients) {
        if (c.namePrefixes.some((p) => t.startsWith(p.toLowerCase()))) {
          const s = prefixClaims.get(String(z.id)) ?? new Set(); s.add(client); prefixClaims.set(String(z.id), s);
        }
      }
    }
  }

  const owner = new Map();
  for (const z of new Set([...folderClaims.keys(), ...prefixClaims.keys()])) {
    let winners;
    const fc = folderClaims.get(z);
    if (fc?.size) { const top = Math.max(...fc.values()); winners = [...fc].filter(([, d]) => d === top).map(([c]) => c); }
    else winners = [...prefixClaims.get(z)];
    if (winners.length === 1) owner.set(z, winners[0]);
    else {
      const list = winners.sort();
      owner.set(z, { conflict: list });
      warn(list, `zap ${z}: ${conflictLabel(list)}`);
    }
  }
  return { owner, warnings, zaps, trpcRows: zapsSource === 'trpc' ? trpcRows : null, degraded, builtAt: new Date().toISOString() };
}

// Claim-map cache: one entry per login, reused for CLAIM_MAP_TTL_MS while its key is unchanged. The key is the
// clients on that login with their folders and prefixes (so a clients.json edit that matters invalidates it) plus
// the session generation (a new login.mjs session invalidates it). A degraded build (trpc token expired) is never
// kept, so the first call after a re-login gets the full scope. Parallel callers share one build.
export const CLAIM_MAP_TTL_MS = 5 * 60_000;
const claimCache = new Map(); // login -> { key, at, promise, builtAt }
export function _resetScopeCache() { claimCache.clear(); }
const cacheKey = (login, clients) => JSON.stringify([sessionGen(login), [...clients].sort(([a], [b]) => (a < b ? -1 : 1))]);
const fresh = (hit, key) => hit && hit.key === key && Date.now() - hit.at < CLAIM_MAP_TTL_MS;

function loginClaims(login, clients) {
  const key = cacheKey(login, clients);
  const hit = claimCache.get(login);
  if (fresh(hit, key)) return hit.promise;
  const entry = { key, at: Date.now(), builtAt: null };
  const drop = () => { if (claimCache.get(login) === entry) claimCache.delete(login); };
  entry.promise = buildClaims(login, clients).then((b) => {
    if (b.degraded) drop(); else entry.builtAt = b.builtAt;
    return b;
  }, (e) => { drop(); throw e; });
  claimCache.set(login, entry);
  return entry.promise;
}

// When the cached claim map for this target was built (ISO), or null when none is cached (or it was degraded).
export function claimMapBuiltAt(target) {
  const { clients } = loginClients(target);
  const hit = claimCache.get(target.login);
  return fresh(hit, cacheKey(target.login, clients)) ? hit.builtAt : null;
}

// The claim map from the target client's point of view: the login's owner map and this client's warnings.
async function claimMap(target) {
  const { me, clients } = loginClients(target);
  const b = await loginClaims(target.login, clients);
  return { me, owner: b.owner, zaps: b.zaps, trpcRows: b.trpcRows, builtAt: b.builtAt, warnings: [...(b.warnings.get(me) ?? [])] };
}

// Folder ids belonging to a client: its mapped folders and their descendants, minus any subtree that a
// deeper mapping of another client wins, and minus folders another client maps too (conflict).
export async function clientFolderSet(target) {
  const { me, clients } = loginClients(target);
  const flat = flattenTree(await trpc(target.login, 'folder.folderTree', {}));
  const known = new Set(flat.map((f) => f.id));
  const kids = childrenMap(flat);
  const othersFolders = new Set([...clients].filter(([n]) => n !== me).flatMap(([, c]) => c.folderIds));
  const set = new Set();
  for (const root of clients.get(me).folderIds) {
    if (!known.has(root) || othersFolders.has(root)) continue;
    const stack = [root];
    while (stack.length) {
      const f = stack.pop(); set.add(f);
      for (const k of kids.get(f) || []) if (!othersFolders.has(k)) stack.push(k);
    }
  }
  return set;
}

export async function clientZapIds(target) {
  const { me, owner, warnings } = await claimMap(target);
  return { ids: [...owner].filter(([, o]) => o === me).map(([z]) => z), warnings };
}

// Ownership of every Zap on the target's login, from the target client's point of view.
// zaps = the unfiltered Zap list the map was built from (null when no client on the login has folders or prefixes);
// trpcRows = the same list as raw zap.searchZaps rows when it came from trpc (else null).
export async function ownershipIndex(target) {
  const { me, owner, warnings, zaps, trpcRows, builtAt } = await claimMap(target);
  const clientIds = [...owner].filter(([, o]) => o === me).map(([z]) => z);
  const ownershipOf = (zapId) => {
    // A run without a zap id must never fall through to login-wide via String(undefined).
    if (zapId == null || String(zapId).trim() === '') return { ...NO_ZAP_ID };
    const o = owner.get(String(zapId));
    if (o === me) return { ownership: 'client', label: LABELS.client(target.client) };
    if (o?.conflict) return { ownership: 'conflict', label: LABELS.conflict(o.conflict) };
    if (o) return { ownership: 'other-client', label: LABELS.otherClient(o, target.client) };
    return { ownership: 'login-wide', label: LABELS.loginWide(target.login, target.client) };
  };
  return { ownershipOf, clientIds, warnings, zaps, trpcRows, builtAt };
}
