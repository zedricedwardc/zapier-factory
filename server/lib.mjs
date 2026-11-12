// Zapier internal API client — READ-ONLY, one saved browser session per login.
// Reuses the session captured by login.mjs (Playwright storageState in <FACTORY_DIR>/logins/<login>/session.json).
// Never prints cookie values. Never stores passwords.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRegistry } from './registry.mjs';

export const FACTORY_DIR = process.env.ZAPIER_FACTORY_DIR || path.join(os.homedir(), '.zapier-factory');
export function loginDir(login) {
  if (typeof login !== 'string' || !/^[a-z0-9-]+$/.test(login)) throw new Error(`INVALID_LOGIN: login name must match /^[a-z0-9-]+$/, got ${JSON.stringify(login)}`);
  return path.join(FACTORY_DIR, 'logins', login);
}
const sessionFile = (login) => path.join(loginDir(login), 'session.json');
const metaFile = (login) => path.join(loginDir(login), 'meta.json');
export const ORIGIN = 'https://zapier.com';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const loginHint = (login) => `Run \`node login.mjs ${login}\` in the zapier-factory server folder (a browser opens; log in to Zapier yourself), then retry. No restart of the MCP server is needed.`;

export class ZapierError extends Error {
  constructor(code, message, extra = {}) { super(`${code}: ${message}`); this.code = code; Object.assign(this, extra); }
}

// ---------------------------------------------------------------------------------------------
// HARD READ-ONLY GUARD — the single place that decides whether a request may leave this process.
// Allowed: GET to https://zapier.com/..., and POST to /api/reporting/graphql whose JSON body is a
// single operation with query text starting with `query` and containing no `mutation`/`subscription`.
// Everything else throws READ_ONLY_VIOLATION.
// ---------------------------------------------------------------------------------------------
export const GRAPHQL_PATH = '/api/reporting/graphql';
export function assertReadOnly(method, url, body) {
  const m = String(method || '').toUpperCase();
  let u;
  try { u = new URL(url, ORIGIN); } catch { throw new ZapierError('READ_ONLY_VIOLATION', `unparseable URL ${url}`); }
  if (u.origin !== ORIGIN) throw new ZapierError('READ_ONLY_VIOLATION', `only ${ORIGIN} is allowed, got ${u.origin}`);
  // Switching the current Zapier account is a write on the server side, whatever the method.
  let decoded = u.pathname;
  try { decoded = decodeURIComponent(u.pathname); } catch { /* keep raw */ }
  for (const pth of new Set([u.pathname, decoded].map(x => x.toLowerCase()))) {
    if (pth.includes('/switch') || pth.includes('/current_account') || /\/accounts\/[^/]+\/activate/.test(pth)) {
      throw new ZapierError('READ_ONLY_VIOLATION', `account switching is blocked (${u.pathname}); every call passes account_id explicitly from the registry`);
    }
  }
  if (m === 'GET') {
    if (body !== undefined && body !== null) throw new ZapierError('READ_ONLY_VIOLATION', 'GET with a body is not allowed');
    return true;
  }
  if (m === 'POST') {
    if (u.pathname !== GRAPHQL_PATH) throw new ZapierError('READ_ONLY_VIOLATION', `POST is only allowed to ${GRAPHQL_PATH}, got ${u.pathname}`);
    let parsed;
    try { parsed = typeof body === 'string' ? JSON.parse(body) : body; } catch { throw new ZapierError('READ_ONLY_VIOLATION', 'GraphQL body is not JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ZapierError('READ_ONLY_VIOLATION', 'GraphQL body must be one operation object (no batches)');
    const q = parsed.query;
    if (typeof q !== 'string') throw new ZapierError('READ_ONLY_VIOLATION', 'GraphQL body has no query text (persisted queries are not allowed)');
    if (!q.trimStart().startsWith('query')) throw new ZapierError('READ_ONLY_VIOLATION', 'GraphQL text must start with `query`');
    if (/mutation/i.test(q) || /subscription/i.test(q)) throw new ZapierError('READ_ONLY_VIOLATION', 'GraphQL text contains mutation/subscription');
    if (parsed.extensions?.persistedQuery) throw new ZapierError('READ_ONLY_VIOLATION', 'persisted queries are not allowed');
    return true;
  }
  throw new ZapierError('READ_ONLY_VIOLATION', `method ${m} is not allowed (read-only client)`);
}

// ---------------------------------------------------------------------------------------------
// Session (cookies) — loaded from session.json, reloaded when the file changes (new login), and
// updated in place when Zapier rotates cookies via Set-Cookie.
// ---------------------------------------------------------------------------------------------
const states = new Map(); // login -> { mtimeMs, gen, data: storageState }; gen bumps only when the file is (re)loaded from disk
const verifyCache = new Map(); // login -> { gen, key, result }
let genCounter = 0;

function sessionMissing(login, reason) {
  const hint = loginHint(login);
  return new ZapierError('SESSION_EXPIRED', `[login ${login}] ${reason}. ${hint}`, { hint, login });
}

function loadSession(login) {
  const file = sessionFile(login);
  let st;
  try { st = fs.statSync(file); } catch { throw sessionMissing(login, `no Zapier session file at ${file}`); }
  let state = states.get(login);
  if (!state || state.mtimeMs !== st.mtimeMs) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw sessionMissing(login, `session file ${file} is unreadable`); }
    if (!Array.isArray(data?.cookies)) throw sessionMissing(login, `session file ${file} has no cookies`);
    state = { mtimeMs: st.mtimeMs, gen: ++genCounter, data };
    states.set(login, state);
    verifyCache.delete(login);
  }
  return state.data;
}

function saveSession(login) {
  const state = states.get(login);
  if (!state) return;
  const file = sessionFile(login);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state.data, null, 2));
  fs.renameSync(tmp, file);
  state.mtimeMs = fs.statSync(file).mtimeMs;
}

function domainMatches(host, cookieDomain) {
  const d = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  return host === d || host.endsWith('.' + d);
}

function cookiesFor(login, url) {
  const u = new URL(url);
  const now = Date.now() / 1000;
  return loadSession(login).cookies.filter(c =>
    domainMatches(u.hostname, c.domain) &&
    u.pathname.startsWith(c.path || '/') &&
    !(typeof c.expires === 'number' && c.expires > 0 && c.expires < now));
}

export function cookieHeader(login, url) {
  return cookiesFor(login, url).map(c => `${c.name}=${c.value}`).join('; ');
}
function cookieValue(login, url, name) { return cookiesFor(login, url).find(c => c.name === name)?.value; }

// Parse one Set-Cookie header and merge into the stored jar. Returns true if the jar changed.
export function applySetCookie(jar, setCookie, host = 'zapier.com') {
  const parts = setCookie.split(';').map(s => s.trim());
  const eq = parts[0].indexOf('=');
  if (eq < 1) return false;
  const name = parts[0].slice(0, eq), value = parts[0].slice(eq + 1);
  const attrs = {};
  for (const p of parts.slice(1)) { const i = p.indexOf('='); attrs[(i < 0 ? p : p.slice(0, i)).toLowerCase()] = i < 0 ? true : p.slice(i + 1); }
  const domain = attrs.domain ? (String(attrs.domain).startsWith('.') ? attrs.domain : '.' + attrs.domain) : host;
  const cpath = attrs.path || '/';
  let expires = -1;
  if (attrs['max-age'] !== undefined) expires = Date.now() / 1000 + Number(attrs['max-age']);
  else if (attrs.expires) { const t = Date.parse(attrs.expires); if (!Number.isNaN(t)) expires = t / 1000; }
  const idx = jar.cookies.findIndex(c => c.name === name && c.domain.replace(/^\./, '') === domain.replace(/^\./, '') && (c.path || '/') === cpath);
  const remove = expires !== -1 && expires <= Date.now() / 1000;
  if (remove) { if (idx >= 0) { jar.cookies.splice(idx, 1); return true; } return false; }
  const cookie = {
    name, value, domain, path: cpath, expires,
    httpOnly: !!attrs.httponly, secure: !!attrs.secure,
    sameSite: attrs.samesite ? (String(attrs.samesite)[0].toUpperCase() + String(attrs.samesite).slice(1).toLowerCase()) : 'Lax',
  };
  if (idx >= 0) {
    const old = jar.cookies[idx];
    if (old.value === value && old.expires === expires) return false;
    jar.cookies[idx] = { ...old, ...cookie };
  } else jar.cookies.push(cookie);
  return true;
}

function persistRotatedCookies(login, res, host) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!list.length) return 0;
  const jar = loadSession(login);
  let changed = 0;
  for (const sc of list) if (applySetCookie(jar, sc, host)) changed++;
  if (changed) { try { saveSession(login); } catch (e) { process.stderr.write(`[zapier-factory] could not persist rotated cookies: ${e.message}\n`); } }
  return changed;
}

function userAgent(login) {
  try { return JSON.parse(fs.readFileSync(metaFile(login), 'utf8')).userAgent || DEFAULT_UA; } catch { return DEFAULT_UA; }
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------
export async function request(login, method, pathOrUrl, { body, referer } = {}) {
  const url = new URL(pathOrUrl, ORIGIN).toString();
  const bodyText = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  assertReadOnly(method, url, bodyText);
  const cookie = cookieHeader(login, url);
  if (!cookie) throw sessionMissing(login, 'session file holds no zapier.com cookies');
  const headers = {
    accept: 'application/json',
    cookie,
    'user-agent': userAgent(login),
    referer: referer || `${ORIGIN}/app/assets/zaps`,
  };
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    headers['apollographql-client-name'] = 'reporting';
    headers.origin = ORIGIN;
    const csrf = cookieValue(login, url, 'csrftoken');
    if (csrf) headers['x-csrftoken'] = csrf;
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: bodyText, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new ZapierError('NETWORK_ERROR', `${method} ${new URL(url).pathname} failed: ${e.message}`);
  }
  persistRotatedCookies(login, res, new URL(url).hostname);
  const p = new URL(url).pathname;
  if (res.status === 401 || res.status === 403) throw sessionMissing(login, `Zapier answered ${res.status} on ${p} — the saved browser session is no longer accepted`);
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    // The query string can carry tokens or customer data: only the path is ever reported.
    let locPath = loc.split(/[?#]/)[0];
    try { const lu = new URL(loc, ORIGIN); locPath = lu.origin === ORIGIN ? lu.pathname : lu.origin + lu.pathname; } catch { /* keep the split value */ }
    throw (/login|signin|sign-in/i.test(loc) ? sessionMissing(login, `Zapier redirected ${p} to a login page`) : new ZapierError('HTTP_REDIRECT', `${res.status} on ${p} → ${locPath}`));
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = undefined; }
  if (!res.ok) {
    const snippet = (text || '').slice(0, 400);
    const hint = res.status === 500 && /zap-history\/v2\/runs\/[^/]+$/.test(p) ? ' (for run detail a 500 usually means the run id does not exist)' : '';
    throw new ZapierError('HTTP_' + res.status, `${method} ${p}${hint}: ${snippet}`, { status: res.status });
  }
  if (json === undefined) {
    if (/<html/i.test(text) && /log ?in|sign ?in/i.test(text)) throw sessionMissing(login, `Zapier served a login page for ${p}`);
    throw new ZapierError('BAD_RESPONSE', `${p} did not return JSON`);
  }
  return json;
}

export const get = (login, p) => request(login, 'GET', p);

export function qs(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    s.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const out = s.toString();
  return out ? '?' + out : '';
}

// tRPC (asset-management-bff) — GET with ?input=<json>
export async function trpc(login, proc, input = {}) {
  const r = await get(login, `/api/asset-management-bff/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`);
  const data = r?.result?.data;
  return data && typeof data === 'object' && 'json' in data && Object.keys(data).length <= 2 ? data.json : data;
}

// GraphQL (reporting) — query only; guard re-checks the text.
export async function graphql(login, operationName, query, variables) {
  const r = await request(login, 'POST', GRAPHQL_PATH, { body: { operationName, query, variables }, referer: `${ORIGIN}/app/history` });
  if (r?.errors?.length) {
    const msg = r.errors.map(e => e.message).join(' | ');
    if (/unauthenticated|not authenticated|login required|not logged in/i.test(msg)) throw sessionMissing(login, `GraphQL says: ${msg}`);
    throw new ZapierError('GRAPHQL_ERROR', msg, { graphqlErrors: r.errors });
  }
  return r.data;
}

// ---------------------------------------------------------------------------------------------
// Session / account
// ---------------------------------------------------------------------------------------------
export async function session(login) { return get(login, '/api/v4/session'); }
// The account id always comes from the registry (never the session, never an env var).
function registryEntry(login) {
  const reg = loadRegistry();
  const l = Object.hasOwn(reg.logins, login) ? reg.logins[login] : null;
  return l;
}
export async function accountId(login) {
  const l = registryEntry(login);
  if (!l) throw new ZapierError('UNKNOWN_LOGIN', `login "${login}" is not in clients.json (${path.join(FACTORY_DIR, 'clients.json')}); add it under "logins" first`);
  if (typeof l.accountId !== 'string' || !l.accountId) throw new ZapierError('NO_ACCOUNT_ID', `login "${login}" has no account id in clients.json: run node login.mjs ${login} to discover the account id`);
  return l.accountId;
}

// Who the saved session belongs to vs. who the registry says this login is.
export async function whoamiDetail(login) {
  const s = await session(login);
  if (s?.is_logged_in === false) throw sessionMissing(login, 'Zapier says the saved session is not logged in');
  const l = registryEntry(login);
  const sessionAccountId = s?.current_account_id == null ? null : String(s.current_account_id);
  const registryAccountId = l?.accountId ?? null;
  const match = !!l && typeof s?.email === 'string' && s.email.toLowerCase() === l.email.toLowerCase() && sessionAccountId !== null && sessionAccountId === registryAccountId;
  return { email: s?.email ?? null, sessionAccountId, registryAccountId, match, registryEmail: l?.email ?? null, userId: s?.id ?? null, isLoggedIn: s?.is_logged_in };
}

export async function whoami(login) {
  const { email, sessionAccountId, registryAccountId, match } = await whoamiDetail(login);
  return { email, sessionAccountId, registryAccountId, match };
}

// Throws ACCOUNT_MISMATCH unless the session belongs to the registry's login. Cached for at most
// VERIFY_TTL_MS, and dropped early when the session file is reloaded (new login) or the registry entry changes.
export const VERIFY_TTL_MS = 60_000;
export async function assertSessionMatchesRegistry(login) {
  loadSession(login);
  const gen = states.get(login).gen;
  const l = registryEntry(login);
  if (!l) throw new ZapierError('UNKNOWN_LOGIN', `login "${login}" is not in clients.json; add it under "logins" first`);
  await accountId(login);
  const key = `${l.email}|${l.accountId}`;
  const c = verifyCache.get(login);
  if (c && c.gen === gen && c.key === key && Date.now() - c.at < VERIFY_TTL_MS) return c.result;
  const w = await whoamiDetail(login);
  if (!w.match) {
    throw new ZapierError('ACCOUNT_MISMATCH', `[login ${login}] the saved Zapier session is ${w.email} (account ${w.sessionAccountId}) but the registry expects ${l.email} (account ${l.accountId}). Refusing to run. Re-run \`node login.mjs ${login}\` with the right Zapier user.`, { login, sessionEmail: w.email, registryEmail: l.email });
  }
  verifyCache.set(login, { gen, key, result: w, at: Date.now() });
  return w;
}

// ---------------------------------------------------------------------------------------------
// Runs GraphQL query (ZapRuns). Variables with proven types come from the saved history-page query;
// the other variables the audit found are added only when used, with types NOT confirmed
// (introspection is off) — if Zapier rejects a type, the GraphQL error is returned as is.
// ---------------------------------------------------------------------------------------------
const RUN_VAR_TYPES = {
  accountId: 'ID!', limit: 'Int', offset: 'Int', periodEnd: 'String', periodStart: 'String',
  query: 'String', sortBy: 'String', status: '[String!]', zapIds: '[ID!]', folderIds: '[ID!]',
};
export const RUN_VAR_TYPES_UNVERIFIED = {
  apps: '[String!]', channel: 'String', channelError: 'String', customuserIds: '[ID!]',
  heldReasons: '[String!]', heldStaleAuthIds: '[ID!]',
};
const EDGE_FIELDS_FULL = 'billableCount hasPaths heldReason heldStaleAuth id startTime status triggerType replayCount zap { id kind sourceUrl title folder { id title } } zapOwner { id name }';
const EDGE_FIELDS_MIN = 'id startTime status heldReason triggerType replayCount billableCount zap { id title }';

export function buildZapRunsQuery(vars, edgeFields = EDGE_FIELDS_FULL) {
  const types = { ...RUN_VAR_TYPES, ...RUN_VAR_TYPES_UNVERIFIED };
  const used = Object.keys(vars).filter(k => vars[k] !== undefined && types[k]);
  const decl = used.map(k => `$${k}: ${types[k]}`).join(', ');
  const args = used.map(k => `${k}: $${k}`).join(', ');
  return `query ZapRuns(${decl}) {\n  zapRuns(${args}) {\n    edges { ${edgeFields} }\n    totalCount\n    totalActionable\n  }\n}`;
}

export const RUN_STATUSES = ['error', 'error_handled', 'needs_review', 'held', 'throttled', 'halted', 'filtered', 'success', 'delayed', 'scheduled'];

export function defaultPeriod() {
  const now = Date.now();
  return { periodStart: new Date(now - 60 * 864e5).toISOString(), periodEnd: new Date(now + 864e5).toISOString() };
}

const edgeFieldsModes = new Map(); // login -> 'full' | 'min'
export async function zapRuns(login, v = {}) {
  const vars = { accountId: await accountId(login), limit: 50, offset: 0, sortBy: '-start_time', ...defaultPeriod(), ...v };
  for (const k of Object.keys(vars)) if (vars[k] === undefined || (Array.isArray(vars[k]) && !vars[k].length)) delete vars[k];
  const notes = [];
  const run = (fields) => graphql(login, 'ZapRuns', buildZapRunsQuery(vars, fields), vars);
  let data;
  if ((edgeFieldsModes.get(login) ?? 'full') === 'full') {
    try { data = await run(EDGE_FIELDS_FULL); }
    catch (e) {
      if (e.code === 'GRAPHQL_ERROR' && /Cannot query field|Unknown field/i.test(e.message)) {
        edgeFieldsModes.set(login, 'min');
        notes.push(`full edge field set rejected (${e.message}); fell back to the proven minimal set`);
      } else throw e;
    }
  }
  if (!data) data = await run(EDGE_FIELDS_MIN);
  const out = data.zapRuns;
  if (notes.length) out._notes = notes;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Full-paging helpers
// ---------------------------------------------------------------------------------------------
export async function allZaps(login, { search, order = '-updated_at', pageSize = 500 } = {}) {
  const out = []; let count;
  for (let offset = 0; ; offset += pageSize) {
    const p = await trpc(login, 'zap.searchZaps', { limit: pageSize, offset, order, ...(search ? { search } : {}) });
    const rows = p?.results || [];
    count = p?.count ?? count;
    out.push(...rows);
    if (!p?.next || rows.length < pageSize) break;
  }
  return { count: count ?? out.length, results: out };
}

export async function allRuns(login, v = {}, { max = 10000 } = {}) {
  const edges = []; let totalCount, totalActionable; const warnings = [];
  for (let offset = 0; offset < max; offset += 100) {
    const p = await zapRuns(login, { ...v, limit: 100, offset });
    totalCount = p.totalCount; totalActionable = p.totalActionable;
    edges.push(...(p.edges || []));
    if (!p.edges?.length || p.edges.length < 100 || edges.length >= totalCount) break;
  }
  if (totalCount >= 10000) warnings.push('totalCount is capped at 10000 — there may be more runs; narrow by zapIds/status/query/period.');
  if (edges.length >= max && totalCount > max) warnings.push(`stopped at max=${max} of ${totalCount}`);
  return { totalCount, totalActionable, returned: edges.length, edges, warnings };
}

// URL of one page of a Zap's version list. A cursor that is a URL/path is followed only when it points at
// /api/gulliver/storage/v1/zaps/<same zapId>/versions on zapier.com (else CURSOR_REJECTED); any other
// cursor is passed as ?cursor= (assumption, see README). account_id is always present.
export function versionsUrl(zapId, A, cursor) {
  const path = `/api/gulliver/storage/v1/zaps/${encodeURIComponent(zapId)}/versions`;
  const base = `${path}?account_id=${A}`;
  if (!cursor) return base;
  if (!/^(https?:|\/)/.test(cursor)) return `${base}&cursor=${encodeURIComponent(cursor)}`;
  let u;
  try { u = new URL(cursor, ORIGIN); } catch { throw new ZapierError('CURSOR_REJECTED', 'versions cursor is not a valid URL'); }
  if (u.origin !== ORIGIN || u.pathname.replace(/\/$/, '') !== path) {
    throw new ZapierError('CURSOR_REJECTED', `versions cursor points at ${u.origin}${u.pathname}, not ${path}; refusing to follow it`);
  }
  if (!u.searchParams.has('account_id')) u.searchParams.set('account_id', A);
  return u.pathname + u.search;
}

export async function allVersions(login, zapId, { maxPages = 40 } = {}) {
  const A = await accountId(login);
  const out = []; let next = null; let pages = 0;
  do {
    const url = versionsUrl(zapId, A, next);
    const p = await get(login, url);
    // list key not pinned down by the audit: take results/objects/data, else the first array property
    const rows = p?.results || p?.objects || p?.data || Object.values(p || {}).find(Array.isArray) || [];
    out.push(...rows);
    next = p?.meta?.next_cursor || null;
    pages++;
  } while (next && pages < maxPages);
  return { versions: out, pages, complete: !next };
}
