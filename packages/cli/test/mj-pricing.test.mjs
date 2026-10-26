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
import { Media } from '../src/media.mjs';
import { State } from '../src/state.mjs';

// Published Midjourney rules of 2026-10-23, the snapshot the MCP repository tests with.
const snapshot = JSON.parse(readFileSync(new URL('./fixtures/pricing-rules-mj-20261023.json', import.meta.url)));
const models = ['mj-v7', 'mj-v7-variation', 'mj-v7-upscale'];
const policy = id => ({ meta: { ...snapshot.meta, fresh_until: new Date(Date.now() + 300000).toISOString() },
  model: structuredClone(snapshot.models.find(row => row.model_id === id)) });
const source = 'task-unified-1757165031-mjv7';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-mj-'));
  const f = { calls: [] };
  const rows = models.map(id => ({ model_id: id, aliases: [], display_name: id, capabilities: ['image'], protocols: ['openai-images'], lifecycle: 'active' }));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, f.origin), chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const send = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/v1/catalog/models') return send({ models: rows });
    if (url.pathname === '/v1/catalog/health') return send({ models: rows.map(row => ({ model_id: row.model_id, status: 'available' })) });
    if (url.pathname === '/v1/models') return send({ data: rows.map(row => ({ id: row.model_id })) });
    if (url.pathname.endsWith('/pricing-rules')) {
      const id = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      return send(id ? policy(id) : { meta: policy('mj-v7').meta, models: models.map(model => policy(model).model) });
    }
    if (url.pathname === '/v1/credits') return send({ success: true, data: { user: { remaining_credits: 10000 }, token: { unlimited_credits: true } } });
    if (url.pathname === '/v1/images/generations') {
      const body = JSON.parse(Buffer.concat(chunks)); f.calls.push(body);
      return send({ id: `task-mj-${f.calls.length}`, status: 'processing', model: body.model, type: 'image', progress: 1 });
    }
    if (url.pathname.startsWith('/v1/tasks/')) {
      const id = url.pathname.split('/').at(-1);
      return send({ id, status: 'completed', model: 'mj-v7', type: 'image', progress: 100, results: ['https://files.mj.test/out.png'] });
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  f.server = new URL(`${f.origin}/mcp`); f.state = new State(home);
  f.client = new Api(new Credentials({ state: f.state, server: f.server, token: 'fixture-cli-token' }));
  f.media = new Media({ client: f.client, state: f.state, server: f.server });
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

test('Midjourney settings in model_params decide the CLI quote; a promptless variation is quoted as fast', async t => {
  const f = await fixture(t), prompt = 'a lighthouse on a cliff at dawn';
  assert.equal((await f.media.estimate({ model: 'mj-v7', input: { prompt, model_params: { speed: 'turbo' } } })).amounts.credits, '10.8');
  assert.equal((await f.media.estimate({ model: 'mj-v7', input: { prompt } })).amounts.credits, '5.4');
  assert.equal((await f.media.estimate({ model: 'mj-v7', input: { prompt, model_params: { speed: 'draft' } } })).amounts.credits, '2.7');
  assert.equal((await f.media.estimate({ model: 'mj-v7-upscale', input: { model_params: { task_id: source, type: 'creative' } } })).amounts.credits, '10.8');
  const variation = prompt => f.media.estimate({ model: 'mj-v7-variation', input: { ...(prompt === undefined ? {} : { prompt }), model_params: { task_id: source, speed: 'turbo' } } });
  assert.equal((await variation('a red fox in snow')).amounts.credits, '16.2');
  assert.equal((await variation('--turbo --v 7')).amounts.credits, '8.1');
  assert.equal((await variation(undefined)).amounts.credits, '8.1');
  assert.equal(f.calls.length, 0);
});

test('the real CLI quotes mj-v7 turbo at the turbo price and submits turbo after confirmation', async t => {
  const f = await fixture(t), input = { prompt: 'a lighthouse on a cliff at dawn', model_params: { speed: 'turbo' } };
  const quote = await f.run(['estimate', '--model', 'mj-v7', '--input', JSON.stringify(input)]);
  assert.equal(quote.status, 0, JSON.stringify(quote)); assert.equal(quote.data.amounts.credits, '10.8');
  const submit = await f.run(['generate', 'image', '--quote', quote.data.quote_id, '--confirm']);
  assert.equal(submit.status, 0, JSON.stringify(submit));
  assert.deepEqual(f.calls.map(call => call.model_params), [{ speed: 'turbo' }]);
});
