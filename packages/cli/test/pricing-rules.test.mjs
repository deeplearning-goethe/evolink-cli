import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Api } from '../src/api.mjs';
import { validateCommand, dispatch } from '../src/cli.mjs';
import { commandHelp } from '../src/help.mjs';

function body() { return { meta: { schema_version: '2', catalog_version: 'cat_fixture', pricing_version: 'prc_fixture',
  price_scope: 'public_default', currency: 'USD', exchange_rate_version: 'pricing-fx/v1:USD-CNY=6.8',
  updated_at: '2026-09-23T00:00:00Z', fresh_until: new Date(Date.now() + 300000).toISOString() }, models: [] }; }

test('public pricing rules never read, refresh or send credentials or contact MCP', async () => {
  const seen = [];
  const client = new Api({ server: new URL('https://mcp.evolink.ai/mcp'), access: () => assert.fail('Public rules need no credential access') }, {
    fetchFn: async (url, init) => { seen.push(new URL(url)); assert.equal(new Headers(init.headers).get('Authorization'), null);
      return new Response(JSON.stringify(body()), { headers: { 'Content-Type': 'application/json' } }); },
  });
  const result = await client.call('get_pricing_rules', { modality: 'video' }, { requireCapability: true });
  assert.equal(result.quote_established, false); assert.equal(result.final_budget_enforced, false); assert.deepEqual(result.models, []);
  assert.equal(result._binding, undefined); assert.equal(seen.length, 1); assert.equal(seen[0].origin, 'https://api.evolink.ai');
  assert.equal(seen[0].pathname, '/v1/catalog/pricing-rules'); assert.match(result.text, /not zero cost/);
});

test('seed 20261009: pricing command preserves all filters and rejects unrelated/budget options', async () => {
  const filters = { model: 'gemini-2.5-pro', 'product-id': 'gemini-2.5-pro', modality: 'text', operation: 'text_generation', lifecycle: 'active', view: 'full' };
  let seed = 20261009;
  for (let i = 0; i < 96; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const selected = Object.fromEntries(Object.entries(filters).filter((_, index) => seed & (1 << index)));
    validateCommand(['models', 'pricing'], selected);
    await dispatch(['models', 'pricing'], selected, { state: {}, server: new URL('https://mcp.evolink.ai/mcp'),
      client: { call: async (name, args, options) => {
        assert.equal(name, 'get_pricing_rules'); assert.equal(options.requireCapability, true);
        assert.deepEqual(args, Object.fromEntries(Object.entries(selected).map(([key, value]) => [key === 'product-id' ? 'product_id' : key, value])));
        return { ok: true };
      } } });
  }
  for (const options of [{ 'max-cost-usd': '1' }, { confirm: true }, { 'user-group': 'vip' }, { type: 'image' }]) {
    assert.throws(() => validateCommand(['models', 'pricing'], options));
  }
  const reference = commandHelp(['models', 'pricing']); assert.equal(reference.options.view.default, 'full');
  assert.match(reference.description, /not account prices, quotes, bills or final spending caps/);
});

test('installed command reads anonymous rules with no keyring, and invalid filters send no request', async t => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++; assert.equal(req.headers.authorization, undefined); assert.ok(req.url.startsWith('/v1/catalog/pricing-rules'));
    assert.match(req.headers['user-agent'], /^EvoLinkCLI\//);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const resource = `http://127.0.0.1:${server.address().port}/mcp`;
  async function run(args) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url)),
      'models', 'pricing', ...args, '--server', resource, '--json'], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, EVOLINK_CLI_HOME: '/dev/null/not-a-directory', EVOLINK_API_KEY: '' } });
    let output = '', stderr = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => stderr += value);
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(output.trim().split('\n').length, 1, stderr); return { status, view: JSON.parse(output) };
  }
  const valid = await run(['--modality', 'video']); assert.equal(valid.status, 0); assert.equal(valid.view.final_budget_enforced, false);
  assert.equal(requests, 1);
  const invalid = await run(['--model', 'Bad/Model']); assert.equal(invalid.status, 1); assert.equal(invalid.view.ok, false);
  assert.equal(requests, 1);
});
