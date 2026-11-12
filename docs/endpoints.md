# Zapier internal read API: endpoint map

First mapped 2026-11-12 from a logged-in zapier.com session; corrected and extended by the Nov 12 audit.
All rows below were proven 200 on Nov 12. **Read-only**: GET, plus POST to `/api/reporting/graphql` with one `query`.
All times are UTC. Every call needs `account_id` (the login's account) where shown.

> **The only non-read call: token renewal; changes no Zap, run or setting.**
> `POST /api/v4/jwt/refresh` — exact path, no query string, **no body**, header `X-CSRFToken: <csrftoken cookie>`,
> credentials included. This is exactly what the zapier.com app's SessionProvider sends (`refreshSubpathJWT`, every
> 600 000 ms while a tab is visible; success = 200 or 429), captured from its page scripts 2026-11-12. The guard allows
> this one request and nothing else (any query string, extra path segment, other `/api/v4/jwt/*` path, other host or a
> body is refused). Why: the asset-management tRPC service authenticates with a short-lived JWT cookie (~15 min, first
> 401 about 17 min after login, live 2026-11-12), not the Django session that REST and GraphQL use.
> `GET /api/bridge/session-cookie-status` is the read-only health check: 200 while that token is valid, 401 once expired.
> The server renews only on a trpc 401 or when `zapier_whoami` sees 401 there, once per expiry, persists the Set-Cookie
> through the normal session-save path, retries once, and reports only `renewed at <time>`. A failed renewal gives
> `TRPC_TOKEN_EXPIRED`. Live: trpc 401 at 15:51Z, renewal at 15:55:10Z, `list_folders` then 200.

## Endpoints

| Need | Call | Notes |
|---|---|---|
| Who / which account | `GET /api/v4/session` | `current_account_id`, `email`, `isLoggedIn` |
| trpc token health | `GET /api/bridge/session-cookie-status` | 200 = trpc token valid, 401 = expired (renew with the call above) |
| Account members | `GET /api/v4/accounts/{acct}/members` | maps zapOwner / customuser ids to names |
| All Zaps | `GET /api/asset-management-bff/trpc/zap.searchZaps?input={limit,offset,order,search,status,apps}` | `limit` up to 500. Filters (the UI's own, proven live 2026-11-12): `search` (text), `status: 'on' \| 'off'` (128 + 167 = 295), `apps: '<selectedApi>'` as ONE **string** (40 Zaps for BookingKoalaCLIAPI; an array gives 400). Rows: `id` (number), `zapId` (UUID), `title`, `updatedAt`, `ownerId`, `apps` (each app twice: bare + `@version`), `lastRunAt` (not on every page: missing on the unfiltered 500-row page). No on/off or folder |
| Zaps (GraphQL) | `POST /api/reporting/graphql` op `ZapSearch` (cursor walk) / `ZapsById` | The UI's texts with `isEnabled` added: `zaps(accountId, cursor, limit, title: $search) { cursor edges { id isEnabled title container @include(if: $includeFolder) { id title } } totalCount }` and `zaps(accountId, ids)`. **25 edges per call** whatever `limit` (ZapsById caps silently at 25 ids; 295 ids gives 400). Session-authenticated, so it keeps working when the trpc token expires. Zap has no `apps` / `updatedAt` / `lastRun` here (400). `list_zaps` reads on/off + folder from these |
| Folders | `GET .../trpc/folder.folderTree?input={}` | tree with names + assetCount; **assetCount counts the folder and all its subfolders** (verified live 2026-11-12) |
| Assets in a folder | `GET .../trpc/asset.getHydratedFolderAssets?input={folderId,limit,offset}` | `{meta:{count,limit,offset}, links, results[]}`; `meta.count` = this folder's own total; limit honoured. Row `type` is `zap` or `table`; a Zap row's `id` is a UUID embedding the numeric id (`00000000-0000-c000-8000-000900000001` = 900000001), also in `searchZap.id` / `currentVersion.zapId` (verified live 2026-11-12) |
| Zap definition | `GET /api/gulliver/storage/v1/zaps/{zapId}?account_id=` | `is_enabled`, `folder_id`, `current_version.zdl.steps[]` (app, action, params = field mapping). Draft-only Zaps: `current_version` is null, use `draft.zdl` (44 such Zaps in Agency) |
| Version list | `GET /api/gulliver/storage/v1/zaps/{zapId}/versions?account_id=` | who/when; cursor-paged 25 via `meta.next_cursor`; **no zdl** in the list |
| One version | `GET .../zaps/{zapId}/versions/{versionId}?account_id=` | includes `zdl` |
| Zap settings | `GET /api/gulliver/zapsettings/v1/zaps/{id}/settings?account_id=` | autoreplay, error ratio, flood protection, polling |
| Catch hook / trigger | `GET /api/gulliver/steptesting/v1/zaps/{id}/subscriptions?account_id=` | `hook_url`, `trigger_type` |
| Fields a step gives | `GET /api/gulliver/steptesting/v1/zaps/{zapId}/steps/{stepId}/output/run/{runId}/gives` | key + sample value. Captured without `account_id`; whether it accepts one is unverified, so the tool calls it as captured (the session account was checked against the registry at most 60 s earlier; the check is cached for 60 s) |
| Run list / search (GraphQL) | `POST /api/reporting/graphql` op `ZapRuns` (query only) | vars: zapIds, folderIds, status, query, periodStart/End, limit, offset, plus (types from the UI's ZapRuns text) `$apps: [String!]`, `$channel: String`, `$channelError: String`, `$customuserIds: [ID!]`, `$heldReasons: [HeldReason!]` (`stale_auth`, `plan_limit`, `task_limit`, `step_limit`, `throttled`, `too_many`, `revoked_auth_access`, `unknown`, ...), `$heldStaleAuthIds: [String!]`. Live 2026-11-12: heldReasons `stale_auth` = 60 = heldStaleAuthIds of that auth = held_counts. Newest first only |
| Run list (REST) | `GET /api/zap-history/v2/runs` | params: `account_id`, `zap_ids`, `statuses`, `query`, `from_date`, `to_date`, `limit` (<=100), `offset`, `order_by`. Ascending works. Response `{meta:{offset,limit,count,total_actionable}, results:[...]}` (rows under **`results`**, `zap_id` a string; live 2026-11-12). Rows carry `stop_reason` / `held_reason` and `steps_executions`; `list_runs_rest` drops `steps_executions` unless `full:true` (adds `steps` = count) and defaults `from_date`/`to_date` to now-60d..now+1d (without dates the count differs: 414 vs 417) |
| One run, full data | `GET /api/zap-history/v2/runs/{runId}?account_id=` | `steps_executions[]` with input (sent) and output (received) |
| Held counts | `GET /api/zap-history/v2/runs/held-count?account_id=&group_by=reason&include_shared_with=false` | counts by held reason |
| Connections | `GET .../trpc/authentication.authentications?input={includeZapCount,limit,offset,ordering,owner,search,selectedApi,status}` | `limit` <=100; `status` is `active`, `expired` or `all` |
| Tables | `GET .../trpc/table.search?input={limit,offset,kind:'both',orderBy}` | table list only: `{data:[...], meta:{limit,offset,count}, links}` (rows under **`data`**, not `results`; live 2026-11-12) |
| Task usage | GraphQL `BillableTaskUsage` (tool `task_usage`) | Query text verbatim from the zapier.com usage bundle (in `server/tools.mjs` `TASK_USAGE_QUERY`). vars: apps, customuserIds, folderIds, zapIds, periodStart/End (ISO works), timezone. Returns `billableTaskUsage {interval, tasksByDate, totalBillableCount}` + `billableTopZaps {edges {apps, billableTasks, lastRun, zap {id, isEnabled, owner, title}, zapId}, totalMatchedZapCount, deletedZaps}`. Interval is chosen by Zapier (60-day window = `month`, no dates = ~30 days by `day`). Live: one client 276 tasks over 5 Zaps (= the UI) |
| Apps | GraphQL `AppsWithCurrentImplementationId` (tool `list_apps`) | `appsByCurrentImplementationId(ids: [ID!]!)` + fragment `AppResult` {currentImplementation{id} id images name slug}. Ids must be versioned (`BookingKoalaCLIAPI@2.3.0` = app 13148, `HighLevelCLIAPI@3.0.4` = 14219); a bare id returns nothing. The UI text puts the fragment first; the guard requires text starting with `query`, so the tool sends the fragment after the query (proven live) |

GraphQL introspection is off. Query texts are copied from the zapier.com app bundles, never invented.

## Which auth each surface uses

- **Django session** (`/api/v4/session`, long-lived): REST zap-history, gulliver storage/settings/steptesting, members,
  and the reporting GraphQL (ZapRuns, ZapSearch, ZapsById, BillableTaskUsage, AppsWithCurrentImplementationId).
- **trpc JWT** (~15 min, renewed by the one POST above): `folder.folderTree`, `asset.getHydratedFolderAssets`,
  `zap.searchZaps`, `authentication.authentications`, `table.search`.
- The client claim map reads the Zap list (id, title) from one trpc `zap.searchZaps` call (500 per page) and the
  folder hierarchy and contents from trpc (folders 4 at a time); it is cached per login for 5 minutes. If renewal
  is refused, the Zap list comes from GraphQL `ZapSearch` (id, title, own folder) and scope falls back to each Zap's own folder plus
  name prefixes with a loud `FOLDER READS FAILED` warning naming the unchecked subfolders.

## Corrected facts (these replace the old README)

- **Retention is about 60 days**, not 30. Sept 1-15 still had 632 runs on Nov 12; August was empty.
- **Search `query` is whole-word and case-insensitive; all words must match.** The local part of an email finds
  that email's runs; a truncated email finds 0; a nonsense word finds 0. (The old "email exact / word fuzzy" was wrong.)
  Still confirm each hit with the run's own data.
- `totalCount` caps at **10,000**; `totalActionable` caps at **5,000**.
- `ZapRuns` `limit` is at most 100.
- **Ascending `sortBy` is ignored in GraphQL.** Use the REST runs endpoint (`order_by=start_time`) for oldest-first.
- **Status values:** `error`, `error_handled`, `needs_review`, `held`, `throttled`, `halted`, `filtered`,
  `success`, `delayed`, `scheduled`, `pending`, `skipped`. UI "Running" = `pending` (the UI label map also maps `replay`
  to Running, but `replay`, `playing` and `running` return 400 as filters). UI "On hold" = `held` + `throttled`.
- **Today's runs vanish if `periodEnd <= now`.** Always use `periodEnd = now + 1 day`.
- `zap.searchZaps`: text filter key is `search`; `limit` up to 500.
- Versions list is cursor-paged (25 per page, `meta.next_cursor`) and carries no zdl; fetch one version for its zdl. A URL cursor is followed only when its path is `/api/gulliver/storage/v1/zaps/<same zapId>/versions` on zapier.com (else `CURSOR_REJECTED`).
- API times are UTC; the UI shows the account timezone.
- A run's trigger output can carry a full record (e.g. a booking, ~104 fields).

## Where data sits in a run

- **Paths:** `BranchingAPI` steps; branch steps hang under them via `parent_id`. Branches that did not run have
  status null or `skipped`.
- **Filter stops:** the reason is in `stop_reason.rule_dumps`.
- **Errors:** step `step_errors.error_msg` — `step_errors` is ONE object `{id, error_msg, title, code, status, version}` per failed step (verified live 2026-11-12), not an array; `get_run` accepts both.
- Per-step input/output: `steps_executions[].input` / `.output` (or `step_gives`).

## Not mapped (by decision)

- **Table rows.** Zapier Tables live on `https://tables.zapier.com/app/tables` (a different origin, per the app
  bundles). The read-only guard allows only `https://zapier.com`, and widening the host allowlist was ruled out
  (2026-11-12), so table rows are not mapped; only the table list (`list_tables`) is.
- **Storage by Zapier.** No Storage surface exists in any zapier.com app bundle (`zap.storageZaps` is Zap storage,
  not Storage by Zapier), so it is not reachable from the UI session.

## Unresolved

- What `channel` / `channelError` filter on (accepted by GraphQL, meaning unproven).
- Version-list paging (`meta.next_cursor`) cannot be exercised live yet: all 295 Zaps on the live login were scanned (2026-11-12) and none lists more than 2 versions, so no first page carries a `next_cursor`. Paging is covered by offline tests only.

## Never

No Zap edits, publish, on/off, replay, autoreplay, account switching, or any write. The single non-read call is the
trpc token renewal (`POST /api/v4/jwt/refresh`, see the top); it changes no Zap, run or setting.
