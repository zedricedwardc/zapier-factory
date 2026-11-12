---
name: zapier-status
description: "Read-only health check of the zapier-factory setup for one Zapier login or every login in the registry: session and trpc token (zapier_whoami), registry vs Zapier (unmapped folders, conflicts, missing folders, scope warnings), and per client the Zaps on/off, failed/halted/held runs in the last 7 days, held runs by reason and billable task usage, as one compact dashboard with the next step for each problem. Use when the user says \"zapier status\", \"is zapier connected\", \"check the zapier setup\", \"zapier health check\", \"why is the audit empty\", \"why does contact_runs find nothing\", or before a Zapier audit when a tool returned SESSION_EXPIRED, TRPC_TOKEN_EXPIRED, a mismatch or an unexpected empty result."
---

# Zapier Status

One dashboard that answers "is the zapier-internal MCP working, and does each client's scope look right?"
**Read-only. Exact numbers only. No customer data.**

## Hard rules

- **Read-only.** Only the zapier-internal MCP tools (named bare here; in a session they look like
  `mcp__plugin_zapier-factory_zapier-internal__zapier_whoami`). Nothing is edited, replayed or toggled.
- **Never use the official Zapier MCP servers** (e.g. `Zapier-<Agency>`, `Zapier-MCP`, anything on
  mcp.zapier.com). They can edit, run and delete Zaps.
- **Never read session files** (`%USERPROFILE%\.zapier-factory\logins\`). `zapier_whoami` is the session check.
- **No customer data.** Counts, Zap ids, folder ids and run ids only. Never `get_run`, `contact_runs`,
  `step_gives` or `full: true` here; no emails, phones or run input/output in the dashboard.
- **Exact numbers, with their window.** Every run or task count is quoted with the window it covers. A count
  the tool did not return is "not read" (with the error code), never 0. Unknown cause = "Requires investigation".

## Inputs

- A **login** (e.g. `agency`) or **all**. "All" = every distinct `login` in `list_clients` (a login with no
  clients does not show there; ask the user to name it if they expect one).
- Optional: one **client** only.
- The window: `periodStart` = now − 7 days, `periodEnd` = now + 1 day (ISO UTC; `periodEnd` must stay in the
  future or today's runs are dropped). Use the same two values on every call and quote them in the output.

## Steps

1. **Registry.** `list_clients` (no Zapier call). Note each client's `login`, `accountId`, `folderIds` and
   `namePrefixes` counts, and `ghl` (server name, `locationIdCount`). A client with 0 folders and 0 prefixes
   owns nothing: problem.
2. **Per login: session.** `zapier_whoami` with `login: "<login>"`. Record `is_logged_in`, `match`,
   `trpc_token` and any `warnings` (`renewed at <time>` = fine).
   - `SESSION_EXPIRED` error or `is_logged_in: false` → next step: user runs
     `node "${CLAUDE_PLUGIN_ROOT}/server/login.mjs" <login> --email <email>` (zapier-connect skill). Every
     other tool for that login fails until then, so mark the rest of that login "not read" and move on.
   - `match: false` → registry email/account and session disagree; every other tool refuses. Next step:
     zapier-connect skill, "Mismatch". Mark the rest "not read".
   - `trpc_token: "expired"` (renewal refused) → folders, folder assets, the trpc Zap list and connections
     fail; runs, GraphQL and REST still work. Next step: `login.mjs <login>`. Continue; expect
     `FOLDER READS FAILED` warnings below.
3. **Per login: registry vs Zapier.**
   - `unmapped_folders` with `login`: count the folders no client references; list each `id`, `name`,
     `assetCount` (folders with `assetCount` 0 can be noted as empty; with many, list those holding Zaps first). Zaps in them read as login-wide in every
     audit. Next step: map them in clients.json (zapier-connect skill, section 2/3) or confirm they are
     nobody's. Rows carry `id`, `name`, `assetCount`, `parentId`.
   - `held_counts` with `login` (login-wide): `total`, `reasons[]` (`reason_type`, `total`,
     `totals_by_auth_id` = connection ids) and `starts_expiring`. Label it login-wide; it is not limited to the
     7-day window. `stale_auth` held runs → next step: reconnect that connection in Zapier (a human does it;
     `list_connections` with `status: "expired"` names it).
4. **Per client** (only clients on that login):
   - `list_zaps` with `client` and `all: true` (one call) → Zaps on = rows with `isEnabled: true`, Zaps off =
     rows with `isEnabled: false` (rows with `isEnabled: null` are "not read", say how many); `count` = all the
     client's Zaps; `excluded` = login Zaps that are not this client's (`login_wide`, `other_client`, `conflict`; it
     does not depend on any filter). If `returned` is less than `count` or the output was truncated, count on/off
     with `status: "on"` / `"off"` and `limit: 1` instead (their `count`).
     Read its `warnings`: `folder <id> not found in <login>` = **missing folder** (deleted or wrong id);
     `zap <id>: claimed by <a> and <b>` = **conflict**; `nested inside` = a deeper mapping wins (note, not a
     problem); `FOLDER READS FAILED` = scope incomplete until re-login. `count` 0 → the client has no Zaps:
     every audit for it will be empty. Next step: fix its folders/prefixes (zapier-connect).
   - `search_runs` with `client`, the window, `limit: 1` and `status: ["error"]`, then `["halted"]`, then
     `["held"]` → quote each `totalCount` (caps at 10,000; say so if hit). Keep its `warnings`.
   - `task_usage` with `client` and the same window → `totalBillableCount` (and `interval`). A client with
     Zaps on but 0 tasks in 7 days is worth a line ("no billable tasks in window"), not a conclusion.
5. **Pace.** The first client-scoped call on a login builds the login's ownership (claim) map, about 6 s live
   for a ~300-Zap login; it is cached for 5 minutes and shared by every client on that login, so the following
   calls take about 0.5-2.5 s each (live 2026-11-13: list_zaps 0.6 s, search_runs 0.4-0.7 s, task_usage 2.5 s).
   One login plus one client is well under a minute of tool time. Results carry `scope.claim_map_built_at`; a
   clients.json edit or a new login rebuilds the map. Run the calls one after another.
6. **Stop at the first hard failure per login** (session expired, mismatch): do not retry in a loop. One
   re-check with `zapier_whoami` after the user re-logs in.

## Output

A heading `Zapier status — <login | all logins> — window <periodStart> to <periodEnd> UTC`, then:

**Logins**

| Login | Logged in | Registry match | trpc token | Unmapped folders | Held (login-wide, by reason) |
|---|---|---|---|---|---|

**Clients**

| Client | Login | Folders / prefixes | Zaps on | Zaps off | Excluded (login-wide / other / conflict) | Errors 7d | Halted 7d | Held 7d | Tasks 7d | GHL server |
|---|---|---|---|---|---|---|---|---|---|---|

**Problems and next steps**: one line each, most blocking first:
`<login or client>: <problem, with the exact number or id> → <next step>`. Examples:

- `agency: SESSION_EXPIRED → run node login.mjs agency --email <email> (a human types the password/OTP)`
- `client-b: folder 1234 not found in agency → fix folderIds in clients.json (zapier-connect)`
- `agency: 3 unmapped folders (ids ...) → map them or confirm they belong to nobody`
- `client-c: 12 error runs in window → zapier-zap-audit on the Zaps involved`

Then **Limits**: the window, any "not read" cells with their error code, every `warnings` line not already
shown, caps hit, and that `held_counts` is login-wide. "All green" only when every cell was read and no
problem line exists.

### Why is the audit empty?

When the user asks this, the usual causes in this dashboard are: session expired or mismatch (step 2), the
client owns 0 Zaps or has a missing folder (step 4), `FOLDER READS FAILED` (scope incomplete), or the window:
Zap History keeps about 60 days, so "no runs found in the window" is a retention/search limit, not proof of no
activity. Name which one applies, with its number.
