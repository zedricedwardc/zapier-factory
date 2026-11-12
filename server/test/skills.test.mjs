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
