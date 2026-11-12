---
name: zapier-zap-audit
description: "Audit one Zap read-only: its setup (on/off, steps, field mapping, filters, paths, settings, catch-hook URL), its version history and who changed what, and its failed, halted, held, filtered and throttled runs with the reason for each. Use when the user asks why a Zap is failing or not running, what a Zap does, who changed a Zap and when, why runs are held/filtered/halted, what a filter or path checks, where a webhook points, or wants a Zap health check for a client."
---

# Zapier Zap Audit

One Zap, read-only: what it is set up to do, who changed it, and every run that did not end in success, with
why. **Nothing is edited, replayed, published or turned on/off.**

## Hard rules

- **Read-only.** Only the zapier-internal MCP tools (named bare here; in a session they look like
  `mcp__plugin_zapier-factory_zapier-internal__get_zap`). The server refuses anything but reads.
- **Never use the official Zapier servers** (`Zapier-Agency`, `Zapier-Client-B`, `Zapier-MCP`).
- **Pass `client`** (or work in a folder with a `.zapier-client` file). The result's `ownership` says whose
  Zap it is (`client | login-wide | other-client | conflict | unknown`). If it is anything but `client`,
  stop and tell the user before auditing it as the client's; a `conflict` means clients.json must be fixed
  first (zapier-connect skill).
- **Exact numbers only; every finding cites run ids, version ids and UTC timestamps.** Unknown cause =
  "Requires investigation". Run data stays in the client's systems; the report cites ids.

## Inputs

**client** + a **Zap id** (numeric, `list_zaps` `id`) or **title**. With a title, `list_zaps` with
`client` and `search: "<words>"`; if more than one matches, list them (id, title, folder) and ask.

## Steps

1. **Setup.** `get_zap` with `zapId` (settings and hook included by default). Record:
   - `is_enabled`, `folder_id`, `source` (`published` or `draft`; draft-only Zaps have no live version),
     `has_unpublished_draft` (someone has edits not live), `version_id`.
   - Each step: app, action, `params` (the field mapping: which trigger field feeds which target field).
     Filters (rules), Paths (`BranchingAPI` steps with branch rules), Formatter/Code steps, delays.
   - `settings`: autoreplay, error ratio, flood protection, polling.
   - `subscriptions`: `hook_url` and `trigger_type` (what calls this Zap).
2. **Who changed what.** `list_zap_versions` (walks all pages) gives each version's id, time and author id.
   `list_members` maps author ids to names (login-wide). To see what changed, `get_zap_version` on the two
   versions around a date and compare their zdl steps/params. Name the field that changed, from → to.
3. **Bad runs.** `search_runs` with `client`, `zapIds: ["<id>"]`, and `status` in
   `["error", "halted", "held", "filtered", "throttled"]` (add `error_handled`, `needs_review`, `delayed`
   when relevant). Default window is now-60d to now+1d; keep `periodEnd` in the future. Use `all: true` to
   page; quote `totalCount` (caps at 10,000; say so if hit). For oldest-first or `stop_reason` /
   `held_reason` in the list itself, use `list_runs_rest` with `zap_ids`, `statuses` and
   `order_by: "start_time"` (rows under `results`, compact; `trigger_title` there is the trigger step's title,
   not the Zap's). UI "Running" = status `pending`.
   Task use: `task_usage` with `client` and `zapIds: ["<id>"]` (billable tasks in the window, by date).
   Also count successes in the same window (`status: ["success"]`) so the failure rate is exact.
4. **Why each failed.** `get_run` per run (`full: true` only when the data matters):
   - Filter stop: `stop_reason.rule_dumps` (which rule, which value).
   - Error: `steps[].errors` (from `step_errors.error_msg`; live `step_errors` is one object per step) and which step.
   - Held / delayed: `held_reason`, `delayed_reason`.
   - Paths: which branch ran (status null/skipped = branch not run).
   Group runs by identical reason; cite every run id (or the first 10 + the count when there are many).
5. **Account context (login-wide).** `held_counts` for held runs by reason across the login; label it
   login-wide. `list_connections` (`status: "expired"`) when an error points to an expired auth; match the
   connection by app and title, and say it is login-wide.
6. **Hook and upstream.** If runs are missing rather than failing, compare the `hook_url` with what the
   source system (e.g. BookingKoala/Launch27 webhook) calls; that check happens in the source system,
   read-only. Missing runs inside the ~60-day window = "no runs found in the window", not proof the trigger
   never fired.

## Output

1. **Zap**: id, title, owner (`ownership` label), on/off, source (published/draft), unpublished draft yes/no,
   folder, trigger + hook URL, settings worth noting.
2. **Steps**: numbered list, app → action, key mappings, filter rules, path rules.
3. **Changes**: table `Version id | Time (UTC) | Who | What changed` (newest first).
4. **Runs in window** (<periodStart> to <periodEnd> UTC): counts per status, exact.
5. **Problems**: one row per reason group: `Reason | Runs (count) | Run ids | First / last (UTC) | Cause`.
   Cause is proven from the data or "Requires investigation".
6. **Limits**: window, caps hit, anything login-wide, anything not checked.

Never suggest replay, autoreplay changes or edits as done; a proposed fix is a proposal for the user.
