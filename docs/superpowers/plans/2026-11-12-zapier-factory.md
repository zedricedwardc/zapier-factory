# Zapier Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-account Agency Zapier MCP into `zapier-factory`, a personal Claude Code plugin with a multi-login, multi-client, read-only Zapier MCP and three audit skills.

**Architecture:** One stdio MCP server (`zapier-internal`) shipped in the plugin's `.mcp.json`. Each Zapier login keeps its own Playwright session under `%USERPROFILE%\.zapier-factory\logins\<login>\`; a registry `%USERPROFILE%\.zapier-factory\clients.json` maps clients to a login, account id, folders/prefixes and their GHL server. Every tool takes `client` (or `login`), passes `account_id` explicitly, and goes through the existing `assertReadOnly` guard.

**Tech Stack:** Node 24 ESM, `@modelcontextprotocol/sdk` 1.32.2, `playwright` 1.63.0, `zod` 4.6.7, `node --test`.

**Spec:** `C:\Users\herna\downloads\work\zapier-factory\docs\2026-11-12-zapier-factory-design.md`

## Global Constraints
- READ ONLY: GET to `https://zapier.com` only; POST only to `/api/reporting/graphql` with a single `query` (no `mutation`/`subscription`). Anything else throws before any network call.
- Switching Zapier's current account is a write → blocked. Every call passes `account_id` explicitly from the registry.
- Never store, print or type passwords/OTP/cookie values. Sessions live only in `%USERPROFILE%\.zapier-factory\logins\<login>\` (outside any repo).
- Data from one client never appears unlabelled in another client's audit. Runs from non-client Zaps are labelled `"<login>-wide Zap, not <client>'s"`; unassignable runs are reported as such, never dropped silently.
- Findings cite run ids and UTC timestamps; unknown cause = "Requires investigation".
- Defaults: runs `periodEnd = now + 1 day`, `periodStart = now − 60 days`; run list `limit ≤ 100`; `totalCount` caps at 10,000 (warn).
- Personal plugin; local marketplace at `C:\Users\herna\downloads\work\zapier-factory`. Skills never call the official `Zapier-Agency` / `Zapier-Client-B` / `Zapier-MCP` servers.
- GHL calls from skills: only the safe-read allowlist in Task 9. Never `get_contact_ai_status` or anything touching employeeConfigs; never GHL writes.

## Review Focus
1. Client name not in the registry, or a folder renamed/deleted in Zapier → clear error listing known clients / an "unmapped folder" warning, not an empty result that reads as "no activity". (Test in Task 3 and Task 5.)
2. Session expired mid-audit for one login while another works → `SESSION_EXPIRED` naming that login and `node login.mjs <login>`; other logins unaffected. (Task 2.)
3. Contact search hit where the email only partly matches (Zapier search is whole-word: `jane` matches `jane@x.com`) → a run is kept only if the exact email/phone appears in its data. (Task 6.)
4. Same run returned by both the client-scoped and the login-wide search → appears once, labelled as the client's. (Task 6.)
5. Draft-only Zap (`current_version: null`) or a run id that 500s → steps from `draft.zdl` / a clear "run not found" error, never a crash. (Task 5.)

---

### Task 1: Plugin repo + moved server

**Files:**
- Create: `zapier-factory/.claude-plugin/plugin.json` (`name: "zapier-factory"`, version `0.1.0`, author the owner), `zapier-factory/.claude-plugin/marketplace.json` (one plugin, `source: "./"`), `zapier-factory/.mcp.json` (`zapier-internal` → `node ${CLAUDE_PLUGIN_ROOT}/server/server.mjs`), `zapier-factory/.gitignore` (`node_modules/`, `.zapier*/`)
- Move: `agency/zapier-mcp/{lib,tools,server,cli,login}.mjs`, `test/`, `package.json`, `package-lock.json` → `zapier-factory/server/`
- Modify: `agency/zapier-mcp/` → leave only `README.md` saying it moved to `C:\Users\herna\downloads\work\zapier-factory`

- [ ] Step 1: `git init` in `zapier-factory`, move files, `npm ci` in `server/`.
- [ ] Step 2: Run `npm test` in `server/` → 9 pass, 0 fail.
- [ ] Step 3: Run `node server/cli.mjs list` → prints the 15 tool names.
- [ ] Step 4: Commit `chore: move zapier MCP into zapier-factory plugin`.

### Task 2: Per-login sessions

**Files:** Modify `server/lib.mjs`, `server/login.mjs`; Test `server/test/login-paths.test.mjs`

**Interfaces — Produces:**
- `FACTORY_DIR` = `process.env.ZAPIER_FACTORY_DIR || path.join(os.homedir(), '.zapier-factory')`
- `loginDir(login: string): string` → `<FACTORY_DIR>/logins/<login>`; rejects names not matching `/^[a-z0-9-]+$/`
- `request(login, method, pathOrUrl, {body, referer})`, `get(login, path)`, `trpc(login, proc, input)`, `graphql(login, op, query, vars)`, `session(login)` — same behaviour as today, session file `<loginDir>/session.json`, user agent from `<loginDir>/meta.json`
- Error `SESSION_EXPIRED` message contains the login name and `node login.mjs <login>`
- Remove `EXPECTED_EMAIL` / `EXPECTED_ACCOUNT_ID` constants (registry supplies them, Task 3)
- `login.mjs <login> [--email <expected>] [--minutes <n>]` (default 30 min); profile in `<loginDir>/profile`; on success writes `session.json`, `meta.json`, and prints the discovered `current_account_id` and the `accounts` list from `/api/v4/accounts?limit=9999`.

- [ ] Step 1: Tests: `loginDir('agency')` ends with `logins\agency`; `loginDir('../x')` throws; with `ZAPIER_FACTORY_DIR` set to a temp dir containing only `logins/agency/session.json`, `session('client-b')` rejects with message matching `/SESSION_EXPIRED.*client-b.*node login\.mjs client-b/`; `session('agency')` uses the agency cookie jar (stub `globalThis.fetch`, assert the Cookie header).
- [ ] Step 2: Run `npm test` → new tests fail.
- [ ] Step 3: Implement; thread `login` through every `lib.mjs` export and existing tests.
- [ ] Step 4: `npm test` → all pass. `node login.mjs` with no args prints usage and exits 1.
- [ ] Step 5: Commit `feat: one session per Zapier login`.

### Task 3: Client registry

**Files:** Create `server/registry.mjs`, `server/clients.example.json`; Test `server/test/registry.test.mjs`

**Interfaces — Produces:**
- Registry file `<FACTORY_DIR>/clients.json`:
  ```json
  { "logins": { "agency": { "email": "owner@agency.example", "accountId": "10000001" } },
    "clients": { "client-a": { "login": "agency", "folderIds": ["0100000a-0000-0000-0000-000000000001"], "namePrefixes": ["Client A"],
                                   "ghl": { "server": "uxie-ghl-internal-mcp", "locationIds": [] } } } }
  ```
- `loadRegistry(): Registry` (missing file → empty registry, invalid JSON/schema → error naming the field)
- `resolveTarget({client?, login?}, cwd = process.cwd()): {login, accountId, email, client: string|null, folderIds, namePrefixes, ghl}` — explicit `client` wins, then explicit `login`, then nearest `.zapier-client` file walking up from `cwd` (file content = client name). Unknown client → error listing known client names.
- Seed `clients.example.json` with logins `agency` (owner@agency.example, 10000001) and `client-b` (support@client-b.example, accountId unknown → `null`), clients `client-a` as above; Client E entries left for Task 10.

- [ ] Step 1: Tests: explicit client resolves its login/accountId; `.zapier-client` in a parent dir resolves; unknown client error lists `client-a`; login with `accountId: null` → error "run node login.mjs <login> to discover the account id"; schema error names the bad key.
- [ ] Step 2: Run → fail. Step 3: Implement. Step 4: Run → pass.
- [ ] Step 5: Commit `feat: client registry`.

### Task 4: Explicit account id + account-switch block

**Files:** Modify `server/lib.mjs` (`assertReadOnly`, `accountId`); Test `server/test/guard.test.mjs`

**Interfaces — Produces:** every `account_id`/`accountId` in URLs and GraphQL vars comes from `resolveTarget(...).accountId`; `whoami(target)` returns `{email, sessionAccountId, registryAccountId, match: boolean}`.

- [ ] Step 1: Tests: guard rejects any path containing `/switch`, `/current_account`, `/accounts/*/activate` for every method; `whoami` with session email ≠ registry email → `match:false` and tools refuse to run with an error naming both emails.
- [ ] Step 2–4: fail → implement → pass.
- [ ] Step 5: Commit `feat: explicit account ids, block account switching`.

### Task 5: Client-aware tools

**Files:** Modify `server/tools.mjs`; Create `server/scope.mjs`; Test `server/test/scope.test.mjs`

**Interfaces — Produces:**
- Every existing tool gains optional `client` and `login` args (zod), resolved via `resolveTarget`.
- `clientZapIds(target): Promise<{ids: string[], warnings: string[]}>` — union of Zaps in `folderIds` (recursing child folders via `folder.folderTree`) and Zaps whose title starts with any `namePrefixes`; a registry folder id missing from the tree → warning `folder <id> not found in <login>`.
- New tools: `list_clients` (registry with login + counts), `unmapped_folders({login})` (folders in the tree not referenced by any client), `get_zap` returns `{source:'published'|'draft', steps}` using `current_version ?? draft`, `get_run` on 500/404 → `RUN_NOT_FOUND <id>`.
- `search_runs` with `client` and no `zapIds` → scoped to `clientZapIds`.

- [ ] Step 1: Tests (stubbed fetch fixtures): folder recursion includes child-folder Zaps; prefix match is case-insensitive at title start only; missing folder gives warning not throw; draft-only Zap returns `source:'draft'`; `get_run` 500 → `RUN_NOT_FOUND`.
- [ ] Step 2–4: fail → implement → pass; `node cli.mjs list` shows 17 tools.
- [ ] Step 5: Commit `feat: client-scoped tools`.

### Task 6: Contact runs across own and login-wide Zaps

**Files:** Create `server/contact.mjs`; Modify `server/tools.mjs` (tool `contact_runs`); Test `server/test/contact.test.mjs`

**Interfaces — Produces:** `contactRuns(target, {email?, phone?, periodStart?, periodEnd?}): Promise<{client, runs: Array<{runId, zapId, zapTitle, startTime, status, ownership: 'client'|'login-wide'|'unassigned', label}>, warnings}>`
- Search 1: GraphQL ZapRuns `query=<email or phone>`, `zapIds=clientZapIds` → ownership `client`.
- Search 2: same query, no zapIds → runs not already in search 1; if the Zap belongs to another registry client → `unassigned`, label `"belongs to <other client> — excluded from <client> conclusions"`; otherwise `login-wide`, label `"<login>-wide Zap, not <client>'s"`.
- Keep a run only if the exact email (case-insensitive) or phone digits (last 10) appear in its run detail (`steps_executions` input/output JSON). Page through all results (≤10,000, warn at cap). Sorted by `startTime` ascending.

- [ ] Step 1: Tests: run in both searches appears once as `client`; partial-word hit without the exact email is dropped; phone `(813) 555-0123` matches `8135550123`; other client's Zap labelled `unassigned`; Agency ops Zap labelled `agency-wide Zap, not client-a's`.
- [ ] Step 2–4: fail → implement → pass.
- [ ] Step 5: Commit `feat: contact_runs with ownership labels`.

### Task 7: Docs and facts

**Files:** Create `zapier-factory/README.md`, `zapier-factory/docs/endpoints.md` (endpoint map, moved from `agency/zapier-re/README.md`, corrected); Modify `agency/zapier-re/README.md` → pointer to `docs/endpoints.md`.
- [ ] Step 1: Correct facts: retention ≈ 60 days (Sept 1–15 had 632 runs on Nov 12; August empty); search is whole-word, case-insensitive, all words must match; `totalActionable` caps 5,000; run status values list; REST runs endpoint; the 8 endpoints found in the Nov 12 audit.
- [ ] Step 2: Commit `docs: endpoint map and setup`.

### Task 8: Install the plugin

- [ ] Step 1: `claude plugin marketplace add C:\Users\herna\downloads\work\zapier-factory` then `claude plugin install zapier-factory@zapier-factory`.
- [ ] Step 2: Copy `clients.example.json` → `%USERPROFILE%\.zapier-factory\clients.json` if absent.
- [ ] Step 3: In a new Claude session, `/mcp` lists `zapier-internal` connected; `zapier_whoami {"login":"agency"}` returns `SESSION_EXPIRED … node login.mjs agency` (expected until Task 10).
- [ ] Step 4: Commit any fixes.

### Task 9: Skills

**Files:** Create `skills/zapier-connect/SKILL.md`, `skills/zapier-contact-audit/SKILL.md`, `skills/zapier-zap-audit/SKILL.md`, `skills/zapier-reverse-engineering/SKILL.md`

Each SKILL.md: frontmatter `name` + a `description` that says when to trigger; body ≤ 150 lines; states the read-only rule and that the official Zapier servers are not used.
- **zapier-connect:** add a login (`node <plugin>/server/login.mjs <login> --email <e>`; the human types password + OTP; Claude never types credentials), record discovered account id in `clients.json`, add/edit clients, run `unmapped_folders`, write a `.zapier-client` file in a project folder, re-login on `SESSION_EXPIRED`.
- **zapier-contact-audit:** inputs client + email/phone. Steps: `contact_runs` → `get_run full` per run → GHL side via the client's `ghl.server` if loaded, else say "GHL half needs a session in <client folder>". GHL safe-read allowlist: `get_contact_workflow_history`, `get_contact_workflow_journey`, `get_workflow`, `get_workflow_logs`, `get_workflow_runtime_window`, `get_trigger_logs`, `list_workflows`, `raw_request` with method GET only on `/contacts/`, `/opportunities/`, `/audit/search/v2`. Output: one UTC timeline (BookingKoala → Zap run → GHL field/tag → workflow → opp) with run ids, ownership labels, "no runs in the ~60-day window" stated as a window limit, not proof.
- **zapier-zap-audit:** inputs client + Zap id/title. `get_zap` (steps, mapping, filters, paths, settings, hook URL), `list_zap_versions` + members (who changed what), `search_runs` status error/halted/held/filtered/throttled with `get_run` reasons (`stop_reason.rule_dumps`, `step_errors[].error_msg`), `held_counts`.
- **zapier-reverse-engineering:** the mapping loop: capture requests in Chrome (fetch wrapper via javascript_tool, read-only clicks only), add tool + test, max 5 review/fix rounds, report by id only.
- [ ] Step 1: Write the four skills. Step 2: `claude plugin validate C:\Users\herna\downloads\work\zapier-factory` passes (or manual frontmatter check if that command is unavailable). Step 3: Commit `feat: skills`.

### Task 10: Live connect (needs the owner — OTP)

- [ ] Step 1: the owner runs `node login.mjs agency --email owner@agency.example`, then `client-b`, then Client E if it has its own login (record in `clients.json`; otherwise Client E clients point at login `agency` with folder "Client E NEW" `0100000a-0000-0000-0000-000000000002` + children).
- [ ] Step 2: `zapier_whoami` per login → `match: true`.
- [ ] Step 3: Fill clients for Agency folders (Client A, Client C "CLC |" prefix, Client D, Client E locations, CMA) and Client B; `unmapped_folders` reviewed with the owner.
- [ ] Step 4: Smoke: Client A Booking Completed Zap 900000001 → `get_zap` 5 steps; `search_runs` totalCount > 0; `get_run full` has BookingKoala output.

### Task 11: Mapping loop (after Task 10)

- [ ] Round n (max 5): fresh review agent tests every tool live via `cli.mjs` and captures unmapped read endpoints in Chrome (BillableTaskUsage, AppsWithCurrentImplementationId, Tables rows, Storage, app filter, "Running" status); fix agent adds tools + tests; coordinator verifies the report against the call log before the next round. Stop when a review finds no errors and no gaps, or after round 5 with a list of what's left.
- [ ] Final: update memories (`agency-zapier-internal-mcp`, `agency-zapier-internal-api`) to point at the plugin.
