#!/usr/bin/env node
// Zapier internal MCP server (stdio) — READ-ONLY. Sessions come from <FACTORY_DIR>/logins/<login>/session.json (node login.mjs <login>).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools, callTool, renderResult } from './tools.mjs';
import { INSTRUCTIONS } from './instructions.mjs';

const server = new McpServer(
  { name: 'zapier-internal', version: '0.1.0' },
  { instructions: INSTRUCTIONS },
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
