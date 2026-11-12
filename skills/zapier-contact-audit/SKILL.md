---
name: zapier-contact-audit
description: "Audit one contact across Zapier and GoHighLevel: find every Zap run that touched an email or phone (~60-day Zap History), what each run received and sent, and line it up with the contact's GHL workflow history, tags, fields and opportunities in one UTC timeline. Use when the user asks what happened to a contact/lead/customer, why a booking did not reach GHL, why a tag or field is wrong, why a contact got (or missed) a message or opportunity, \"trace this contact through Zapier\", \"which Zaps ran for <email>\", or any TAO-style investigation that involves Zapier and BookingKoala/Launch27 data."
---

# Zapier Contact Audit

One contact, one client, one timeline: booking system → Zap run → GHL field/tag → GHL workflow → opportunity.
**Read-only end to end.**

## Hard rules

- **Read-only.** Use only the zapier-internal MCP tools (named bare here; in a session they look like
  `mcp__plugin_zapier-factory_zapier-internal__contact_runs`). No replay, no Zap edits, no on/off.
- **Never use the official Zapier servers** (`Zapier-Agency`, `Zapier-Client-B`, `Zapier-MCP`).
- **GHL safe-read allowlist, nothing else** (tools appear as `mcp__<ghl.server>__<tool>`):
  `get_contact_workflow_history`, `get_contact_workflow_journey`, `get_workflow`, `get_workflow_logs`,
  `get_workflow_runtime_window`, `get_trigger_logs`, `list_workflows`, and `raw_request` with
  `method: "GET"` only, on paths starting `/contacts/`, `/opportunities/` or `/audit/search/v2`.
  Never `get_contact_ai_status` or anything touching employeeConfigs (those GETs write). No GHL writes.
- **Customer data stays in the client's systems.** The timeline names records by id. Do not paste run
  input/output, emails or phones into anything outside the client's own systems (no other client's
  docs, no public pages, no shared channels).
- **Exact numbers only; every finding cites a run id or GHL record id and a UTC timestamp.** Unknown cause =
  "Requires investigation". No guessing.

## Inputs

- **client** (registry name; or the folder's `.zapier-client`). Required: `contact_runs` refuses without one.
- **email and/or phone** of the contact. Optional: a date range (ISO UTC) and the client's timezone.
If the client is not in the registry, use the zapier-connect skill first.

## Steps

1. **Find the runs.** `contact_runs` with `client`, `email` and an explicit `periodStart` / `periodEnd`
   (ISO UTC). Default to `periodStart` = now − 60 days and `periodEnd` = now + 1 day unless the user gave a
   range. If a phone is known too, call it again with `phone` and the same window (the tool takes exactly
   one; a phone needs at least 10 digits) and merge by `runId`. Each run carries `runId`, `zapId`,
   `zapTitle`, `startTime` (UTC), `status`, `ownership` and `label`. The result starts with `warnings` and
   `window`: read every warning and carry into the report any retention, cap (skipped startTime range),
   failed-detail, "N of M candidate runs did not contain the exact contact", conflict or phone-recall
   warning.
   - `ownership: "client"` = the client's Zap. `login-wide` = `"<login>-wide Zap, not <client>'s"`: show it,
     labelled, but do not draw client conclusions from it alone. `other-client` = another client's Zap:
     list it as excluded, never mix its data in. `conflict` = two clients claim the Zap: list it as
     excluded and say clients.json needs fixing. `unknown` = no Zap id: report it as unassignable.
   - **Zero runs** means "no runs found in the window <window.periodStart> to <window.periodEnd> UTC", quoting
     the `window` the tool returned. That is a retention/search limit, not proof the contact had no
     activity. Say so in those words; for a phone search add that only the plain, +1 and dash/space/parenthesis
     phone formats are searched (others, e.g. dots, are unproven).
2. **Read the runs, by ownership.** `get_run` with `runId` and `full: true` on every `client` run. A
   `login-wide` run only when it bears on this contact (e.g. it wrote to the client's GHL). **Never call
   `get_run` on an `other-client` run**: list its run id and owning client (from its `label`) as excluded.
   For each run read, note the trigger data (booking id, service,
   date, status from BookingKoala/Launch27), what each step sent and got back, `stop_reason`
   (`stop_reason.rule_dumps` for filter stops), `held_reason`, `steps[].errors` (from `step_errors.error_msg`), which Paths branch
   ran (branch steps hang under `BranchingAPI` via `parent_id`; status null/skipped = not run).
   `step_gives` shows the exact fields a step handed on, when the mapping matters.
3. **Load the Zap only if needed.** `get_zap` on a Zap whose behaviour must be explained (field mapping,
   filters). For "who changed it", use the zapier-zap-audit skill.
4. **GHL half.** Call `list_clients` (no Zapier call) and take the client's row: `ghl.server` is its GHL
   internal MCP server, and the **locationId comes only from that row's `ghl.locationIds`** (one GHL server
   can be bound to several client locations). Do not read `clients.json` directly. If `ghl` is null, or
   `ghl.locationIdCount` is 0 or more than 1, stop and ask the user which location; never guess, never
   search all locations. Every GHL call uses that locationId and every GHL row cites it.
   - If that server's tools are loaded in this session: find the contact with `raw_request` GET
     `/contacts/?locationId=<locationId>&query=<email or phone>` (or `/contacts/<contactId>`), then
     `get_contact_workflow_history` / `get_contact_workflow_journey` for which workflows ran and when,
     `get_workflow_logs` / `get_workflow_runtime_window` (custom dates; an empty default read is not
     expiry) for step detail, `get_trigger_logs` for trigger matches, `raw_request` GET
     `/opportunities/...` for opps and `/audit/search/v2?id=<contactId or oppId>` for who changed a field,
     tag or stage.
   - If it is not loaded: deliver the Zapier half and write "GHL half needs a session in <client folder>"
     (the folder whose `.mcp.json` registers that server). Do not try another client's GHL server.
5. **Line it up.** Match each Zap run to the GHL change it made (same field/tag value, a few seconds
   later) and to the workflow it triggered. A Zap step that succeeded but has no matching GHL change is a
   finding; so is a GHL change with no Zap run behind it (name its audit-log actor).
6. **Booking system wins.** If GHL disagrees with BookingKoala/Launch27 (as carried in the trigger data),
   report the mismatch; never suggest editing GHL to make numbers agree.

## Output

A heading with client, contact reference (GHL contact id, not the email, if the report leaves the
client's systems), window searched, and runs found by ownership. Then **one timeline, oldest first, UTC**:

| Time (UTC) | System | What happened | Evidence id | Ownership |
|---|---|---|---|---|
| 2026-11-03 14:02:11 | BookingKoala | Booking created (trigger data of run below) | run 1234567890 | client |
| 2026-11-03 14:02:13 | Zapier | "BS - Booking Created" ran: success, wrote tag `booked` | run 1234567890 | client |
| 2026-11-03 14:02:15 | GHL | Tag `booked` added | loc 3fQx... / audit 65f0... | client |
| 2026-11-03 14:02:16 | GHL | Workflow "Booking Confirmed" enrolled | loc 3fQx... / wf 9a1b... / log 77c2... | client |
| 2026-11-03 14:03:02 | Zapier | "Agency - Lead Sync" filtered (rule: status = new) | run 1234567999 | login-wide |

Rules for the table: times from the API in UTC, to the second; add a local-time column only when the
client's timezone is stated, labelled (e.g. "Time (CT)"). Evidence id is a run id, workflow id + log id,
opp id or audit id. The Ownership column holds only the enum value: `client`, `login-wide`,
`other-client`, `conflict` or `unknown` (GHL rows: `client`). Illustrative rows above are not real data.

Every GHL row's evidence includes the location id (e.g. `loc 3fQx... / wf 9a1b...`).

Then **Findings**: each one cites its evidence ids + UTC times; cause proven or "Requires investigation".
Then **Limits**: the `window` the tool returned (quoted), any `warnings`, GHL half delivered or not (and
why), runs excluded as `other-client` or `conflict`, runs with `unknown` ownership.
