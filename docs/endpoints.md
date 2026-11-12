# Zapier internal read API: endpoint map

First mapped 2026-11-12 from a logged-in zapier.com session; corrected and extended by the Nov 12 audit.
All rows below were proven 200 on Nov 12. **Read-only**: GET, plus POST to `/api/reporting/graphql` with one `query`.
All times are UTC. Every call needs `account_id` (the login's account) where shown.

## Endpoints

| Need | Call | Notes |
|---|---|---|
| Who / which account | `GET /api/v4/session` | `current_account_id`, `email`, `isLoggedIn` |
| Account members | `GET /api/v4/accounts/{acct}/members` | maps zapOwner / customuser ids to names |
| All Zaps | `GET /api/asset-management-bff/trpc/zap.searchZaps?input={limit,offset,order,search}` | `limit` up to 500. Text filter key is `search`; other filter keys (e.g. app) are silently ignored. Rows: `id`, `zapId`, `title`, `apps`, `lastRunAt` |
| Folders | `GET .../trpc/folder.folderTree?input={}` | tree with names + assetCount; **assetCount counts the folder and all its subfolders** (verified live 2026-11-12) |
| Assets in a folder | `GET .../trpc/asset.getHydratedFolderAssets?input={folderId,limit,offset}` | `{meta:{count,limit,offset}, links, results[]}`; `meta.count` = this folder's own total; limit honoured. Row `type` is `zap` or `table`; a Zap row's `id` is a UUID embedding the numeric id (`00000000-0000-c000-8000-000900000001` = 900000001), also in `searchZap.id` / `currentVersion.zapId` (verified live 2026-11-12) |
| Zap definition | `GET /api/gulliver/storage/v1/zaps/{zapId}?account_id=` | `is_enabled`, `folder_id`, `current_version.zdl.steps[]` (app, action, params = field mapping). Draft-only Zaps: `current_version` is null, use `draft.zdl` (44 such Zaps in Agency) |
| Version list | `GET /api/gulliver/storage/v1/zaps/{zapId}/versions?account_id=` | who/when; cursor-paged 25 via `meta.next_cursor`; **no zdl** in the list |
| One version | `GET .../zaps/{zapId}/versions/{versionId}?account_id=` | includes `zdl` |
| Zap settings | `GET /api/gulliver/zapsettings/v1/zaps/{id}/settings?account_id=` | autoreplay, error ratio, flood protection, polling |
| Catch hook / trigger | `GET /api/gulliver/steptesting/v1/zaps/{id}/subscriptions?account_id=` | `hook_url`, `trigger_type` |
| Fields a step gives | `GET /api/gulliver/steptesting/v1/zaps/{zapId}/steps/{stepId}/output/run/{runId}/gives` | key + sample value. Captured without `account_id`; whether it accepts one is unverified, so the tool calls it as captured (the session account was checked against the registry at most 60 s earlier; the check is cached for 60 s) |
| Run list / search (GraphQL) | `POST /api/reporting/graphql` op `ZapRuns` (query only) | vars: zapIds, folderIds, status, query, periodStart/End, limit, offset. Newest first only |
| Run list (REST) | `GET /api/zap-history/v2/runs` | params: `account_id`, `zap_ids`, `statuses`, `query`, `from_date`, `to_date`, `limit` (<=100), `offset`, `order_by`. Ascending works. `meta.count`; runs carry `stop_reason` / `held_reason` |
| One run, full data | `GET /api/zap-history/v2/runs/{runId}?account_id=` | `steps_executions[]` with input (sent) and output (received) |
| Held counts | `GET /api/zap-history/v2/runs/held-count?account_id=&group_by=reason&include_shared_with=false` | counts by held reason |
| Connections | `GET .../trpc/authentication.authentications?input={includeZapCount,limit,offset,ordering,owner,search,selectedApi,status}` | `limit` <=100; `status` is `active`, `expired` or `all` |
| Tables | `GET .../trpc/table.search?input={limit,offset,kind:'both',orderBy}` | table list only |
| Task usage | GraphQL `BillableTaskUsage` | vars: apps, customuserIds, folderIds, zapIds, periodStart/End, timezone. **Query text not captured** |
| Apps | GraphQL `AppsWithCurrentImplementationId` | **Query text not captured** |

GraphQL introspection is off. Do not invent query text for the two uncaptured operations; copy it from the
browser's network tab first.

## Corrected facts (these replace the old README)

- **Retention is about 60 days**, not 30. Sept 1-15 still had 632 runs on Nov 12; August was empty.
- **Search `query` is whole-word and case-insensitive; all words must match.** The local part of an email finds
  that email's runs; a truncated email finds 0; a nonsense word finds 0. (The old "email exact / word fuzzy" was wrong.)
  Still confirm each hit with the run's own data.
- `totalCount` caps at **10,000**; `totalActionable` caps at **5,000**.
- `ZapRuns` `limit` is at most 100.
- **Ascending `sortBy` is ignored in GraphQL.** Use the REST runs endpoint (`order_by=start_time`) for oldest-first.
- **Status values:** `error`, `error_handled`, `needs_review`, `held`, `throttled`, `halted`, `filtered`,
  `success`, `delayed`, `scheduled`. `running` returns 400. UI "On hold" = `held` + `throttled`.
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

## Unresolved

- Tables **rows** (only the table list is mapped) and Storage.
- Which filter value the UI's "Running" maps to (the API rejects `running`).
- `searchZaps` app filter key (only `search` works so far).
- Query text for `BillableTaskUsage` and `AppsWithCurrentImplementationId`.
- GraphQL types for `apps`, `channel`, `channelError`, `customuserIds`, `heldReasons`, `heldStaleAuthIds`.

## Never

No Zap edits, publish, on/off, replay, autoreplay, account switching, or any write.
