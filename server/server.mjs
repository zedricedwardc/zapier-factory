#!/usr/bin/env node
// Zapier internal MCP server (stdio) — READ-ONLY. Sessions come from <FACTORY_DIR>/logins/<login>/session.json (node login.mjs <login>).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools, callTool, renderResult } from './tools.mjs';

const server = new McpServer(
  { name: 'zapier-internal', version: '0.1.0' },
  { instructions: 'READ-ONLY access to Zapier through the web app\'s internal API, using a browser session captured once per login by `node login.mjs <login>`. Every call needs a client (or a .zapier-client file in the working folder) or an explicit login; there is no default login, and login-only results are login-wide (scope.level "login"). No tool can edit, publish, toggle, replay or delete anything. If a call fails with SESSION_EXPIRED, ask the user to run `node login.mjs <login>` (they type the password themselves), then retry — no restart needed. Run history keeps ~60 days and all times are UTC. Run search is whole-word: search by email or phone and confirm hits with get_run.' },
);

for (const [name, t] of Object.entries(tools)) {
  server.registerTool(name, { description: t.description, inputSchema: t.schema, annotations: { readOnlyHint: true, openWorldHint: true } }, async (args) => {
    try {
      return { content: [{ type: 'text', text: renderResult(await callTool(name, args)) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message || String(e) }] };
    }
  });
}

await server.connect(new StdioServerTransport());
process.stderr.write('[zapier-internal] ready (read-only)\n');
