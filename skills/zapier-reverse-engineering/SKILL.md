---
name: zapier-reverse-engineering
description: "Map a Zapier internal (browser) read endpoint and add it to the read-only zapier-internal MCP as a new tool with a test. Use when an audit needs data no zapier-internal tool returns yet (Tables rows, Storage, task usage, app list, a filter the tools do not expose), when the user asks to capture, sniff, trace or reverse-engineer a zapier.com request, or to close an item in docs/endpoints.md \"Unresolved\". Captures the UI's own requests in Chrome with read-only clicks only, then adds the tool, tests it, and runs a review/fix loop (max 5 rounds)."
---

# Zapier Reverse-Engineering

The zapier-internal MCP only knows endpoints someone captured from the real zapier.com UI. This skill
captures a new one, proves it, and adds it as a read-only tool. **GraphQL introspection is off: never
invent query text or parameters. Copy them from a captured request.**

## Hard rules

- **Read-only in the browser.** Only clicks that open, list, filter, search, page or expand. Never click
  Publish, Turn on / Turn off, Replay / Autoreplay, Run, Retry, Resume, Skip, Edit, Delete, Test step,
  Rename, Move, Duplicate / Copy, Share, Reconnect, Disconnect, Switch account, or anything that saves. If the view you need sits behind such a button, stop and ask.
- **Read-only in the tool.** The server's guard allows GET to `https://zapier.com` and POST only to
  `/api/reporting/graphql` with one `query` (no `mutation`/`subscription`, no persisted queries, no
  batches). A new tool must pass that guard unchanged. Never loosen `assertReadOnly` in `server/lib.mjs`.
- **Never use the official Zapier servers** (`Zapier-Agency`, `Zapier-Client-B`, `Zapier-MCP`).
- **No secrets.** Never log, print or save cookies, auth/CSRF headers, tokens, passwords or OTPs. Do not read
  `%USERPROFILE%\.zapier-factory\logins\`.
- **Report by id only.** Captures contain customer data. Notes, tests, fixtures and docs carry endpoint
  paths, parameter names, response keys and ids, never names, emails, phones or booking contents.
  Test fixtures use made-up values.

## 1. Capture in Chrome

Load the Chrome tools in one ToolSearch (`tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `find`,
`computer`, `read_page`, `javascript_tool`, `read_network_requests`). Work in a new tab on zapier.com
where the user is already logged in (Claude never logs in or types credentials).

Install a fetch/XHR wrapper on the page with `javascript_tool` before clicking:

```js
(() => {
  if (window.__zcap) return 'already installed';
  window.__zcap = [];
  const SECRET = /^(authorization|cookie|x-csrftoken|x-csrf-token|x-xsrf-token|x-api-key)$/i;
  const clean = (h) => { const o = {}; try { new Headers(h || {}).forEach((v, k) => { o[k] = SECRET.test(k) ? '[redacted]' : v; }); } catch {} return o; };
  const log = (method, url, headers, body) => window.__zcap.push({ t: new Date().toISOString(), method: (method || 'GET').toUpperCase(), url: String(url), headers: clean(headers), body: typeof body === 'string' ? body.slice(0, 4000) : (body ? '[non-string body]' : null) });
  const f = window.fetch;
  window.fetch = function (input, init = {}) { const req = input instanceof Request ? input : null; log(init.method || req?.method, req ? req.url : input, init.headers || req?.headers, init.body); return f.apply(this, arguments); };
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__z = { m, u }; return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) { if (this.__z) log(this.__z.m, this.__z.u, null, b); return send.apply(this, arguments); };
  return 'installed';
})()
```

Then do the read-only clicks for the view, and read the log back filtered to zapier.com API paths:

```js
JSON.stringify(window.__zcap.filter(r => /\/api\//.test(r.url)).map(r => {
  const mask = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? v.map(mask) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x)]))) : '[x]');
  // One operation {operationName, query, variables} or a batch [op, op, ...]: mask variables in each.
  const maskOp = (op) => (op && typeof op === 'object' && !Array.isArray(op) && op.variables ? { ...op, variables: mask(op.variables) } : op);
  let body = r.body;
  try {
    const b = JSON.parse(r.body);
    if (Array.isArray(b)) body = JSON.stringify(b.map(maskOp));
    else if (b && typeof b === 'object') body = JSON.stringify(b.query || b.operationName ? maskOp(b) : mask(b));
  } catch { if (body) body = '[unparsed body hidden: ' + body.length + ' chars]'; }
  let url = r.url.replace(/([?&](email|query|search|phone)=)[^&]*/gi, '$1[x]');
  try { const u = new URL(url, location.origin); const i = u.searchParams.get('input'); if (i) { u.searchParams.set('input', JSON.stringify(mask(JSON.parse(i)))); url = u.toString(); } } catch { url = url.replace(/([?&]input=)[^&]*/i, '$1[x]'); }
  return { t: r.t, method: r.method, url, body };
}), null, 1)
```

The wrapper dies on full page loads; reinstall after each navigation. `read_network_requests` is a
fallback for URLs and status codes (it does not show bodies). For GraphQL, keep the exact `operationName`,
`query` text and `variables` keys; the read-back above already masks every `variables` value as `[x]`
(keys and nesting kept), both for one operation and for a batched body (a JSON array of operations). Other
JSON bodies and tRPC `?input=` are masked the same way (keys kept), and a body that is not JSON is hidden
(only its length shown). Never read the log back without that mask.

For each request record: method, path, query/variables keys, which UI control fired it, and the
response's top-level keys and paging (offset, cursor, `next`). The CLI only calls existing tools, so the
outside-the-UI proof is the new tool itself (step 2): its result must match what the UI showed (counts, ids).

## 2. Add the tool + test in `server/`

1. **Tool** in `server/tools.mjs`: a new entry in `tools` with `description` (what it returns, limits,
   UTC, retention), a zod `schema` (no `client`/`login`, those are added for every tool) and a `handler`
   that calls `L.get(...)`, `L.trpc(...)` or a GraphQL helper in `server/lib.mjs`. Always pass
   `account_id` from `await L.accountId()`; never call account-switching paths.
   - Login-wide data (not tied to one Zap): add its name to the `level = 'login'` list.
   - Zap-scoped data: set `tools.<name>.zapOf` so results carry the Zap's ownership label.
   - Run lists with a `client`: restrict to `idx.clientIds` like `search_runs`, label every row.
   - New GraphQL operation: build the text from the captured query (like `buildZapRunsQuery`) so it starts
     with `query` and passes the guard.
2. **Test** in `server/test/` (offline, `node:test`): the guard accepts the new request
   (`assertReadOnly(method, url, body)` returns true), the query/URL builder produces the captured shape,
   and any parsing/labelling logic works on a small made-up fixture. Add a guard rejection test if the
   endpoint has a write sibling (same path with POST/PUT/DELETE).
3. Run `npm test` in `server/` (all green), then a live read: `node cli.mjs <tool> '<json args>'` in
   `server/`, checking the result against the UI. Never print run data you do not need.
4. Docs: add the row to `docs/endpoints.md` (and move it out of "Unresolved"), the tool to the README tool
   table (update the count), and anything learned to "Gotchas".

## 3. Review / fix loop (max 5 rounds)

Each round, review the diff against this checklist (a fresh reviewer agent if the user allows agents,
given the diff and this checklist only, not your conclusions; otherwise a careful self-review):

- Request copied from a capture, not invented; read-only guard untouched and passing.
- `account_id` explicit; ownership/scope labels correct; login-wide data labelled `level: 'login'`.
- Paging and caps handled (limits, cursors, `totalCount` caps); UTC stated.
- Test covers guard + builder + parsing; `npm test` green; live check matches the UI.
- No secrets or customer data in code, tests, fixtures, docs or commit.

Fix every finding, rerun `npm test` and the live check, review again. Stop when a round finds nothing,
or after round 5; then list what is still open instead of looping on.

## Report

Endpoint(s) mapped (method + path + operationName), tool name and arguments, tests added and their
result, live check (counts/ids only), review rounds and open items, docs updated. No customer data.
