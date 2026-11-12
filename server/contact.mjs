// contact_runs: every run that touched one contact (email or phone), across the client's Zaps and the rest of the login.
import { allRuns, get, accountId, defaultPeriod } from './lib.mjs';
import { ownershipIndex } from './scope.mjs';

const DETAIL_CAP = 300;
const CONCURRENCY = 4;

function* strings(v) {
  if (v == null) return;
  if (typeof v === 'string' || typeof v === 'number') { yield String(v); return; }
  if (Array.isArray(v)) { for (const x of v) yield* strings(x); return; }
  if (typeof v === 'object') for (const x of Object.values(v)) yield* strings(x);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Exact email (case-insensitive, not embedded in a longer address) or last-10-digit phone match.
export function matcher({ email, phone }) {
  if (email) {
    const re = new RegExp(`(?<![A-Za-z0-9._%+-])${escapeRe(email.trim())}(?![A-Za-z0-9_%+-]|\\.[A-Za-z0-9])`, 'i');
    return (detail) => [...strings(detail?.steps_executions)].some((s) => re.test(s));
  }
  const last10 = String(phone).replace(/\D/g, '').slice(-10);
  return (detail) => [...strings(detail?.steps_executions)].some((s) => s.replace(/\D/g, '').includes(last10));
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// Zapier's run search tokenizes stored values (verified live 2026-11-12): '813-555-0123' / '(813) 555-0123' are
// found by '813 555 0123' only, '+18135550123' by '18135550123' only, '8135550123' by itself only.
export const phoneQueries = (last10) => [last10, `1${last10}`, `${last10.slice(0, 3)} ${last10.slice(3, 6)} ${last10.slice(6)}`];
export const PHONE_RECALL_WARNING = "phone searched as NNNNNNNNNN, 1NNNNNNNNNN and 'NNN NNN NNNN' (covers plain, +1 and dash/space/parenthesis formats, proven live 2026-11-12); other formats (e.g. dots) unproven, so zero hits is not proof";
const RETENTION_MS = 60 * 864e5;

export async function contactRuns(target, { email, phone, periodStart, periodEnd } = {}) {
  if (!!email === !!phone) throw new Error('contact_runs: provide exactly one of email or phone');
  const { login } = target;
  const digits = phone ? String(phone).replace(/\D/g, '') : '';
  if (phone && digits.length < 10) throw new Error(`contact_runs: phone must have at least 10 digits (got ${digits.length}); a shorter number would match unrelated contacts`);
  const query = email ? email.trim() : digits.slice(-10);
  const queries = email ? [query] : phoneQueries(query);
  if (!query) throw new Error('contact_runs: provide exactly one of email or phone (value has no usable characters)');
  const idx = await ownershipIndex(target);
  const warnings = [...idx.warnings];
  if (phone) warnings.push(PHONE_RECALL_WARNING);
  // The window actually searched is returned, so "no runs" always names its dates.
  const d = defaultPeriod();
  const window = { periodStart: periodStart || d.periodStart, periodEnd: periodEnd || d.periodEnd };
  const startMs = Date.parse(window.periodStart);
  if (!Number.isNaN(startMs) && startMs < Date.now() - RETENTION_MS - 3600e3) {
    warnings.push(`periodStart ${window.periodStart} is before Zapier's ~60-day retention (${new Date(Date.now() - RETENTION_MS).toISOString()}): runs older than that are gone, so their absence proves nothing`);
  }

  const candidates = new Map(); // runId -> edge
  const add = (r) => { for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w); for (const e of r.edges) if (!candidates.has(String(e.id))) candidates.set(String(e.id), e); };
  if (!idx.clientIds.length) warnings.push(`no Zaps found for client ${target.client}; only login-wide search ran`);
  for (const q of queries) {
    if (idx.clientIds.length) add(await allRuns(login, { query: q, zapIds: idx.clientIds, ...window }));
    add(await allRuns(login, { query: q, ...window }));
  }

  let list = [...candidates.values()].sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)));
  if (list.length > DETAIL_CAP) {
    const skipped = list.slice(DETAIL_CAP);
    warnings.push(`${list.length} candidate runs; checked the newest ${DETAIL_CAP} run details only; skipped ${skipped.length} older candidates with startTime ${skipped.at(-1).startTime} to ${skipped[0].startTime} (UTC) — narrow with periodStart/periodEnd`);
    list = list.slice(0, DETAIL_CAP);
  }

  const A = await accountId(login);
  const isMatch = matcher({ email, phone });
  const checked = await pool(list, CONCURRENCY, async (e) => {
    try {
      const detail = await get(login, `/api/zap-history/v2/runs/${encodeURIComponent(e.id)}?account_id=${A}`);
      return { e, ok: isMatch(detail) };
    } catch (err) {
      warnings.push(`run ${e.id}: detail fetch failed (${err.status ?? err.code ?? err.message}); not confirmed, excluded`);
      return { e, ok: false, failed: true };
    }
  });
  const failed = checked.filter((c) => c.failed).length;
  const notContaining = checked.filter((c) => !c.ok && !c.failed).length;
  if (checked.length) {
    warnings.push(`${checked.filter((c) => c.ok).length} of ${checked.length} candidate runs matched the exact contact`);
    warnings.push(`${notContaining} of ${checked.length} candidate runs did not contain the exact contact${failed ? ` (${failed} could not be checked)` : ''}`);
  }

  const runs = checked.filter((c) => c.ok).map(({ e }) => {
    const zapId = e.zap?.id == null || String(e.zap.id).trim() === '' ? null : String(e.zap.id);
    const { ownership, label } = idx.ownershipOf(zapId);
    return { runId: String(e.id), zapId, zapTitle: e.zap?.title ?? null, startTime: e.startTime, status: e.status, ownership, label };
  }).sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));

  // warnings and window first: output truncation must never cut them.
  return { warnings, window, runs };
}
