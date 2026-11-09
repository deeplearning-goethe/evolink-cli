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

// Published usage-billed rules of 2026-10-23, the snapshot the MCP repository tests with, and a speech rule of
// 2026-10-14 billed only by token counts the request cannot give (GPT Image, Gemini Omni and Qwen TTS get a reference
// price: token-billed.test.mjs), published here for qwen3-tts-vd, which has none.
const snapshot = JSON.parse(readFileSync(new URL('./fixtures/pricing-rules-usage-20261023.json', import.meta.url)));
const TTS = 'qwen3-tts-vd';
const tokenBilled = { models: JSON.parse(readFileSync(new URL('./fixtures/pricing-rules-tts-20261014.json', import.meta.url))).models
  .map(row => ({ ...row, model_id: TTS, product_id: TTS })) };
const models = { [TTS]: ['audio', 'openai-audio'], 'seedance-2.0-mini-reference-to-video': ['video', 'evolink-video-generations'] };
const policy = id => ({ meta: { ...snapshot.meta, fresh_until: new Date(Date.now() + 300000).toISOString() },
  model: structuredClone([...snapshot.models, ...tokenBilled.models].find(row => row.model_id === id)) });
const TOKENS = ['input_tokens', 'output_tokens'];
const mapping = 'In the CLI, media_seconds is --media-seconds and pricing_parameters is --pricing-parameters (a JSON object).';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-usage-'));
  const f = { submissions: 0 };
  const rows = Object.entries(models).map(([id, [kind, protocol]]) => ({ model_id: id, aliases: [], display_name: id, capabilities: [kind], protocols: [protocol], lifecycle: 'active' }));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, f.origin);
    for await (const _chunk of req) { /* drain */ }
    const send = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/v1/catalog/models') return send({ models: rows });
    if (url.pathname === '/v1/catalog/health') return send({ models: rows.map(row => ({ model_id: row.model_id, status: 'available' })) });
    if (url.pathname === '/v1/models') return send({ data: rows.map(row => ({ id: row.model_id })) });
    if (url.pathname.endsWith('/pricing-rules')) {
      const id = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      return send(id ? policy(id) : { meta: policy(TTS).meta, models: Object.keys(models).map(model => policy(model).model) });
    }
    if (url.pathname === '/v1/credits') return send({ success: true, data: { user: { remaining_credits: 10000 }, token: { unlimited_credits: true } } });
    if (/^\/v1\/(images|videos|audios)\/generations$/.test(url.pathname)) { f.submissions++; return send({ id: 'task-unexpected', status: 'pending' }); }
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

test('an estimate without its billing usage saves no quote and says which usage to give, in CLI options', async t => {
  const f = await fixture(t);
  await assert.rejects(f.media.estimate({ model: TTS, input: { prompt: 'a red bicycle', voice: 'narrator' } }), error => {
    assert.equal(error.code, 'estimate_unavailable');
    assert.deepEqual(error.details.missing_usage, TOKENS);
    assert.equal(error.details.estimate.status, 'needs_input'); assert.equal(error.details.estimate.max_usd, undefined);
    const lines = error.message.split('\n');
    assert.equal(lines[0], 'The total cannot be estimated yet, so no quote was saved. It depends on:');
    assert.equal(lines[1], '- input_tokens, output_tokens: billed by the tokens the task actually uses, known only after it runs (public default rates: '
      + 'input $0.00022059 per 1K tokens; output $0.00176471 per 1K tokens).');
    assert.equal(lines.at(-1), mapping);
    return true;
  });
  assert.equal(f.submissions, 0);
});

test('the real CLI names the missing input length and quotes the task once --media-seconds gives it', async t => {
  const f = await fixture(t), input = JSON.stringify({ prompt: 'a dancer', video_urls: ['https://files.example/clip.mp4'] });
  const missing = await f.run(['estimate', '--model', 'seedance-2.0-mini-reference-to-video', '--input', input]);
  assert.notEqual(missing.status, 0); assert.equal(missing.data.ok, false);
  assert.equal(missing.data.error.code, 'estimate_unavailable');
  assert.deepEqual(missing.data.error.details.missing_usage, ['input_seconds']);
  assert.equal(missing.data.error.message, ['The total cannot be estimated yet, so no quote was saved. It depends on:',
    '- input_seconds: pass the length of the input video or audio, in seconds, as media_seconds.', mapping].join('\n'));
  const quoted = await f.run(['estimate', '--model', 'seedance-2.0-mini-reference-to-video', '--input', input, '--media-seconds', '5']);
  assert.equal(quoted.status, 0, JSON.stringify(quoted)); assert.equal(quoted.data.estimate.status, 'estimated');
  assert.equal(quoted.data.total_known, true); assert.ok(quoted.data.quote_id); assert.ok(Number(quoted.data.amounts.uc) > 0);
  assert.equal(f.submissions, 0);
});
