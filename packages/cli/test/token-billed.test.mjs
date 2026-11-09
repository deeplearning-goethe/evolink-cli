// GPT Image token models, Gemini Omni Flash videos and Qwen TTS get a reference price from the shared core: the CLI saves
// the quote, submits only the generation input after approval, and compares an explicit budget with 1.5 times the reference.
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
import { Media, checkEstimate } from '../src/media.mjs';
import { State } from '../src/state.mjs';
import { calculateRulesEstimate } from '../src/platform/core/src/services/pricing-rules-estimate.js';
import { findModelParams } from '../src/platform/core/src/data/model-params.js';

// Published rules of 2026-10-31: the four GPT Image token models and a Gemini Omni video; of 2026-11-07: GPT Image 2.6
// and the Gemini Omni 1.2 edit and upscale; of 2026-11-08: Qwen TTS. A speech rule billed only by token counts the request
// cannot give (2026-10-14, the Qwen TTS rule) stands in for any model without a reference price, published for qwen3-tts-vd.
const snapshot = JSON.parse(readFileSync(new URL('./fixtures/pricing-rules-token-billed-20261031.json', import.meta.url)));
const snapshot26 = JSON.parse(readFileSync(new URL('./fixtures/pricing-rules-gpt-image-26-20261107.json', import.meta.url)));
const omni12 = JSON.parse(readFileSync(new URL('./fixtures/pricing-rules-omni-20261107.json', import.meta.url)));
const qwen = JSON.parse(readFileSync(new URL('./fixtures/pricing-rules-qwen-tts-20261108.json', import.meta.url)));
const tts = JSON.parse(readFileSync(new URL('./fixtures/pricing-rules-tts-20261014.json', import.meta.url)));
const OMNI = 'gemini-omni-flash-text-to-video', OMNI_EDIT = 'gemini-omni-1.2-flash-video-edit', OMNI_UP = 'gemini-omni-1.2-flash-video-upscale';
const QWEN = 'qwen-audio-3.1-tts-flash', TTS = 'qwen3-tts-vd';
const snapshotOmni = { meta: omni12.meta, models: omni12.models.filter(row => [OMNI_EDIT, OMNI_UP].includes(row.model_id)) };
const snapshotQwen = { meta: qwen.meta, models: [qwen.model] };
const snapshotTts = { meta: tts.meta, models: tts.models.map(row => ({ ...row, model_id: TTS, product_id: TTS })) };
const kinds = { 'gpt-image-1.5': 'image', 'gpt-image-2': 'image', 'gpt-image-2.5-flare': 'image', 'gpt-image-2.5-sunburst': 'image',
  'gpt-image-2.6-flare': 'image', 'gpt-image-2.6-sunburst': 'image', [OMNI]: 'video', [OMNI_EDIT]: 'video', [OMNI_UP]: 'video',
  [QWEN]: 'audio', [TTS]: 'audio' };
const GPT = Object.keys(kinds).filter(id => kinds[id] === 'image');
const rulesOf = id => [snapshot, snapshot26, snapshotOmni, snapshotQwen, snapshotTts].find(rules => rules.models.some(row => row.model_id === id));
const policy = id => ({ meta: { ...rulesOf(id).meta, fresh_until: new Date(Date.now() + 300000).toISOString() },
  model: structuredClone(rulesOf(id).models.find(row => row.model_id === id)) });
const reference = (id, input, options = {}) => calculateRulesEstimate(policy(id), { id, kind: kinds[id], aliases: [], spec: findModelParams(id) }, input, options);
const PROMPT = 'A red bicycle leaning against a brick wall at sunset, photorealistic.';

async function fixture(t, { balance = 10000 } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-token-billed-'));
  const f = { submissions: [] };
  const rows = Object.entries(kinds).map(([id, kind]) => ({ model_id: id, aliases: [], display_name: id, capabilities: [kind],
    protocols: [{ image: 'openai-images', video: 'evolink-video-generations', audio: 'openai-audio' }[kind]], lifecycle: 'active' }));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, f.origin);
    let body = ''; for await (const chunk of req) body += chunk;
    const send = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/v1/catalog/models') return send({ models: rows });
    if (url.pathname === '/v1/catalog/health') return send({ models: rows.map(row => ({ model_id: row.model_id, status: 'available' })) });
    if (url.pathname === '/v1/models') return send({ data: rows.map(row => ({ id: row.model_id })) });
    if (url.pathname.endsWith('/pricing-rules')) {
      const id = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      return send(id ? policy(id) : { meta: policy(GPT[0]).meta, models: Object.keys(kinds).map(model => policy(model).model) });
    }
    if (url.pathname === '/v1/credits') return send({ success: true, data: { user: { remaining_credits: balance }, token: { unlimited_credits: true } } });
    if (/^\/v1\/(images|videos|audios)\/generations$/.test(url.pathname)) {
      f.submissions.push(JSON.parse(body));
      // Already finished, so the generation does not wait for it.
      return send({ id: `task-token-${f.submissions.length}`, type: url.pathname.split('/')[2].replace(/s$/, ''), status: 'completed', progress: 100,
        results: [`${f.origin}/out.png`] });
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  f.server = new URL(`${f.origin}/mcp`); f.state = new State(home);
  f.client = new Api(new Credentials({ state: f.state, server: f.server, token: 'fixture-cli-token' }));
  f.media = new Media({ client: f.client, state: f.state, server: f.server });
  f.run = async (args, json = true) => {
    const bin = process.env.EVOLINK_CLI_TEST_BIN ?? fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
    const child = spawn(process.execPath, [bin, ...args, '--server', f.server.href, '--token-stdin', ...(json ? ['--json'] : [])], {
      env: { ...process.env, EVOLINK_CLI_HOME: home, EVOLINK_CLI_UPDATE_CHECK: '0', EVOLINK_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end('fixture-cli-token\n');
    let output = '', stderr = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => stderr += data);
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.ok(output.trim(), stderr); return { status, data: json ? JSON.parse(output) : output };
  };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(home, { recursive: true, force: true }); });
  return f;
}

test('the real CLI saves a reference-price quote and submits only the generation input after approval', async t => {
  const f = await fixture(t);
  for (const model of GPT) {
    const input = model === 'gpt-image-1.5' ? { prompt: PROMPT, size: '1024x1536' } : { prompt: PROMPT, size: '1:1', quality: 'medium' };
    const quoted = await f.run(['estimate', '--model', model, '--input', JSON.stringify(input)]);
    assert.equal(quoted.status, 0, JSON.stringify(quoted)); const view = quoted.data;
    assert.equal(view.estimate.status, 'token_billed', model); assert.equal(view.total_known, false, model);
    assert.deepEqual(view.amounts, reference(model, input).amounts, model);
    assert.ok(view.quote_id && view.requires_confirmation, model);
    assert.equal(view.next_step, `After the user approves, run evolink generate image --quote ${view.quote_id} --confirm.`, model);
    const before = f.submissions.length;
    const unconfirmed = await f.run(['generate', 'image', '--quote', view.quote_id]);
    assert.notEqual(unconfirmed.status, 0, model); assert.equal(f.submissions.length, before, model);
    const generated = await f.run(['generate', 'image', '--quote', view.quote_id, '--confirm']);
    assert.equal(generated.status, 0, JSON.stringify(generated)); assert.ok(generated.data.task_id, model);
    assert.deepEqual(f.submissions.slice(before), [{ ...input, model }], model);
    assert.equal(generated.data.estimate.status, 'token_billed', model);
  }
});

test('the real CLI quotes a GPT Image 2.6 GIF by its sheet and saves no quote for what the gateway refuses', async t => {
  const f = await fixture(t), model = 'gpt-image-2.6-flare', input = { prompt: PROMPT, output_format: 'gif', model_params: { frame_count: 4 } };
  const quoted = await f.run(['estimate', '--model', model, '--input', JSON.stringify(input)]);
  assert.equal(quoted.status, 0, JSON.stringify(quoted)); const view = quoted.data;
  assert.equal(view.estimate.status, 'token_billed'); assert.deepEqual(view.amounts, reference(model, input).amounts);
  assert.deepEqual(view.estimate.reference_usage.output.gif, { frames: 4, frame_width: 512, frame_height: 512, columns: 4, rows: 2 });
  const generated = await f.run(['generate', 'image', '--quote', view.quote_id, '--confirm']);
  assert.equal(generated.status, 0, JSON.stringify(generated)); assert.deepEqual(f.submissions, [{ ...input, model }]);
  for (const refused of [{ prompt: PROMPT, output_format: 'svg' }, { prompt: PROMPT, output_format: 'gif', n: 2 }, { prompt: PROMPT, output_format: 'gif', size: '1:1' },
    { prompt: PROMPT, markup_url: 'https://files.example/markup.png' }, { prompt: PROMPT, background: 'transparent', output_format: 'jpeg' }]) {
    const result = await f.run(['estimate', '--model', model, '--input', JSON.stringify(refused)]);
    assert.notEqual(result.status, 0, JSON.stringify(refused)); assert.equal(result.data.quote_id, undefined, JSON.stringify(refused));
  }
  assert.equal(f.submissions.length, 1);
});

test('a budget takes a reference price only when 1.5 times it fits, before and at submission', async t => {
  const f = await fixture(t), model = 'gpt-image-2.5-flare', input = { prompt: PROMPT, size: '16:9', resolution: '2K', quality: 'high' };
  const usd = Number(reference(model, input).amounts.usd);
  for (const [factor, allowed] of [[0.9, false], [1.3, false], [1.49, false], [1.51, true], [3, true]]) {
    const cap = Number((usd * factor).toFixed(8)), before = f.submissions.length;
    if (!allowed) {
      await assert.rejects(f.media.estimate({ model, input, max_cost_usd: cap }), error => {
        assert.equal(error.code, 'cost_exceeds_cap', `${factor}`);
        assert.equal(error.message, 'The reference price is billed by actual token usage, and 1.5 times it exceeds max-cost-usd.');
        return true;
      });
      continue;
    }
    const quote = await f.media.estimate({ model, input, max_cost_usd: cap });
    assert.equal(quote.max_cost_usd, cap); assert.equal(quote.cap_source, 'user');
    const generated = await f.media.generate('image', quote.quote_id, { confirmed: true });
    assert.ok(generated.task_id, `${factor}`);
    assert.deepEqual(f.submissions.slice(before), [{ ...input, model }], `${factor}`);
    assert.equal(generated.budget_check.factor, '1.5', `${factor}`);
  }
});

test('seed 20261031: checkEstimate compares a reference price with 1.5 times it, exactly', () => {
  let seed = 20261031; const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  let allowed = 0, refused = 0;
  for (let i = 0; i < 400; i++) {
    const uc = 1 + Math.floor(random() * 2_000_000), usd = uc / 680000;
    const cap = Number((usd * 1.5 * (0.98 + random() * 0.04)).toFixed(8));
    const view = { input_valid: true, enough_balance: true, estimate: { status: 'token_billed', min_usd: usd, max_usd: usd },
      pricing_quote: { total_uc: String(uc), expires_at: new Date(Date.now() + 60_000).toISOString() } };
    const fits = BigInt(uc) * 3n * 100_000_000n <= BigInt(Math.round(cap * 1e8)) * 2n * 680_000n;
    if (fits) { assert.doesNotThrow(() => checkEstimate(view, cap), `${uc} ${cap}`); allowed++; }
    else { assert.throws(() => checkEstimate(view, cap), { code: 'cost_exceeds_cap' }); refused++; }
    // Without a priced approval record there is nothing to compare: the budget cannot be checked.
    assert.throws(() => checkEstimate({ ...view, pricing_quote: undefined }, cap), { code: 'uncheckable_cap' });
    assert.throws(() => checkEstimate({ ...view, estimate: { ...view.estimate, uncheckable_reason: 'usage' } }, cap), { code: 'uncheckable_cap' });
  }
  assert.ok(allowed > 100 && refused > 100, `${allowed} allowed, ${refused} refused`);
  assert.doesNotThrow(() => checkEstimate({ input_valid: true, estimate: { status: 'token_billed', min_usd: 0.01, max_usd: 0.01 } }));
  assert.throws(() => checkEstimate({ input_valid: true, estimate: { status: 'token_billed', min_usd: 0.02, max_usd: 0.01 } }), { code: 'estimate_unavailable' });
});

test('token counts in --pricing-parameters do not change a GPT Image reference price', async t => {
  const f = await fixture(t), model = 'gpt-image-2', input = { prompt: PROMPT };
  const plain = await f.media.estimate({ model, input });
  const counted = await f.media.estimate({ model, input, pricing_parameters: { image_output_tokens: 0, text_input_tokens: 0, image_input_tokens: 0 } });
  assert.deepEqual(counted.amounts, plain.amounts); assert.equal(counted.pricing_quote.request_hash, plain.pricing_quote.request_hash);
  assert.ok(counted.estimate.notes.some(note => note.startsWith('pricing_parameters image_input_tokens, image_output_tokens, text_input_tokens are not used')));
  const generated = await f.media.generate('image', counted.quote_id, { confirmed: true });
  assert.ok(generated.task_id); assert.deepEqual(f.submissions, [{ ...input, model }]);
});

test('token counts given as 0 for a model that needs them save no quote', async t => {
  const f = await fixture(t);
  const zeros = { input_tokens: 0, output_tokens: 0 };
  const refused = await f.run(['estimate', '--model', TTS, '--input', JSON.stringify({ prompt: 'a fox', voice: 'narrator' }), '--pricing-parameters', JSON.stringify(zeros)]);
  assert.notEqual(refused.status, 0); assert.equal(refused.data.error.code, 'estimate_unavailable');
  assert.deepEqual(refused.data.error.details.missing_usage, ['input_tokens', 'output_tokens']);
  assert.match(refused.data.error.message, /^The total cannot be estimated yet, so no quote was saved\./);
  assert.equal(f.submissions.length, 0);
});

test('the real CLI quotes a Gemini Omni Flash video by its reference price; token counts are not used', async t => {
  const f = await fixture(t), input = { prompt: 'A red fox running through fresh snow at dawn.' };
  const quoted = await f.run(['estimate', '--model', OMNI, '--input', JSON.stringify(input)]);
  assert.equal(quoted.status, 0, JSON.stringify(quoted)); const view = quoted.data;
  assert.equal(view.estimate.status, 'token_billed'); assert.equal(view.total_known, false);
  assert.deepEqual(view.amounts, reference(OMNI, input).amounts); assert.ok(Number(view.amounts.uc) > 0);
  const zeros = { input_tokens: 0, video_output_tokens: 0, other_output_tokens: 0 };
  const counted = await f.run(['estimate', '--model', OMNI, '--input', JSON.stringify(input), '--pricing-parameters', JSON.stringify(zeros)]);
  assert.equal(counted.status, 0, JSON.stringify(counted));
  assert.deepEqual(counted.data.amounts, view.amounts); assert.equal(counted.data.pricing_quote.request_hash, view.pricing_quote.request_hash);
  assert.ok(counted.data.estimate.notes.some(note => note.startsWith('pricing_parameters input_tokens, other_output_tokens, video_output_tokens are not used')));
  const generated = await f.run(['generate', 'video', '--quote', view.quote_id, '--confirm']);
  assert.equal(generated.status, 0, JSON.stringify(generated)); assert.ok(generated.data.task_id);
  assert.deepEqual(f.submissions, [{ ...input, model: OMNI }]);
});

test('the real CLI quotes Qwen TTS by what EvoLink reserves for the text; token counts are not used; a budget must cover 1.5 times it', async t => {
  const f = await fixture(t), input = { input: 'hello' };
  const quoted = await f.run(['estimate', '--model', QWEN, '--input', JSON.stringify(input)]);
  assert.equal(quoted.status, 0, JSON.stringify(quoted)); const view = quoted.data;
  assert.equal(view.estimate.status, 'token_billed'); assert.equal(view.total_known, false);
  // Five lowercase letters: 2 + 5 input tokens and ceil((20 + 5 x 9) / 2) = 33 output tokens, at 150 and 1200 UC per 1,000.
  assert.deepEqual(view.estimate.reference_usage.tokens, { input_tokens: 7, output_tokens: 33 });
  assert.equal(view.amounts.uc, String(Math.ceil(7 * 150 / 1000) + Math.ceil(33 * 1200 / 1000)));
  assert.deepEqual(view.amounts, reference(QWEN, input).amounts);
  assert.equal(view.estimate.basis[0], 'Reference price: published token rates applied to what EvoLink reserves at submission for this input: 7 input tokens and 33 output tokens for 5 characters of text, each part rounded up.');
  const zeros = { input_tokens: 0, output_tokens: 0 };
  const counted = await f.run(['estimate', '--model', QWEN, '--input', JSON.stringify(input), '--pricing-parameters', JSON.stringify(zeros)]);
  assert.equal(counted.status, 0, JSON.stringify(counted)); assert.deepEqual(counted.data.amounts, view.amounts);
  assert.equal(counted.data.pricing_quote.request_hash, view.pricing_quote.request_hash);
  assert.ok(counted.data.estimate.notes.some(note => note.startsWith('pricing_parameters input_tokens, output_tokens are not used')));
  const generated = await f.run(['generate', 'audio', '--quote', view.quote_id, '--confirm']);
  assert.equal(generated.status, 0, JSON.stringify(generated)); assert.ok(generated.data.task_id);
  assert.deepEqual(f.submissions, [{ ...input, model: QWEN }]);
  const text = { input: 'A calm voice reads the evening news, 第一条：天气晴朗。'.repeat(20) }, usd = Number(reference(QWEN, text).amounts.usd);
  for (const [factor, allowed] of [[1.49, false], [1.51, true]]) {
    const cap = Number((usd * factor).toFixed(8));
    if (allowed) assert.equal((await f.media.estimate({ model: QWEN, input: text, max_cost_usd: cap })).max_cost_usd, cap);
    else await assert.rejects(f.media.estimate({ model: QWEN, input: text, max_cost_usd: cap }), { code: 'cost_exceeds_cap' });
  }
  // Text the gateway refuses before reserving gets no quote.
  const long = await f.run(['estimate', '--model', QWEN, '--input', JSON.stringify({ input: 'a'.repeat(5001) })]);
  assert.notEqual(long.status, 0); assert.equal(long.data.quote_id, undefined);
  assert.equal(f.submissions.length, 1);
});

test('the real CLI reads Qwen TTS hot_fix null as no hot_fix, as EvoLink does: the same quote, and it is not submitted', async t => {
  const f = await fixture(t), plain = { input: 'hello' }, nulled = { ...plain, hot_fix: null }, want = reference(QWEN, plain);
  const quoted = await f.run(['estimate', '--model', QWEN, '--input', JSON.stringify(nulled)]);
  assert.equal(quoted.status, 0, JSON.stringify(quoted)); const view = quoted.data;
  assert.equal(view.estimate.status, 'token_billed'); assert.deepEqual(view.amounts, want.amounts);
  assert.equal(view.pricing_quote.request_hash, want.approval.request_hash);
  const generated = await f.run(['generate', 'audio', '--quote', view.quote_id, '--confirm']);
  assert.equal(generated.status, 0, JSON.stringify(generated)); assert.ok(generated.data.task_id);
  assert.deepEqual(f.submissions, [{ ...plain, model: QWEN }]);
});

test('the real CLI shows a Gemini Omni reference price at each input resolution, the quoted one at 4k', async t => {
  const f = await fixture(t), video = 'https://files.example/source.mp4';
  const editInput = { prompt: 'Turn the street into a snowy evening.', video_urls: [video] };
  const edit = await f.run(['estimate', '--model', OMNI_EDIT, '--input', JSON.stringify(editInput), '--media-seconds', '5']);
  assert.equal(edit.status, 0, JSON.stringify(edit));
  const prices = edit.data.estimate.reference_usage.input_resolution_prices;
  assert.deepEqual(prices.map(price => [price.resolution, price.quoted]), [['360p', undefined], ['720p', undefined], ['1080p', undefined], ['4k', true]]);
  assert.deepEqual(prices[3].amounts, edit.data.amounts); assert.deepEqual(edit.data.amounts, reference(OMNI_EDIT, editInput, { mediaSeconds: 5 }).amounts);
  assert.ok(prices.every((price, i) => i === 0 || BigInt(price.amounts.uc) >= BigInt(prices[i - 1].amounts.uc)));
  // The one lower price of earlier releases stays: 720p.
  assert.deepEqual(edit.data.estimate.reference_usage.lower_input, { resolution: '720p', amounts: prices[1].amounts });
  const listed = prices.map(price => `${price.resolution}${price.quoted ? ' (quoted)' : ''}: ${price.amounts.credits} credits (about $${price.amounts.usd})`).join('; ');
  assert.ok(edit.data.estimate.notes.some(note => note.endsWith(`If the input video is ${listed}.`)), JSON.stringify(edit.data.estimate.notes));
  // The terminal shows the same prices.
  const terminal = await f.run(['estimate', '--model', OMNI_EDIT, '--input', JSON.stringify(editInput), '--media-seconds', '5'], false);
  assert.equal(terminal.status, 0, terminal.data);
  assert.ok(terminal.data.includes(`If the input video is ${listed}.`), terminal.data);
  // An upscale lists the source resolutions EvoLink upscales to the target; the quoted one costs most.
  const upInput = { video_urls: [video], quality: '1080p' };
  const up = await f.run(['estimate', '--model', OMNI_UP, '--input', JSON.stringify(upInput), '--media-seconds', '4']);
  assert.equal(up.status, 0, JSON.stringify(up));
  const sources = up.data.estimate.reference_usage.input_resolution_prices;
  assert.ok(sources.length >= 1 && sources.filter(price => price.quoted).length === 1);
  assert.deepEqual(sources.find(price => price.quoted).amounts, up.data.amounts);
  assert.ok(sources.every(price => BigInt(price.amounts.uc) <= BigInt(up.data.amounts.uc)));
  assert.ok(up.data.estimate.notes.some(note => note.includes('If the source video is ')));
  // Approval submits only the generation input.
  const generated = await f.run(['generate', 'video', '--quote', edit.data.quote_id, '--confirm']);
  assert.equal(generated.status, 0, JSON.stringify(generated)); assert.deepEqual(f.submissions, [{ ...editInput, model: OMNI_EDIT }]);
});

test('the balance is checked against the reference price', async t => {
  const f = await fixture(t, { balance: 0.5 });
  await assert.rejects(f.media.estimate({ model: 'gpt-image-2.5-flare', input: { prompt: PROMPT, size: '1:1', quality: 'max' } }), { code: 'insufficient_balance' });
  assert.equal(f.submissions.length, 0);
});
