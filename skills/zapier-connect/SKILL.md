---
name: zapier-connect
description: "Connect and manage Zapier logins and the client registry for the read-only zapier-internal MCP. Use when the user wants to add or connect a Zapier login (\"connect Client B Zapier\", \"log in to Zapier\"), when any zapier-internal tool returns SESSION_EXPIRED or a session/registry mismatch, to check who is logged in, to add or edit a client (folder ids, Zap name prefixes, GHL server), to find folders that belong to no client (unmapped folders), or to point a project folder at a client with a .zapier-client file."
---

# Zapier Connect

Sets up what every other zapier-factory skill relies on: a saved Zapier session per **login**, and a
**registry** that maps each client to a login, its Zapier account id, its folders and name prefixes.

## Hard rules

- **Read-only.** The zapier-internal MCP tools only read. Nothing in this skill edits a Zap, switches the
  Zapier account, replays a run or turns anything on or off.
- **Claude never types credentials.** The human types the password and OTP in the login window. Claude
  never fills, asks for, stores or prints a password, OTP or cookie value.
- **Never read or print session files.** `%USERPROFILE%\.zapier-factory\logins\<login>\` holds cookies.
  Do not `cat`, Read, copy or summarise anything in it. Check a session with `zapier_whoami` instead.
- **Never use the official Zapier servers** (`Zapier-Agency`, `Zapier-Client-B`, `Zapier-MCP`). They have write
  tools. Only the zapier-internal MCP tools are used (they appear as
  `mcp__plugin_zapier-factory_zapier-internal__<tool>` or similar; this skill names them bare).

## Where things live

| What | Where |
|---|---|
| Session per login | `%USERPROFILE%\.zapier-factory\logins\<login>\` (outside any repo; never read it) |
| Registry | `%USERPROFILE%\.zapier-factory\clients.json` (shape: `server/clients.example.json`) |
| Folder default | a `.zapier-client` file holding one client name; tools find it walking up from the cwd |

Registry shape:

```json
{
  "logins":  { "<login>": { "email": "<login email>", "accountId": "<zapier account id or null>" } },
  "clients": { "<client>": { "login": "<login>", "folderIds": ["<folder uuid>"],
               "namePrefixes": ["<Zap title prefix>"],
               "ghl": { "server": "<ghl internal mcp server name>", "locationIds": [] } } }
}
```

Login and client names match `/^[a-z0-9-]+$/`. A client owns the Zaps in its folders (recursively) plus
Zaps whose title starts with one of its prefixes; empty or whitespace-only `folderIds` / `namePrefixes`
entries are rejected. Ownership is decided once per login across all clients: a folder claim beats a
prefix claim, the deepest mapped folder beats an outer one, and any tie left is a `conflict`. `ghl.server` names the GHL internal MCP server for that
client (e.g. `uxie-ghl-internal-mcp`, `uxie-ghl-internal-mcp-client-b`).

## 1. Add a login (or re-login)

1. Pick a login name (e.g. `agency`, `client-b`) and confirm the login email with the user.
2. Run, in the background or a terminal the user can see:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/server/login.mjs" <login> --email <email> [--minutes 30]
   ```

   A headed Chromium opens on Zapier. Tell the user: "Type the password and OTP in the window; I won't
   touch it." Wait. The script closes the window and saves the session when Zapier shows the user logged
   in as `--email`. If it times out (`--minutes`), run it again.
   If Playwright is missing, run `npm install` once in `${CLAUDE_PLUGIN_ROOT}/server`.
3. Call `zapier_whoami` with `login: "<login>"`. It returns `email`, `user_id`, `current_account_id` and
   `match`.
4. New login: add `logins.<login>` to `clients.json` with the email and `accountId` set to the
   `current_account_id` that `zapier_whoami` returned (as a string). Show the user the diff before saving.
   Never change an existing `accountId` without the user's OK: a different account means a different
   Zapier account, not a typo.
5. Run `zapier_whoami` again: `match` must be `true`. Every other tool refuses to run until it is.

**Re-login on `SESSION_EXPIRED`:** any tool can return it. Run step 2 for that login (same email), then
`zapier_whoami`, then retry the call that failed once. If it fails the same way, stop and report it.

**The trpc token (`trpc_token` in `zapier_whoami`).** Folders, folder assets, the trpc Zap list, connections and
tables use a ~15-minute token that the server renews by itself with the zapier.com app's own
`POST /api/v4/jwt/refresh` (the plugin's only non-read call; it changes no Zap, run or setting). A result that
renewed it carries `"renewed at <time>"` in `warnings`; nothing to do. `TRPC_TOKEN_EXPIRED` means the renewal was
refused: runs, run detail and the GraphQL/REST tools still work; re-login (step 2) for the rest. Client scope then
warns `FOLDER READS FAILED` (subfolders unchecked): say the client's Zap list may be incomplete.

**Mismatch** (`match: false`): the saved session is a different email or account than the registry.
Show both values to the user and ask which is right. Do not switch accounts in Zapier to "fix" it
(switching is a write and is blocked).

## 2. Add or edit a client

1. `list_clients` shows what exists (no Zapier call).
2. Find the client's folders: `list_folders` with `login: "<login>"` (login-wide tree with ids and
   `assetCount`); `folder_assets` lists what is in one folder. For prefix-named Zaps use
   `list_zaps` with `search`.
3. Write `clients.<client>` with `login`, `folderIds`, `namePrefixes` and, when the client has a GHL
   internal MCP, `ghl.server` (+ `locationIds` if known). Show the diff, then save.
4. Check: `list_zaps` with `client: "<client>"` should return the client's Zaps, each with
   `ownership: "client"`. Spot-check a few titles with the user.
5. Overlaps: a Zap in a subfolder mapped to client B, inside a folder mapped to client A, is B's (the
   deepest mapped folder wins; both clients get a "nested inside" note). A Zap that two clients still claim
   equally (the same folder, folders at the same depth, or a title matching prefixes of both, with no
   folder claim) is labelled `ownership: "conflict"` ("claimed by <a> and <b> — fix clients.json; excluded
   from conclusions") for every client, and every client involved gets a warning. Tell the user and fix the
   folders or prefixes until no `conflict` warning is left; never leave a Zap claimed by two clients.

## 3. Find unmapped folders

`unmapped_folders` with `login: "<login>"` lists folders no client references (neither the folder nor an
ancestor). Report them by name and id with their `assetCount` and ask the user who owns each. Zaps in
them read as `login-wide` (`"<login>-wide Zap, not <client>'s"`) in every client's audit until mapped.

## 4. Point a project folder at a client

Write a `.zapier-client` file in the project folder containing only the client name (one line, no
quotes). Tools called from that folder (or below) then default to that client, so `client` can be left
out. Confirm it by reading the file back (it must hold exactly the client name), or by running
`node "${CLAUDE_PLUGIN_ROOT}/server/cli.mjs" zapier_whoami '{}'` with that folder as the working directory:
it must resolve (no "No client or login given" error) and return `match: true`. `list_clients` does not
read `.zapier-client`, so it proves nothing here.
Only write this file where the user says; never in a folder that already belongs to another client.

## Report

Say which login, email and account id are connected, `match` from `zapier_whoami`, the clients added or
changed (names, folder ids, prefixes, GHL server), and any unmapped folders left. Never include cookie
values, session paths' contents, passwords or OTPs.
