// The MCP server instructions carry the standing rule: Zapier reads go through this server, never the official ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { INSTRUCTIONS, OFFICIAL_SERVERS_RULE } from '../instructions.mjs';

test('server instructions keep the read-only basics', () => {
  assert.match(INSTRUCTIONS, /^READ-ONLY access to Zapier/);
  assert.match(INSTRUCTIONS, /POST \/api\/v4\/jwt\/refresh/);
});
test('server instructions contain the official-servers rule', () => {
  assert.ok(INSTRUCTIONS.includes(OFFICIAL_SERVERS_RULE));
  assert.match(INSTRUCTIONS, /For any Zapier read .* use this server's tools/);
  assert.match(INSTRUCTIONS, /Never use the official Zapier MCP servers \(e\.g\. Zapier-<Agency>, Zapier-MCP, or any mcp\.zapier\.com server\) for reads or writes in audits/);
  assert.match(INSTRUCTIONS, /edit, run, enable\/disable and delete Zaps/);
  assert.match(INSTRUCTIONS, /If both .* are loaded, say so once and use this one/);
});
test('server.mjs passes these instructions to the MCP server', () => {
  const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ INSTRUCTIONS \} from '\.\/instructions\.mjs'/);
  assert.match(src, /\{ instructions: INSTRUCTIONS \}/);
});
