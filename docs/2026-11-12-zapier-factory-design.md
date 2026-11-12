# Zapier Factory plugin — design

Date: 2026-11-12 · Owner: owner · Status: draft for approval

## Intent (why)
The owner audits GHL systems for clients (TAO Errors at Agency, Client B, etc.). Much of what lands in GHL is pushed by Zapier (BookingKoala → Zap → GHL tag/field → workflow → opportunity), and Zapier is a blind spot today: reading it means clicking through zapier.com in Chrome. He wants Claude to read **Zaps and a contact's Zapier history** and use it **together with the GHL internal MCP (uxie-ghl-factory)** so an audit has the complete chain.

## Goals
1. Read-only access to any client's Zapier, packaged as a Claude Code plugin with skills, in the style of uxie-ghl-factory.
2. **Multiple Zapier logins.** Some clients have their own Zapier login (e.g. Client B); others share Agency's Zapier and are separated by a folder or Zap-name prefix (e.g. "Client A Cleaning" folder, "CLC | …" names). Agency manages 3 agencies; all must be readable, possibly in one session.
3. **Client registry:** a small list mapping client name → Zapier login + (for shared logins) folder ids / name prefixes. All audit tools take a client (or login) name; run searches are scoped to that client's Zaps so data never mixes between clients.
4. Skills:
   - **connect** — add a Zapier login (Playwright window, the human types password + OTP), check who's logged in, re-login on expiry, list/edit the client registry, flag folders in a shared login not yet mapped to a client.
   - **contact audit** — given a client + contact (email/phone), find every Zap run touching them (~60-day retention), show what each run received and sent, and line it up with the GHL contact history from the GHL internal MCP into one timeline.
   - **zap audit** — a Zap's setup (on/off, steps, field mapping, filters, paths, versions/who changed it, settings, catch-hook URL) plus its failed/held/filtered/halted runs and why.
5. Mapping completeness loop (from the owner's earlier ask): subagent review → fix → review until endpoints and schemas are fully mapped; max 5 rounds, then report what's left.

## Non-goals
- No writes of any kind to Zapier (edit, publish, on/off, replay, autoreplay, delete). The code-level read-only guard stays.
- Not shared with teammates yet: personal use only, on the owner's machine.
- No changes to the uxie-ghl-factory plugin; this plugin only calls it/reads alongside it.

## Anti-goals (failure even if it works)
- One client's runs showing up in another client's audit.
- Credentials (password, OTP, cookie values) ever stored outside the gitignored session folder, printed, or typed by Claude.
- Guessing in audits: Zapier findings must cite run ids/timestamps (Agency TAO rule: exact numbers, unknown = "Requires investigation").

## Constraints / decided
- Auth: Playwright login per Zapier login, human enters password + OTP; session saved locally per login (the owner chose this).
- Start from the existing build in `C:\Users\herna\downloads\work\agency\zapier-mcp\` (15 tools, read-only guard `assertReadOnly`, cli.mjs, tests) and the endpoint map in `agency\zapier-re\README.md`. It was never run live (OTP pending).
- Known API facts: run retention ≈ 60 days; run search is whole-word, case-insensitive; totalCount caps 10,000; run list limit ≤100; API times UTC; today's runs drop if periodEnd ≤ now (use now+1 day).
- Windows 11, Node 24, Playwright Chromium installed.

## Decided by the owner after review
- **The 3 agencies:** Agency, Client B, Client E. Known logins: Agency = owner@agency.example (account 10000001, holds most clients incl. a "Client E NEW" folder); Client B = support@client-b.example (own login). Whether Client E also has its own Zapier login is unconfirmed — the registry must support either; confirm at first connect.
- **Zaps that belong to no single client (option B):** an audit reads the client's own Zaps (folder / name prefix) AND searches all other Zaps in the same login by the contact's exact email or phone. Runs from non-client Zaps (e.g. Agency's "QB → Slack (Invoice Paid)", "OPS#cx-requests → Slack") are included but labelled "Agency-wide Zap, not <client>'s". A run that can't be assigned is said so explicitly; never silently dropped, never attributed to the client.

## My calls (Claude's, not the owner's — check these)
- **Logins vs accounts:** registry keys on login + account id; every call passes account_id explicitly. Switching Zapier's "current account" is treated as a write and blocked.
- **GHL link:** each client in the registry stores its GHL MCP server name (e.g. `uxie-ghl-internal-mcp`, `-client-b`, `-client-e`) and location id(s). The contact audit uses that server if it's loaded in the session; if not, it delivers the Zapier half and says the GHL half needs a session in that client's folder. GHL calls are limited to a fixed list of safe reads — never `get_contact_ai_status` or anything hitting employeeConfigs (those GETs create records), never writes.
- **"Fully mapped":** every read endpoint the Zapier UI uses that an audit could need (Zaps, folders, versions, settings, hooks, runs, run detail, held counts, connections, members, task usage, apps, Tables + rows; Storage if reachable). Review agents may read live Agency/Client B/Client E data read-only and report by id only; a round may run with only some logins connected. Max 5 rounds.
- **Existing official Zapier servers** (`Zapier-Agency`, `Zapier-Client-B`, `Zapier-MCP`) stay installed but the skills never use them (they have write tools). Removing `Zapier-MCP` stays the owner's decision.
- **Facts to re-verify live:** retention (~60 days per the Nov 12 audit; the older README says ~30) and search behaviour (whole-word per the audit; the README says fuzzy) — fix `agency/zapier-re/README.md` to match.
- Plugin home: `C:\Users\herna\downloads\work\zapier-factory\` as a local git repo + local marketplace, installed via `/plugin marketplace add` on that folder. Name: `zapier-factory`.
- Sessions + registry live outside any client folder: `%USERPROFILE%\.zapier-factory\logins\<login>\` (session, profile) and `%USERPROFILE%\.zapier-factory\clients.json`. A project folder can set a default client via a small `.zapier-client` file (like GHL per-folder binding).
- One MCP server (`zapier-internal`) registered by the plugin, with a `login` (or `client`) argument on every tool, rather than one server per login.
- The Agency copy in `agency/zapier-mcp` is moved into the plugin; agency keeps only docs/links.

## Left to the builder
File layout inside the plugin, tool naming, how skills call the GHL MCP, test approach, how the review loop agents are briefed.
