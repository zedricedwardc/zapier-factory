// Skill snippets that guard customer data are executed here, not just read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const skill = fs.readFileSync(new URL('../../skills/zapier-reverse-engineering/SKILL.md', import.meta.url), 'utf8');
const readBack = [...skill.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]).find((s) => s.includes('window.__zcap.filter'));
const run = (zcap) => JSON.parse(new Function('window', 'location', `return ${readBack}`)({ __zcap: zcap }, { origin: 'https://zapier.com' }));
const SECRET = 'jane@example.test';

test('reverse-engineering read-back masks a single GraphQL operation', () => {
  const body = JSON.stringify({ operationName: 'ZapRuns', query: 'query ZapRuns($query: String) { x }', variables: { query: SECRET, accountId: '1' } });
  const [r] = run([{ t: 't', method: 'POST', url: 'https://zapier.com/api/reporting/graphql', body }]);
  assert.ok(!r.body.includes(SECRET));
  const b = JSON.parse(r.body);
  assert.equal(b.operationName, 'ZapRuns'); assert.match(b.query, /query ZapRuns/);
  assert.deepEqual(b.variables, { query: '[x]', accountId: '[x]' });
});
test('reverse-engineering read-back masks a batched GraphQL body (JSON array)', () => {
  const body = JSON.stringify([
    { operationName: 'A', query: 'query A { a }', variables: { email: SECRET, nested: { phone: '8135550100' } } },
    { operationName: 'B', query: 'query B { b }', variables: { ids: [SECRET] } },
  ]);
  const [r] = run([{ t: 't', method: 'POST', url: 'https://zapier.com/api/reporting/graphql', body }]);
  assert.ok(!r.body.includes(SECRET) && !r.body.includes('8135550100'), r.body);
  const b = JSON.parse(r.body);
  assert.deepEqual(b.map((o) => o.operationName), ['A', 'B']);
  assert.deepEqual(b[0].variables, { email: '[x]', nested: { phone: '[x]' } });
  assert.deepEqual(b[1].variables, { ids: ['[x]'] });
});
test('reverse-engineering read-back masks tRPC input values, other JSON bodies and non-JSON bodies', () => {
  const input = encodeURIComponent(JSON.stringify({ search: SECRET, limit: 5 }));
  const rows = run([
    { t: 't', method: 'GET', url: `https://zapier.com/api/asset-management-bff/trpc/zap.searchZaps?input=${input}`, body: null },
    { t: 't', method: 'POST', url: 'https://zapier.com/api/x', body: JSON.stringify({ contact: { email: SECRET } }) },
    { t: 't', method: 'POST', url: 'https://zapier.com/api/y', body: `email=${SECRET}` },
  ]);
  const all = JSON.stringify(rows);
  assert.ok(!all.includes(SECRET) && !all.includes(encodeURIComponent(SECRET)), all);
  assert.deepEqual(JSON.parse(new URL(rows[0].url).searchParams.get('input')), { search: '[x]', limit: '[x]' });
  assert.deepEqual(JSON.parse(rows[1].body), { contact: { email: '[x]' } });
  assert.match(rows[2].body, /^\[unparsed body hidden: \d+ chars\]$/);
});

// Frontmatter: every skill (zapier-status included) has a name matching its folder and a usable description.
const front = (text) => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(m, 'frontmatter block missing');
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].startsWith('"') ? JSON.parse(kv[2]) : kv[2];
  }
  return { fields: out, raw: m[1] };
};
const skillsDir = new URL('../../skills/', import.meta.url);
const skillNames = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

test('every skill has frontmatter with name = folder and a description', () => {
  assert.ok(skillNames.includes('zapier-status'), 'zapier-status skill missing');
  for (const n of skillNames) {
    const { fields } = front(fs.readFileSync(new URL(`${n}/SKILL.md`, skillsDir), 'utf8'));
    assert.equal(fields.name, n, `${n}: name`);
    assert.ok(typeof fields.description === 'string' && fields.description.length >= 80 && fields.description.length <= 1024, `${n}: description length`);
    assert.match(fields.description, /Use when/, `${n}: description says when to use it`);
  }
});
test('zapier-status skill: triggers, read-only tools and window rules', () => {
  const text = fs.readFileSync(new URL('zapier-status/SKILL.md', skillsDir), 'utf8');
  const { fields } = front(text);
  for (const t of ['zapier status', 'is zapier connected', 'why is the audit empty']) assert.ok(fields.description.includes(t), `trigger ${t}`);
  for (const tool of ['zapier_whoami', 'list_clients', 'unmapped_folders', 'list_zaps', 'search_runs', 'held_counts', 'task_usage']) assert.ok(text.includes('`' + tool + '`'), tool);
  assert.match(text, /Never use the official Zapier MCP servers/);
  assert.match(text, /periodEnd/); assert.match(text, /not read/);
  assert.ok(!/get_run`? with|full: true` on/.test(text));
  // r4 I-1 step 4 / M-1: one list_zaps all:true per client (on/off counted from isEnabled), not an on call plus an off call.
  assert.match(text, /`list_zaps` with `client` and `all: true` \(one call\)/);
  assert.ok(!/`list_zaps` with `client`, `status: "on"`/.test(text));
  // r4 M-4: the pace text is the measured cached-map pace, not the old ~4 minutes per client.
  assert.ok(!/about 4 minutes/.test(text)); assert.match(text, /cached for 5 minutes/);
});

// The plugin subagent: frontmatter, tools limited to the zapier-internal MCP + Read, never the official servers.
test('zapier-auditor agent frontmatter limits tools to zapier-internal + Read', async () => {
  const { tools } = await import('../tools.mjs');
  const text = fs.readFileSync(new URL('../../agents/zapier-auditor.md', import.meta.url), 'utf8');
  const { fields, raw } = front(text);
  assert.equal(fields.name, 'zapier-auditor');
  assert.match(fields.description, /contact/); assert.match(fields.description, /Zap id/);
  const list = fields.tools.split(',').map((s) => s.trim());
  const prefix = 'mcp__plugin_zapier-factory_zapier-internal__';
  assert.deepEqual(list.filter((t) => !t.startsWith(prefix)), ['Read']);
  assert.deepEqual(list.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length)).sort(), Object.keys(tools).sort());
  for (const s of raw.match(/^\s+- (.+)$/gm).map((l) => l.replace(/^\s+- /, ''))) assert.ok(skillNames.includes(s), `preloaded skill ${s} exists`);
  assert.match(text, /Never write/); assert.match(text, /Requires investigation/); assert.match(text, /Zero runs is a window limit, not proof/);
  assert.match(text, /Never mix clients|never mix clients|One client per job/);
  // r4 M-5: a bounded run and a fallback path that resolves.
  assert.ok(Number(fields.maxTurns) > 0 && Number(fields.maxTurns) <= 100, 'maxTurns');
  assert.ok(text.includes('${CLAUDE_PLUGIN_ROOT}/skills/zapier-zap-audit/SKILL.md'), 'fallback path');
});
