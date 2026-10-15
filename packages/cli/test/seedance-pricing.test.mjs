import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api } from '../src/api.mjs';
import { Credentials } from '../src/auth.mjs';
import { Media, priceFingerprint } from '../src/media.mjs';
import { State, hash } from '../src/state.mjs';
import { calculateRulesEstimate } from '../src/platform/core/src/services/pricing-rules-estimate.js';

// Extracted unchanged from the MCP public-pricing snapshot of 2026-10-14.
const snapshot = JSON.parse(readFileSync(new URL('./fixtures/seedance-2.5-pricing-20261014.json', import.meta.url)));
const model = 'seedance-2.5-text-to-video', editModel = 'seedance-2.5-video-edit', borrowed = 'borrowed-seedance-docs';
const policy = id => ({ meta: { ...snapshot.meta, fresh_until: new Date(Date.now() + 300000).toISOString() },
  model: { ...structuredClone(snapshot.models.find(row => row.model_id === id) ?? snapshot.models.find(row => row.model_id === model)), model_id: id } });

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-seedance-'));
  const f = { paid: new Map(), calls: [], dropReplies: 0 };
  const rows = [model, editModel, borrowed].map(id => ({ model_id: id, aliases: id === borrowed ? [model] : [], display_name: id,
    capabilities: ['video'], protocols: ['evolink-video-generations'], lifecycle: 'active' }));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, f.origin), chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const send = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/v1/catalog/models') return send({ models: rows });
    if (url.pathname === '/v1/catalog/health') return send({ models: rows.map(row => ({ model_id: row.model_id, status: 'available' })) });
    if (url.pathname === '/v1/models') return send({ data: rows.map(row => ({ id: row.model_id })) });
    if (url.pathname.endsWith('/pricing-rules')) {
      const id = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      return send(id ? policy(id) : { meta: policy(model).meta, models: [policy(model).model, policy(borrowed).model] });
    }
    if (url.pathname === '/v1/credits') return send({ success: true, data: { user: { remaining_credits: 10000 }, token: { unlimited_credits: true } } });
    if (url.pathname === '/v1/videos/generations') {
      const body = JSON.parse(Buffer.concat(chunks)), id = req.headers['idempotency-key'];
      f.calls.push({ body, id });
      if (!f.paid.has(id)) f.paid.set(id, { id: `fixture-${f.paid.size}`, status: 'processing', model: body.model, type: 'video', progress: 1 });
      if (f.dropReplies > 0) { f.dropReplies--; req.socket.destroy(); return; }
      if (f.calls.filter(call => call.id === id).length > 1) res.setHeader('idempotency-replayed', 'true');
      return send(f.paid.get(id));
    }
    if (url.pathname.startsWith('/v1/tasks/')) return send([...f.paid.values()].find(task => task.id === url.pathname.split('/').at(-1)));
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  f.server = new URL(`${f.origin}/mcp`); f.state = new State(home); f.home = home;
  f.client = new Api(new Credentials({ state: f.state, server: f.server, token: 'fixture-cli-token' }));
  let elapsed = 0;
  f.media = new Media({ client: f.client, state: f.state, server: f.server, now: () => Date.now() + elapsed });
  f.advance = ms => { elapsed = ms; };
  f.run = async args => {
    const bin = process.env.EVOLINK_CLI_TEST_BIN ?? fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
    const child = spawn(process.execPath, [bin, ...args, '--server', f.server.href, '--token-stdin', '--json'], {
      env: { ...process.env, EVOLINK_CLI_HOME: home, EVOLINK_CLI_UPDATE_CHECK: '0', EVOLINK_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end('fixture-cli-token\n');
    let output = '', stderr = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => stderr += data);
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.ok(output.trim(), stderr); return { status, data: JSON.parse(output) };
  };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(home, { recursive: true, force: true }); });
  return f;
}

test('Seedance saved quote exposes effective defaults, rejects old wrong-price approvals and leaves borrowed models unchanged', async t => {
  const f = await fixture(t), input = { prompt: 'draft', duration: 5, draft: true };
  const q = await f.media.estimate({ model, input, max_cost_usd: 1 });
  assert.equal(q.amounts.uc, '467093'); assert.equal(q.effective_input.quality, '480p');
  assert.notEqual(priceFingerprint(q), priceFingerprint({ ...q, effective_input: { ...q.effective_input, quality: '720p' } }));
  const saved = await f.state.read('quotes', q.quote_id);
  assert.deepEqual(saved.effective_input, { ...input, quality: '480p' }); assert.equal(saved.defaults_applied[0].value, '480p');
  assert.deepEqual(saved.args.input, input); assert.equal(saved.args.max_cost_usd, 1);
  assert.ok(saved.expires_at - saved.created_at > 29 * 60_000);
  const inherited = await f.media.estimate({ model: borrowed, input });
  assert.equal(inherited.effective_input, undefined); assert.equal(inherited.amounts.usd, '1.47720588');
  const legacy = calculateRulesEstimate(policy(model), { id: model, kind: 'video' }, input);
  const oldView = { ...q, effective_input: undefined, estimate: legacy.estimate, pricing_quote: legacy.approval };
  saved.args.pricing_quote = legacy.approval; saved.args_hash = hash(saved.args); saved.estimate = legacy.estimate;
  saved.fingerprint = priceFingerprint(oldView); await f.state.write('quotes', q.quote_id, saved);
  await assert.rejects(f.media.generate('video', q.quote_id, { confirmed: true }), { code: 'price_changed' });
  assert.equal(f.calls.length, 0); assert.equal(f.paid.size, 0);
});

test('Seedance unknown submission at minute 16 reuses one request and a known task; legacy replay never creates a second task', async t => {
  const f = await fixture(t), input = { prompt: 'draft recovery', duration: 5, draft: true };
  const q = await f.media.estimate({ model, input });
  f.dropReplies = 2;
  await assert.rejects(f.media.generate('video', q.quote_id, { confirmed: true }));
  const saved = await f.state.read('quotes', q.quote_id);
  assert.equal(saved.state, 'outcome_unknown'); assert.equal(f.paid.size, 1);
  f.advance(16 * 60_000);
  const recovered = await f.media.resume(q.quote_id);
  assert.equal(f.paid.size, 1); assert.equal(recovered.task_id, [...f.paid.values()][0].id);
  assert.ok(f.calls.every(call => call.id === saved.client_request_id && call.body.quality === '480p'));
  const before = f.calls.length;
  await f.media.resume(q.quote_id); assert.equal(f.calls.length, before, 'known task recovery is read-only');
  const legacy = calculateRulesEstimate(policy(model), { id: model, kind: 'video' }, input);
  saved.args.pricing_quote = legacy.approval; saved.args_hash = hash(saved.args); saved.estimate = legacy.estimate;
  saved.state = 'outcome_unknown'; delete saved.task_id; await f.state.write('quotes', q.quote_id, saved);
  await assert.rejects(f.media.resume(q.quote_id), { code: 'outcome_unknown' });
  assert.equal(f.calls.length, before); assert.equal(f.paid.size, 1);
  assert.equal((await f.state.read('quotes', q.quote_id)).client_request_id, saved.client_request_id);
});

test('Seedance actual CLI commands show corrected price and partial search charges; rejected inputs and budgets submit nothing', async t => {
  const f = await fixture(t), input = { prompt: 'installed command draft', duration: 5, draft: true };
  const quote = await f.run(['estimate', '--model', model, '--input', JSON.stringify(input), '--max-cost-usd', '1']);
  assert.equal(quote.status, 0, JSON.stringify(quote)); assert.equal(quote.data.amounts.usd, '0.68690147');
  assert.equal(quote.data.effective_input.quality, '480p'); assert.match(quote.data.text, /Applied default: quality=480p/);
  const submit = await f.run(['generate', 'video', '--quote', quote.data.quote_id, '--confirm']);
  assert.equal(submit.status, 0, JSON.stringify(submit)); assert.equal(f.paid.size, 1);
  assert.equal(f.calls[0].body.quality, '480p'); assert.equal(submit.data.final_budget_enforced, false);
  const search = { prompt: 'search', duration: 5, quality: '480p', model_params: { web_search: true } };
  const partial = await f.run(['estimate', '--model', model, '--input', JSON.stringify(search)]);
  assert.equal(partial.status, 0); assert.equal(partial.data.estimate.status, 'partial');
  assert.equal(partial.data.amount_scope, 'known_components_subtotal'); assert.match(partial.data.text, /not a total or an upper bound/);
  const capped = await f.run(['estimate', '--model', model, '--input', JSON.stringify(search), '--max-cost-usd', '1']);
  assert.equal(capped.status, 1); assert.equal(capped.data.error.code, 'uncheckable_cap'); assert.equal(f.paid.size, 1);
  const invalid = await f.run(['estimate', '--model', model, '--input', JSON.stringify({ ...input, quality: '720p' })]);
  assert.equal(invalid.status, 1); assert.equal(f.paid.size, 1);
  const expected = await f.run(['estimate', '--model', model, '--input', JSON.stringify(search), '--pricing-parameters', '{"search_count":0}']);
  assert.equal(expected.status, 0); assert.match(expected.data.text, /expected usage, not a limit/);
  const inherited = await f.run(['estimate', '--model', borrowed, '--input', JSON.stringify(input)]);
  assert.equal(inherited.status, 0); assert.equal(inherited.data.effective_input, undefined);
  assert.equal(inherited.data.amounts.usd, '1.47720588');
  const editInput = { prompt: 'edit draft', duration: -1, draft: true, video_urls: ['https://example.test/input.mp4'] };
  const editQuote = await f.run(['estimate', '--model', editModel, '--input', JSON.stringify(editInput),
    '--pricing-parameters', '{"duration_seconds":5,"first_input_video_seconds":5,"input_seconds":5}']);
  assert.equal(editQuote.status, 0, JSON.stringify(editQuote)); assert.equal(editQuote.data.effective_input.duration, -1);
  assert.equal(editQuote.data.effective_input.quality, '480p'); assert.equal(editQuote.data.pricing_parameters.duration_seconds, 5);
  const editSubmit = await f.run(['generate', 'video', '--quote', editQuote.data.quote_id, '--confirm']);
  assert.equal(editSubmit.status, 0, JSON.stringify(editSubmit)); assert.equal(f.paid.size, 2);
  assert.equal(f.calls.at(-1).body.duration, -1); assert.equal(f.calls.at(-1).body.quality, '480p');
});
