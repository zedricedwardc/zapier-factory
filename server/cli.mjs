#!/usr/bin/env node
// node cli.mjs <tool_name> '<json args>'   — same handlers as the MCP server, for testing without restarting Claude.
// node cli.mjs list                        — tool names + descriptions
import { tools, callTool, renderResult } from './tools.mjs';

const [name, json] = process.argv.slice(2);
if (!name || name === 'list' || name === '--help' || name === '-h') {
  for (const [n, t] of Object.entries(tools)) console.log(`${n}\n  ${t.description}\n`);
  if (!name) console.log("usage: node cli.mjs <tool_name> '<json args>'");
  process.exit(0);
}
let args = {};
if (json) {
  try { args = JSON.parse(json); } catch (e) { console.error(`BAD_ARGS: second argument must be JSON (${e.message})`); process.exit(2); }
}
try {
  console.log(renderResult(await callTool(name, args), Number(process.env.ZAPIER_CLI_MAX_CHARS || 1e9)));
} catch (e) {
  console.error(e.message || String(e));
  process.exit(1);
}
