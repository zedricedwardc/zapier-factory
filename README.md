# zapier-factory

Personal Claude Code plugin: a **read-only**, multi-login, multi-client MCP server over Zapier's internal
(browser) API. It lets Claude audit Zaps, Zap History runs, versions, connections and members for several
Zapier logins and several clients per login, without ever editing anything.

## Read-only rule

- Only `GET` to `https://zapier.com`; the only `POST` is `/api/reporting/graphql` with a single `query`
  (no `mutation`/`subscription`). Anything else throws before any network call.
- Switching Zapier's current account is a write, so it is blocked. Every call passes `account_id` from the registry.
- Passwords, OTPs and cookie values are never stored, printed or typed by the plugin. Sessions live only in
  `%USERPROFILE%\.zapier-factory\logins\<login>\` (outside any repo).
- No Zap edits, publish, on/off, replay or autoreplay, without an explicit go.

## Install

Local marketplace at `C:\Users\herna\downloads\work\zapier-factory`:

```
claude plugin marketplace add C:\Users\herna\downloads\work\zapier-factory
claude plugin install zapier-factory@zapier-factory
```

Then `cd server && npm install` once (Playwright is only needed for login).

## Connect a login

```
node server/login.mjs <login> --email <email> [--minutes 30]
```

A headed Chromium opens on Zapier. **A human types the password and OTP**; the script never fills credentials.
When `/api/v4/session` shows you logged in (as `--email`), cookies are saved to
`%USERPROFILE%\.zapier-factory\logins\<login>\session.json` and the window closes. Re-run it when a tool
reports `SESSION_EXPIRED`. `zapier_whoami` checks the session and that it matches the registry.

## Registry and client folders

`%USERPROFILE%\.zapier-factory\clients.json` (see `server/clients.example.json`):

- `logins.<login>`: `{ email, accountId }` (the Zapier account id; every call sends it).
- `clients.<client>`: `{ login, folderIds: [...], namePrefixes: [...], ghl?: {...} }`. A client owns the Zaps in
  its folders (recursively) plus Zaps whose title starts with one of its prefixes. Empty or whitespace-only
  `folderIds` / `namePrefixes` entries are rejected (they would claim every Zap).
- Ownership is decided once per login across all clients: a folder claim beats a prefix claim, and among
  folder claims the deepest (most specific) mapped folder wins. A tie left after that (same folder, folders at
  the same depth, or a title matching prefixes of 2+ clients) is a `conflict`: the Zap belongs to nobody,
  every client involved gets a warning, and it is excluded from conclusions until `clients.json` is fixed.

Put a `.zapier-client` file (just the client name) in a work folder; tools find it by walking up from the
current directory, so no `client` argument is needed there. Otherwise pass `client` (or `login`) on each call.
There is no default login: with no `client`, no `login` and no `.zapier-client` file the call fails and lists
the known clients and logins. `client` plus a different `login` is an error. A call with only `login` is
login-wide: its result carries `scope: { login, client: null, level: "login" }`.

## Tools (18)

Every tool takes optional `client` and `login` (one of them, or a `.zapier-client` file, is needed). Every result carries `scope`.

| Tool | What it does |
|---|---|
| `zapier_whoami` | Session email, user id, current account; flags a registry mismatch |
| `list_clients` | Registry clients with login, account, folder/prefix counts, `ghl: {server, locationIdCount, locationIds}`; `scope.level: "registry"` (no Zapier call) |
| `unmapped_folders` | Folders no client references (finds Zaps that belong to nobody) |
| `list_zaps` | Zaps via `zap.searchZaps` (`search`, paging, `all`, `compact`); with a client, only its Zaps plus `excluded: {login_wide, other_client, conflict}` counts |
| `list_folders` | Folder tree with ids and assetCount (counts subfolders too; login-wide) |
| `folder_assets` | Assets (Zaps and Tables) in one folder (login-wide) |
| `get_zap` | One Zap: steps with field mapping, settings, catch-hook URL; draft-only Zaps use `draft.zdl` |
| `list_zap_versions` | Version history (who/when), cursor-paged, no zdl |
| `get_zap_version` | One version including its zdl |
| `search_runs` | Zap History via GraphQL `ZapRuns` (newest first), default window now-60d to now+1d |
| `list_runs_rest` | Runs via REST; ascending order, `stop_reason` / `held_reason` per run |
| `get_run` | One run: status, stop/held reason, steps, errors; `full=true` adds step input/output |
| `held_counts` | Held-run counts by reason (login-wide) |
| `step_gives` | Fields a step produced in a run |
| `list_connections` | App connections (active / expired), with Zap counts (login-wide) |
| `contact_runs` | Every run touching one email or phone, across client and login-wide Zaps, labelled; oldest first |
| `list_members` | Account members, maps owner ids to names (login-wide) |
| `list_tables` | Zapier Tables list (login-wide) |

## Ownership labels

With a client, results say whose they are, so one client's data never reads as another's:

- `"<client>'s Zap"` (`ownership: client`)
- `"<login>-wide Zap, not <client>'s"` (`login-wide`)
- `"belongs to <other client> — excluded from <client> conclusions"` (`other-client`)
- `"claimed by <a> and <b> — fix clients.json; excluded from conclusions"` (`conflict`)
- `"run has no zap_id — ownership unknown"` (`unknown`: a run with a null or missing zap id, in `get_run`,
  `search_runs`, `list_runs_rest` and `contact_runs`)

The ownership vocabulary is exactly: `client | login-wide | other-client | conflict | unknown`.
`warnings` and `window` always come first in a result, so output truncation never cuts them.

Login-level tools (folders, connections, members, tables, held counts) return `scope.level: "login"`.
Unassignable runs are reported as such, never dropped silently.

## Gotchas

- Retention is about 60 days. All times are UTC (the Zapier UI shows the account timezone).
- Run `query` is whole-word, case-insensitive, all words must match. Email searches are reliable; a truncated
  email finds nothing. The search tokenizes stored phones (verified live 2026-11-12): `813-555-0123` is found
  only by `813 555 0123`, `+18135550123` only by `18135550123`, `8135550123` only by itself. `contact_runs`
  (at least 10 digits) therefore searches all three forms; other formats (e.g. dots) are unproven, so it
  always says zero hits is not proof. Confirm every hit with `get_run`.
- `contact_runs` returns `window` (the dates actually searched) and warns when `periodStart` is older than
  the ~60-day retention. Quote the window with every "no runs found".
- `totalCount` caps at 10,000, `totalActionable` at 5,000; run `limit` max 100.
- `periodEnd` must be in the future (now + 1 day) or today's UTC runs are dropped; the tools handle this.
- GraphQL ignores ascending sort; use `list_runs_rest` for oldest-first.
- Status values: error, error_handled, needs_review, held, throttled, halted, filtered, success, delayed,
  scheduled (`running` is rejected; UI "On hold" = held + throttled).
- Some Zaps are draft-only (`current_version` null); `get_zap` reads `draft.zdl` and says so in `source`.
- Findings cite run ids and UTC timestamps; unknown cause = "Requires investigation".

Full endpoint map, request shapes and unresolved items: [docs/endpoints.md](docs/endpoints.md).
Design: `docs/2026-11-12-zapier-factory-design.md`.
