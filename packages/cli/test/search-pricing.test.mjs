import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/search-pricing-20261016.json', import.meta.url)));
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-search-'));
  const f = { calls: [], changed: false, token: false };
  const rows = snapshot.models.map(model => ({ model_id: model.model_id, aliases: [], display_name: model.model_id,
    capabilities: [model.modality], protocols: [model.modality === 'image' ? 'openai-images' : 'evolink-video-generations'], lifecycle: 'active' }));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, f.origin), chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const send = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/v1/catalog/models') return send({ models: rows });
    if (url.pathname === '/v1/catalog/health') return send({ models: rows.map(row => ({ model_id: row.model_id, status: 'available' })) });
    if (url.pathname === '/v1/models') return send({ data: rows.map(row => ({ id: row.model_id })) });
    if (url.pathname.endsWith('/pricing-rules')) {
      const id = decodeURIComponent(url.pathname.split('/')[4] ?? ''), models = structuredClone(snapshot.models);
      if (f.changed) for (const model of models) model.components.find(c => c.role === 'web_search').rate = {
        uc: '12345', credits: '1.2345', cny: '0.12345', usd: '0.01815441' };
      const meta = { ...snapshot.meta, fresh_until: new Date(Date.now() + 300000).toISOString() };
      return send(id ? { meta, model: models.find(model => model.model_id === id) } : { meta, models });
    }
    if (url.pathname === '/v1/credits') return send({ success: true, data: { user: { remaining_credits: 10000 }, token: { unlimited_credits: true } } });
    if (url.pathname.endsWith('/generations')) {
      const body = JSON.parse(Buffer.concat(chunks)); f.calls.push(body);
      return send({ id: `fixture-search-${f.calls.length}`, status: 'completed', model: body.model,
        type: snapshot.models.find(m => m.model_id === body.model).modality });
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  f.run = async (args, json = true) => {
    const bin = process.env.EVOLINK_CLI_TEST_BIN ?? fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
    const child = spawn(process.execPath, [bin, ...args, '--server', `${f.origin}/mcp`, '--token-stdin', ...(json ? ['--json'] : [])], {
      env: { ...process.env, EVOLINK_CLI_HOME: home, EVOLINK_CLI_UPDATE_CHECK: '0', EVOLINK_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end('fixture-search-token\n');
    let output = '', stderr = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => stderr += data);
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.ok(output.trim(), stderr); return { status, data: json ? JSON.parse(output) : output };
  };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(home, { recursive: true, force: true }); });
  return f;
}
const inputFor = model => ({ prompt: 'Search fee acceptance', ...(model.modality === 'image' ? { quality: '2K' } : { duration: 5, quality: '720p' }) });
const enabled = model => model.model_id.startsWith('doubao') ? { tools: [{ type: 'web_search' }] }
  : { web_search: true, ...(model.parameters.some(p => p.name === 'image_search_count') ? { image_search: true } : {}) };
const usageFor = model => model.modality === 'image' && model.model_id.startsWith('gemini') ? { input_tokens: 0, output_tokens: 0 } : {};

test('actual CLI: seven routes show enabled-only search fees in JSON and terminal output', async t => {
  const f = await fixture(t);
  for (const model of snapshot.models) {
    const args = ['estimate', '--model', model.model_id, '--pricing-parameters', JSON.stringify(usageFor(model))];
    const off = await f.run([...args, '--input', JSON.stringify(inputFor(model))]);
    assert.equal(off.status, 0, JSON.stringify(off)); assert.equal(off.data.search_charges, undefined);
    assert.doesNotMatch(off.data.text, /search is enabled/);
    const input = { ...inputFor(model), model_params: enabled(model) };
    const on = await f.run([...args, '--input', JSON.stringify(input)]);
    assert.equal(on.status, 0, JSON.stringify(on)); assert.equal(on.data.estimate.status, 'partial');
    assert.equal(on.data.amount_scope, 'known_components_subtotal');
    assert.equal(on.data.search_charges.length, model.parameters.some(p => p.name === 'image_search_count') ? 2 : 1);
    for (const search of on.data.search_charges) assert.equal(search.unit_price_amounts.uc, model.components.find(c => c.role === search.role).rate.uc);
    assert.match(on.data.text, /assumes 0 searches and excludes/); assert.match(on.data.text, /multiple searches/);
    const terminal = await f.run([...args, '--input', JSON.stringify(input)], false);
    assert.equal(terminal.status, 0); assert.match(terminal.data, /not a total or an upper bound/);
    for (const search of on.data.search_charges) assert.ok(terminal.data.includes(`${search.unit_price_amounts.credits} credits`));
    const capped = await f.run([...args, '--input', JSON.stringify(input), '--max-cost-usd', '100']);
    assert.equal(capped.status, 1); assert.equal(capped.data.error.code, 'uncheckable_cap');
    const submitted = await f.run(['generate', model.modality, '--quote', on.data.quote_id, '--confirm']);
    assert.equal(submitted.status, 0, JSON.stringify(submitted));
    assert.deepEqual(f.calls.at(-1), { ...input, model: model.model_id });
    assert.deepEqual(submitted.data.search_charges, on.data.search_charges);
  }
  assert.equal(f.calls.length, 7);
});

test('actual CLI: expected zero is disclosed, rates are refreshed and an approval never changes search settings', async t => {
  const f = await fixture(t), model = snapshot.models.find(m => m.model_id === 'gemini-3.1-flash-image-preview');
  const input = { ...inputFor(model), model_params: enabled(model) };
  const args = ['estimate', '--model', model.model_id, '--input', JSON.stringify(input), '--pricing-parameters',
    JSON.stringify({ ...usageFor(model), search_count: 0, image_search_count: 2 })];
  const quote = await f.run(args);
  assert.equal(quote.status, 0); assert.match(quote.data.text, /expected usage, not a limit/);
  assert.equal(quote.data.pricing_parameters.search_count, 0); assert.equal(quote.data.pricing_parameters.image_search_count, 2);
  f.changed = true;
  const rejected = await f.run(['generate', 'image', '--quote', quote.data.quote_id, '--confirm']);
  assert.equal(rejected.status, 1); assert.equal(rejected.data.error.code, 'price_changed', JSON.stringify(rejected.data)); assert.equal(f.calls.length, 0);
  const refreshed = await f.run(['estimate', '--refresh-quote', quote.data.quote_id]);
  assert.equal(refreshed.status, 0); assert.equal(refreshed.data.search_charges[0].unit_price_amounts.credits, '1.2345');
  const done = await f.run(['generate', 'image', '--quote', refreshed.data.quote_id, '--confirm']);
  assert.equal(done.status, 0); assert.deepEqual(f.calls[0], { ...input, model: model.model_id });
});
