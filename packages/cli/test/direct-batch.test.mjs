// Generation without a quote (--skip-estimate), quote expiry and price changes, and batches (--inputs-file), through the shared core
// against a fake gateway that keeps request IDs the way EvoLink does: the same ID and body replay the first answer, a
// different body under that ID is refused (409 idempotency_conflict), and rate limits (429) and balance refusals (402)
// release the ID. Expected values come from rule functions and the published rules of 2026-10-23, not from the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api } from '../src/api.mjs';
import { Credentials } from '../src/auth.mjs';
import { Media, RECOVERY_WINDOW_MS } from '../src/media.mjs';
import { State } from '../src/state.mjs';
import { amountsForUC, calculateRulesEstimate, APPROVAL_TTL_MS } from '../src/platform/core/src/services/pricing-rules-estimate.js';
import { resetPricingRulesCacheForTests } from '../src/platform/core/src/services/pricing-rules-client.js';
import { resetCatalogCacheForTests } from '../src/platform/core/src/services/catalog-client.js';
import { findModelParams } from '../src/platform/core/src/data/model-params.js';
import { MAX_BATCH_ITEMS } from '../src/platform/core/src/services/batch-generation.js';

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/pricing-rules-usage-20261023.json', import.meta.url)));
const SEED = 20261107;
const SEEDREAM = 'doubao-seedream-4.5';
/** One model per estimate status in the 10-23 rules, and its minimal valid input. */
const MODELS = {
  [SEEDREAM]: { kind: 'image', status: 'estimated', input: prompt => ({ prompt }) },
  'gemini-3-pro-image-preview': { kind: 'image', status: 'partial', input: prompt => ({ prompt }) },
  'gpt-image-2': { kind: 'image', status: 'token_billed', input: prompt => ({ prompt, size: '1:1' }) },
  'seedance-2.5-video-edit': { kind: 'video', status: 'needs_input', input: prompt => ({ prompt, video_urls: ['https://example.test/source.mp4'] }) },
};
const BY_STATUS = Object.fromEntries(Object.entries(MODELS).map(([id, model]) => [model.status, id]));
const meta = () => ({ ...snapshot.meta, fresh_until: new Date(Date.now() + 300_000).toISOString() });

/** A model's rule with every component rate, tier and minimum charge moved by `delta` UC; `version` publishes it again. */
function rule(id, delta = 0, version = false) {
  const copy = structuredClone(snapshot.models.find(row => row.model_id === id));
  if (version) { copy.policy_version += 1; copy.policy_checksum = createHash('sha256').update(copy.policy_checksum).digest('hex'); }
  if (!delta) return copy;
  const move = rate => amountsForUC(String(BigInt(rate.uc.split('.')[0]) + BigInt(delta)));
  for (const component of copy.components) {
    component.rate = move(component.rate);
    for (const tier of component.tiers) tier.rate = move(tier.rate);
    // A minimum equal to the rate would hold a lower rate up.
    if (component.minimum_charge && component.minimum_charge.uc !== '0') component.minimum_charge = move(component.minimum_charge);
  }
  return copy;
}
/** Pricing-rules answers that leave no price to compute, and the reason the shared core gives for setting them aside. */
const RULE_FAILURES = {
  rate_limited: { reason: 'rules_rate_limited', answer: () => [429, { error: { code: 'rate_limit_exceeded' } }, { 'Retry-After': '20' }] },
  server_error: { reason: 'rules_unavailable', answer: () => [500, { error: 'boom' }] },
  not_found: { reason: 'no_published_rule', answer: () => [404, { error: 'missing' }] },
  unavailable: { reason: 'no_published_rule', answer: id => [200, { meta: meta(), model: { ...rule(id), pricing_status: 'unavailable' } }] },
};
const CAPS = { absent: undefined, generous: 1000, tiny: 0.000001 };

/** Runs `work` with the clock (Date.now) moved forward by `ms`, for the CLI and the shared core alike. */
async function later(ms, work) {
  const now = Date.now; Date.now = () => now() + ms;
  try { return await work(); } finally { Date.now = now; }
}
/** Runs `work` with the CLI's clock stopped at `time`, for exact expiry boundaries, and the shared core's moved there. */
async function at(f, time, work) {
  const cli = f.media.now; f.media.now = () => time;
  try { return await later(time - Date.now(), work); } finally { f.media.now = cli; }
}

function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function shuffle(list, random) {
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
}

/**
 * A gateway answering from the 10-23 rules. A generation's prompt tag picks its answer: [ratelimit] 429 and [balance]
 * 402 until `recovered`, both releasing the ID; [invalid] a 400 kept for the ID; [lost] a task whose reply never
 * arrives (twice, so the shared core's retry is lost too) until `recovered`; anything else is accepted.
 */
async function gateway(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-direct-batch-'));
  const f = { delta: 0, version: false, rulesFailure: undefined, ledger: new Map(), tasks: new Map(), keyTasks: new Map(), posts: [], recovered: false, inFlight: 0, maxInFlight: 0 };
  const rows = Object.entries(MODELS).map(([id, model]) => ({ model_id: id, aliases: [], display_name: id, capabilities: [model.kind],
    protocols: [model.kind === 'image' ? 'openai-images' : 'evolink-video-generations'], lifecycle: 'active' }));
  async function submit(req, res, url, body, send) {
    const key = req.headers['idempotency-key'], hash = createHash('sha256').update(`${url.pathname}\0${body}`).digest('hex');
    const data = JSON.parse(body), tag = /\[(\w+)\]/.exec(data.prompt ?? '')?.[1] ?? 'accept';
    f.posts.push({ key, body: data, tag });
    f.inFlight++; f.maxInFlight = Math.max(f.maxInFlight, f.inFlight);
    try {
      // Long enough for the submissions of a batch to overlap.
      await new Promise(resolve => setTimeout(resolve, 20));
      const kept = f.ledger.get(key);
      if (kept) {
        if (kept.hash !== hash) return send(409, { error: { code: 'idempotency_conflict', message: 'The Idempotency-Key was already used for a different paid request.' } });
        if (kept.drops > 0) { kept.drops--; req.socket.destroy(); return; }
        return send(kept.status, kept.value, { 'Idempotency-Replayed': 'true' });
      }
      if (tag === 'ratelimit' && !f.recovered) return send(429, { error: { code: 'rate_limit_exceeded', message: 'Too many requests.' } });
      if (tag === 'balance' && !f.recovered) return send(402, { error: { code: 'insufficient_quota', message: 'The account balance is insufficient.' } });
      if (tag === 'invalid') {
        const value = { error: { code: 'invalid_parameters', message: 'The prompt was refused.' } };
        f.ledger.set(key, { hash, status: 400, value, drops: 0 });
        return send(400, value);
      }
      const id = `task-${f.tasks.size + 1}`, type = url.pathname.split('/')[2].replace(/s$/, '');
      const task = { id, model: data.model, type, status: 'completed', progress: 100, results: [`${f.origin}/out-${id}.png`], usage: { credits_reserved: 34 } };
      f.tasks.set(id, task); f.keyTasks.set(key, (f.keyTasks.get(key) ?? 0) + 1);
      const lost = tag === 'lost' && !f.recovered;
      f.ledger.set(key, { hash, status: 200, value: task, drops: lost ? 1 : 0 });
      if (lost) { req.socket.destroy(); return; }
      return send(200, task);
    } finally { f.inFlight--; }
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, f.origin);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const send = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/v1/catalog/models') return send(200, { models: rows });
    if (url.pathname === '/v1/catalog/health') return send(200, { models: rows.map(row => ({ model_id: row.model_id, status: 'available' })) });
    if (url.pathname === '/v1/models') return send(200, { data: rows.map(row => ({ id: row.model_id })) });
    if (url.pathname.endsWith('/pricing-rules')) {
      f.ruleReads = (f.ruleReads ?? 0) + 1;
      const id = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      if (f.rulesFailure) { const [status, value, headers] = f.rulesFailure.answer(id); return send(status, value, headers); }
      return send(200, id ? { meta: meta(), model: rule(id, f.delta, f.version) } : { meta: meta(), models: Object.keys(MODELS).map(model => rule(model, f.delta, f.version)) });
    }
    if (url.pathname === '/v1/credits') return send(200, { success: true, data: { user: { remaining_credits: 1_000_000 }, token: { unlimited_credits: true } } });
    if (url.pathname === '/v1/tasks/batch') return send(200, { data: JSON.parse(body).task_ids.flatMap(id => f.tasks.has(id) ? [f.tasks.get(id)] : []) });
    if (url.pathname.startsWith('/v1/tasks/')) {
      const id = decodeURIComponent(url.pathname.slice('/v1/tasks/'.length));
      return f.tasks.has(id) ? send(200, f.tasks.get(id)) : send(404, { error: { code: 'task_not_found', message: 'Task not found.' } });
    }
    if (req.method === 'POST' && /^\/v1\/(images|videos|audios)\/generations$/.test(url.pathname)) return submit(req, res, url, body, send);
    send(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  f.server = new URL(`${f.origin}/mcp`); f.home = home; f.state = new State(home);
  f.client = new Api(new Credentials({ state: f.state, server: f.server, token: 'fixture-cli-token' }));
  // Read at each use, so later() moves the CLI's clock together with the shared core's.
  f.media = new Media({ client: f.client, state: f.state, server: f.server, now: () => Date.now() });
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
  f.file = async (name, content) => { const file = path.join(home, name); await fs.writeFile(file, content); return file; };
  f.reset = () => { resetPricingRulesCacheForTests(); resetCatalogCacheForTests(); };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(home, { recursive: true, force: true }); });
  f.reset();
  return f;
}

/** What --skip-estimate does: the estimate is set aside, never invalid input or an explicit budget the price cannot meet. */
function expectedDirect(c) {
  if (!c.valid) return { refused: 'invalid' };
  const failure = RULE_FAILURES[c.scenario], status = failure ? undefined : c.scenario;
  if (c.cap !== 'absent' && (failure || status === 'partial' || status === 'needs_input' || c.cap === 'tiny')) return { refused: 'cap' };
  return { reason: failure ? failure.reason : status === 'needs_input' ? 'needs_input' : 'none' };
}

test(`seed ${SEED}: --skip-estimate x estimate outcome and unreadable rules x budget x valid input`, async t => {
  const f = await gateway(t), random = rng(SEED);
  const cases = [];
  for (const scenario of [...Object.keys(BY_STATUS), ...Object.keys(RULE_FAILURES)]) for (const cap of Object.keys(CAPS)) for (const valid of [true, false]) cases.push({ scenario, cap, valid });
  shuffle(cases, random);
  assert.equal(cases.length, 8 * 3 * 2);
  let submitted = 0, refused = 0;
  for (const [i, c] of cases.entries()) {
    f.reset(); f.rulesFailure = RULE_FAILURES[c.scenario];
    const label = JSON.stringify(c), model = BY_STATUS[c.scenario] ?? SEEDREAM, { kind } = MODELS[model];
    const input = { ...MODELS[model].input(`seed ${SEED} case ${i}: a red bicycle`), ...(c.valid ? {} : { bogus_parameter: 1 }) };
    const before = f.posts.length, want = expectedDirect(c);
    let result, error;
    try { result = await f.media.direct(kind, { model, input, ...(CAPS[c.cap] !== undefined ? { max_cost_usd: CAPS[c.cap] } : {}) }); } catch (e) { error = e; }
    if (want.refused) {
      assert.ok(error, `${label} must be refused`); assert.equal(f.posts.length, before, label);
      assert.equal(error.details.charged, 'no', label);
      if (want.refused === 'invalid') assert.ok(error.details.problems?.length, label);
      else assert.equal(error.details.error.param, 'max_cost_usd', `${label} ${error.message}`);
      const saved = await f.state.read('quotes', error.details.quote_id);
      assert.equal(saved.state, 'refused', label); assert.equal(saved.skip_estimate, true, label);
      refused++; continue;
    }
    assert.ifError(error);
    assert.equal(f.posts.length, before + 1, label);
    const post = f.posts.at(-1), saved = await f.state.read('quotes', result.quote_id);
    assert.deepEqual(post.body, { ...result.submitted.input, model }, label);
    assert.equal(post.key, saved.client_request_id, label); assert.equal(saved.state, 'submitted', label); assert.equal(saved.task_id, result.task_id, label);
    assert.equal(result.estimate_skipped, true, label); assert.equal(result.estimate_skip_reason, want.reason, label);
    assert.match(result.text, /skip_estimate/, label);
    submitted++;
  }
  f.rulesFailure = undefined;
  assert.ok(submitted >= 10 && refused >= 20, `${submitted} submitted, ${refused} refused`);
});

test('a direct submission whose reply is lost recovers with its own request ID and creates one task', async t => {
  const f = await gateway(t);
  let quoteId;
  await assert.rejects(f.media.direct('image', { model: SEEDREAM, input: { prompt: 'direct [lost]' } }), error => {
    quoteId = error.details.quote_id;
    return error.details.submission_state === 'outcome_unknown' && error.details.recovery === `evolink tasks resume --quote ${quoteId}`;
  });
  const saved = await f.state.read('quotes', quoteId);
  assert.equal(saved.state, 'outcome_unknown'); assert.equal(saved.skip_estimate, true);
  assert.ok(f.posts.every(post => post.key === saved.client_request_id));
  const recovered = await f.media.resume(quoteId);
  assert.equal(recovered.task_id, 'task-1'); assert.equal(f.tasks.size, 1); assert.equal(f.keyTasks.get(saved.client_request_id), 1);
  assert.equal((await f.state.read('quotes', quoteId)).state, 'submitted');
});

test('a quote holds for 24 hours from the estimate at the approved price or lower, also under later rules; from its expiry on it needs a new estimate', async t => {
  const f = await gateway(t);
  const quote = await f.media.estimate({ model: SEEDREAM, input: { prompt: 'held for a day' } });
  const saved = await f.state.read('quotes', quote.quote_id), expiry = new Date(saved.expires_at).toISOString();
  assert.ok(Math.abs(saved.expires_at - saved.created_at - APPROVAL_TTL_MS) < 5_000);
  // At expires_at and later nothing is submitted, whatever the price, and the quote stays unsubmitted.
  for (const [offset, delta] of [[0, 0], [1, 0], [3 * 86_400_000, 0], [1, -1000], [1, 1000]]) {
    f.delta = delta; f.reset();
    await assert.rejects(at(f, saved.expires_at + offset, () => f.media.generate('image', quote.quote_id, { confirmed: true })), error => {
      assert.equal(error.code, 'quote_expired', `${offset} ${delta}`);
      assert.equal(error.message, `This quote expired at ${expiry}. Refresh it with evolink estimate --refresh-quote ${quote.quote_id} and obtain the user's approval again. Nothing was submitted.`);
      assert.equal(error.details.next_step, `evolink estimate --refresh-quote ${quote.quote_id}`); assert.equal(error.details.submission_allowed, false);
      return true;
    });
  }
  assert.equal(f.posts.length, 0); assert.equal((await f.state.read('quotes', quote.quote_id)).state, 'quoted');
  // A millisecond before, a lower price under a later policy version submits, and the result says nothing about expiry.
  f.delta = -1000; f.version = true; f.reset();
  const lower = await at(f, saved.expires_at - 1, () => f.media.generate('image', quote.quote_id, { confirmed: true }));
  assert.ok(lower.task_id); assert.equal(f.posts.length, 1);
  assert.equal(lower.approval_expired, undefined); assert.doesNotMatch(lower.text ?? '', /expired/);
  const sent = await f.state.read('quotes', quote.quote_id);
  assert.equal(sent.state, 'submitted'); assert.ok(BigInt(sent.args.pricing_quote.total_uc) < BigInt(saved.args.pricing_quote.total_uc));
  // Before expiry a higher price needs a new approval; the same price under a later policy version does not.
  f.delta = 0; f.version = false; f.reset();
  const dearer = await f.media.estimate({ model: SEEDREAM, input: { prompt: 'one credit dearer' } });
  const same = await f.media.estimate({ model: SEEDREAM, input: { prompt: 'same price, new rules' } });
  f.delta = 1; f.reset();
  await assert.rejects(f.media.generate('image', dearer.quote_id, { confirmed: true }),
    error => error.code === 'price_changed' && error.message === 'The price rose since the quote was approved. Estimate again and obtain approval for the new quote.');
  assert.equal((await f.state.read('quotes', dearer.quote_id)).state, 'quoted');
  f.delta = 0; f.version = true; f.reset();
  assert.ok((await f.media.generate('image', same.quote_id, { confirmed: true })).task_id);
  assert.equal(f.posts.length, 2);
  f.version = false;
});

test('tasks resume replays the original request ID only within 23 hours of its first submission', async t => {
  const f = await gateway(t);
  let now = Date.now(); f.media.now = () => now;
  for (const [offset, allowed] of [[RECOVERY_WINDOW_MS - 1, true], [RECOVERY_WINDOW_MS, false], [RECOVERY_WINDOW_MS + 60_000, false]]) {
    now = Date.now();
    const quote = await f.media.estimate({ model: SEEDREAM, input: { prompt: `recover after ${offset} [lost]` } });
    // Submitted an hour after the estimate: the window counts from the submission.
    now += 3_600_000;
    await assert.rejects(f.media.generate('image', quote.quote_id, { confirmed: true }), error => error.details.submission_state === 'outcome_unknown');
    const saved = await f.state.read('quotes', quote.quote_id);
    assert.equal(saved.state, 'outcome_unknown'); assert.equal(saved.approved_at, now);
    const tasks = f.tasks.size, posts = f.posts.length;
    now = saved.approved_at + offset;
    if (allowed) {
      const recovered = await f.media.resume(quote.quote_id);
      assert.ok(recovered.task_id); assert.equal(f.tasks.size, tasks, 'the original task, not a new one');
      assert.equal((await f.state.read('quotes', quote.quote_id)).state, 'submitted');
    } else {
      await assert.rejects(f.media.resume(quote.quote_id), error => error.code === 'recovery_window_passed' && error.details.submission_allowed === false);
      assert.equal(f.posts.length, posts); assert.equal((await f.state.read('quotes', quote.quote_id)).state, 'outcome_unknown');
    }
  }
});

test('tasks resume follows the same rule: at a higher price or past the expiry nothing is sent, and the user checks what went through first', async t => {
  const f = await gateway(t);
  const quote = await f.media.estimate({ model: SEEDREAM, input: { prompt: 'resume under the quote [lost]' } });
  const saved = await f.state.read('quotes', quote.quote_id), expiry = new Date(saved.expires_at).toISOString();
  // Submitted two hours after the estimate, so its recovery window (23 hours from then) outlasts the quote.
  await assert.rejects(at(f, saved.created_at + 2 * 3_600_000, () => f.media.generate('image', quote.quote_id, { confirmed: true })),
    error => error.details.submission_state === 'outcome_unknown');
  const unknown = await f.state.read('quotes', quote.quote_id);
  assert.equal(unknown.state, 'outcome_unknown'); assert.ok(saved.expires_at < unknown.approved_at + RECOVERY_WINDOW_MS);
  const tasks = f.tasks.size, posts = f.posts.length;
  // A higher price: the shared core refuses to replay the approval, before anything is sent.
  f.delta = 1000; f.reset();
  await assert.rejects(at(f, saved.created_at + 3 * 3_600_000, () => f.media.resume(quote.quote_id)), error => {
    assert.equal(error.code, 'price_changed'); assert.equal(error.details.charged, 'unknown'); assert.equal(error.details.submission_state, 'outcome_unknown');
    assert.equal(error.details.next_step, 'evolink tasks list --since 2d'); assert.equal(error.details.submission_allowed, false); assert.ok(error.details.dashboard_url);
    assert.equal(error.message, 'The price rose since the quote was approved, so the replay was not sent, and the original submission remains unverified. Check evolink tasks list --since 2d first to see whether it went through; only if it did not, estimate it again and, after the user approves, submit it as a new generation.');
    return true;
  });
  // From the quote's expiry on, 22 hours after the submission and so inside the recovery window, whatever the price.
  for (const [offset, delta] of [[0, 0], [1, -1000], [1_800_000, 0]]) {
    f.delta = delta; f.reset();
    await assert.rejects(at(f, saved.expires_at + offset, () => f.media.resume(quote.quote_id)), error => {
      assert.equal(error.code, 'quote_expired', `${offset} ${delta}`);
      assert.equal(error.message, `This quote expired at ${expiry}, so its submission cannot be recovered with it. Check evolink tasks list --since 2d first to see whether it went through; only if it did not, estimate it again and, after the user approves, submit it as a new generation. Nothing was submitted.`);
      assert.equal(error.details.next_step, 'evolink tasks list --since 2d'); assert.equal(error.details.submission_allowed, false); assert.ok(error.details.dashboard_url);
      return true;
    });
  }
  // Past the recovery window the window's own refusal comes first, as before.
  await assert.rejects(at(f, unknown.approved_at + RECOVERY_WINDOW_MS, () => f.media.resume(quote.quote_id)), { code: 'recovery_window_passed' });
  assert.equal(f.posts.length, posts); assert.equal((await f.state.read('quotes', quote.quote_id)).state, 'outcome_unknown');
  // A millisecond before the expiry, at a lower price, the replay finds the original task.
  f.delta = -1000; f.reset();
  const recovered = await at(f, saved.expires_at - 1, () => f.media.resume(quote.quote_id));
  assert.ok(recovered.task_id); assert.equal(f.tasks.size, tasks, 'the original task, not a new one');
  assert.equal(f.keyTasks.get(unknown.client_request_id), 1); assert.equal((await f.state.read('quotes', quote.quote_id)).state, 'submitted');
  f.delta = 0;
});

test('finishing a batch with tasks resume follows the same rule: past the expiry nothing is sent; before it a lower total finishes the batch', async t => {
  const f = await gateway(t);
  const quote = await f.media.estimate({ model: SEEDREAM, inputs: [{ prompt: 'kept [accept]' }, { prompt: 'later [ratelimit]' }] });
  const saved = await f.state.read('quotes', quote.quote_id), expiry = new Date(saved.expires_at).toISOString();
  await at(f, saved.created_at + 2 * 3_600_000, () => f.media.generate('image', quote.quote_id, { confirmed: true }));
  const partial = await f.state.read('quotes', quote.quote_id), [kept] = partial.task_ids;
  assert.equal(partial.state, 'partial'); assert.equal(partial.task_ids.length, 1);
  f.recovered = true;
  const posts = f.posts.length;
  for (const [offset, delta] of [[0, 0], [1, -1000]]) {
    f.delta = delta; f.reset();
    await assert.rejects(at(f, saved.expires_at + offset, () => f.media.resume(quote.quote_id)), error => {
      assert.equal(error.code, 'quote_expired', `${offset} ${delta}`);
      assert.equal(error.message, `This quote expired at ${expiry}, so its batch cannot be finished with it. Check evolink tasks batch --ids ${kept} and evolink tasks list --since 2d first to see which inputs went through; then estimate only the inputs that did not and, after the user approves, submit them as a new batch. Nothing was submitted.`);
      assert.deepEqual(error.details.task_ids, [kept]); assert.equal(error.details.next_step, `evolink tasks batch --ids ${kept}`);
      return true;
    });
  }
  assert.equal(f.posts.length, posts); assert.equal((await f.state.read('quotes', quote.quote_id)).state, 'partial');
  // A millisecond before, at a lower total, the same request ID finishes it; the accepted input is not charged again.
  f.delta = -1000; f.reset();
  const finished = await at(f, saved.expires_at - 1, () => f.media.resume(quote.quote_id));
  assert.deepEqual(finished.items.map(item => item.submission_state), ['accepted', 'accepted']); assert.equal(finished.items[0].replayed, true);
  assert.equal((await f.state.read('quotes', quote.quote_id)).state, 'submitted');
  assert.ok([...f.keyTasks.values()].every(n => n === 1)); assert.equal(f.tasks.size, 2);
  f.delta = 0;
});

test(`seed ${SEED}: one batch quote prices each of 1-50 inputs and the total exactly, and approves only those inputs`, async t => {
  const f = await gateway(t), random = rng(SEED + 1), pick = list => list[Math.floor(random() * list.length)];
  const policy = id => ({ meta: meta(), model: rule(id) });
  for (const count of [1, 2, 10, MAX_BATCH_ITEMS]) for (const model of [SEEDREAM, 'gpt-image-2']) {
    f.reset();
    const inputs = Array.from({ length: count }, (_, i) => model === SEEDREAM
      ? { prompt: `seed ${SEED} ${count} ${i}`, ...(random() < 0.5 ? { n: 1 + Math.floor(random() * 4) } : {}), ...(random() < 0.5 ? { quality: pick(['2K', '4K']) } : {}) }
      : { prompt: `seed ${SEED} ${count} ${i}`, size: pick(['1:1', '16:9', '3:2']), quality: pick(['low', 'medium', 'high']), ...(random() < 0.3 ? { n: 2 } : {}) });
    const label = `${model} x${count}`;
    const entry = { id: model, kind: 'image', aliases: [], spec: findModelParams(model) };
    const expected = inputs.map(input => calculateRulesEstimate(policy(model), entry, input).amounts);
    const total = expected.reduce((sum, amounts) => sum + BigInt(amounts.uc), 0n);
    const view = await f.media.estimate({ model, inputs });
    assert.equal(view.batch.items, count, label); assert.deepEqual(view.inputs, inputs, label); assert.equal(view.input, undefined, label);
    assert.equal(view.items.length, count, label);
    view.items.forEach((item, i) => assert.deepEqual(item.amounts, expected[i], `${label} ${i}`));
    assert.equal(view.amounts.uc, String(total), label); assert.equal(view.pricing_quote.total_uc, String(total), label);
    assert.equal(view.pricing_quote.batch_items, count, label);
    assert.equal(view.estimate.status, model === SEEDREAM ? 'estimated' : 'token_billed', label);
    assert.equal(view.next_step, `After the user approves, run evolink generate image --quote ${view.quote_id} --confirm.`, label);
    const saved = await f.state.read('quotes', view.quote_id);
    assert.deepEqual(saved.args.inputs, inputs, label); assert.equal(saved.args.pricing_quote.batch_items, count, label);
  }
  assert.equal(f.posts.length, 0);
});

/** How the shared core reports a batch input the gateway answered with `tag`, before and after the cause is fixed. */
function expectedItem(tag, recovered) {
  if (tag === 'accept' || recovered && tag !== 'invalid') return { state: 'accepted' };
  if (tag === 'ratelimit') return { state: 'not_submitted', charged: 'no', finishable: true };
  if (tag === 'balance') return { state: 'rejected', charged: 'no', finishable: true };
  return { state: 'outcome_unknown', charged: 'unknown' };
}
const TAGS = ['accept', 'ratelimit', 'balance', 'invalid', 'lost'];

test(`seed ${SEED}: a batch submits its inputs together, reports each one, and the same request ID finishes it without a second task`, async t => {
  const f = await gateway(t), random = rng(SEED + 2);
  for (const [round, count] of [2, 7, 10, 23, 40, 50].entries()) {
    f.recovered = false; f.reset(); f.maxInFlight = 0;
    const tags = round === 0 ? ['accept', 'accept'] : Array.from({ length: count }, () => TAGS[Math.floor(random() * TAGS.length)]);
    const inputs = tags.map((tag, i) => ({ prompt: `seed ${SEED} round ${round} input ${i} [${tag}]` }));
    const quote = await f.media.estimate({ model: SEEDREAM, inputs });
    const { client_request_id: batchId } = await f.state.read('quotes', quote.quote_id);
    const tasks = f.tasks.size;
    const check = async (recovered, view) => {
      const label = `round ${round} ${recovered ? 'after' : 'before'}`;
      const want = tags.map(tag => expectedItem(tag, recovered));
      assert.equal(view.items.length, count, label);
      view.items.forEach((item, i) => {
        assert.equal(item.submission_state, want[i].state, `${label} ${i} ${tags[i]}`);
        assert.equal(item.client_request_id, `${batchId}.${String(i).padStart(2, '0')}`, `${label} ${i}`);
        if (want[i].charged) assert.equal(item.charged, want[i].charged, `${label} ${i}`);
        if (want[i].finishable !== undefined) assert.equal(item.finishable, want[i].finishable, `${label} ${i}`);
      });
      const accepted = want.filter(item => item.state === 'accepted').length, finishable = want.some(item => item.finishable || item.state === 'outcome_unknown');
      const saved = await f.state.read('quotes', quote.quote_id);
      assert.equal(saved.state, accepted === count ? 'submitted' : finishable ? 'partial' : accepted ? 'submitted' : 'refused', label);
      assert.equal(saved.task_ids.length, accepted, label); assert.deepEqual(view.task_ids, saved.task_ids, label);
      // The CLI names its own commands for collecting and finishing a batch, never the shared core's tool calls.
      assert.doesNotMatch(view.text, /call generate_|list_tasks \(task_ids|client_request_id and inputs|under a new client_request_id/, label);
      if (accepted) assert.match(view.text, new RegExp(`Collect the results with evolink tasks batch --ids ${saved.task_ids.join(',')};`), label);
      if (want.some(item => item.finishable)) assert.match(view.text, new RegExp(`To finish the batch, run evolink tasks resume --quote ${quote.quote_id} within 23 hours of its first submission`), label);
      if (want.some(item => item.state === 'outcome_unknown')) assert.match(view.text, new RegExp(`run evolink tasks resume --quote ${quote.quote_id} later`), label);
      assert.equal(view.recovery, saved.state === 'partial' ? `evolink tasks resume --quote ${quote.quote_id}` : undefined, label);
      return saved;
    };
    let view;
    try { view = await f.media.generate('image', quote.quote_id, { confirmed: true }); } catch (error) { view = error.details; assert.equal(error.details.items.length, count); }
    const saved = await check(false, view);
    assert.ok(f.maxInFlight <= 10, `${f.maxInFlight} in flight`);
    if (count >= 23) assert.ok(f.maxInFlight >= 5, `${f.maxInFlight} in flight`);
    if (saved.state === 'partial') {
      await assert.rejects(f.media.generate('image', quote.quote_id, { confirmed: true }),
        error => error.code === 'submission_already_started' && error.details.recovery === `evolink tasks resume --quote ${quote.quote_id}`);
      f.recovered = true;
      let resumed;
      try { resumed = await f.media.resume(quote.quote_id); } catch (error) { resumed = error.details; }
      await check(true, resumed);
      const replayed = resumed.items.filter((item, i) => item.submission_state === 'accepted' && (tags[i] === 'accept' || tags[i] === 'lost'));
      assert.ok(replayed.every(item => item.replayed === true), `round ${round}: accepted inputs replay`);
    }
    // At most one task per request ID, and one for each input the gateway ran.
    assert.ok([...f.keyTasks.values()].every(n => n === 1));
    assert.equal(f.tasks.size - tasks, tags.filter(tag => tag !== 'invalid').length, `round ${round}`);
    if ((await f.state.read('quotes', quote.quote_id)).state === 'submitted') {
      const posts = f.posts.length;
      const again = await f.media.generate('image', quote.quote_id, { confirmed: true });
      assert.equal(again.recovered, true); assert.equal(f.posts.length, posts);
    }
  }
});

test('an input whose request ID was used for another body is refused once, and the batch is not left to loop on it', async t => {
  const f = await gateway(t);
  const quote = await f.media.estimate({ model: SEEDREAM, inputs: [0, 1, 2].map(i => ({ prompt: `conflict ${i}` })) });
  const { client_request_id: batchId } = await f.state.read('quotes', quote.quote_id);
  f.ledger.set(`${batchId}.01`, { hash: 'another body', status: 200, value: { id: 'task-other' }, drops: 0 });
  const result = await f.media.generate('image', quote.quote_id, { confirmed: true });
  assert.deepEqual(result.items.map(item => item.submission_state), ['accepted', 'rejected', 'accepted']);
  assert.equal(result.items[1].error.code, 'idempotency_conflict'); assert.equal(result.items[1].finishable, false);
  assert.equal(result.items[1].error.retryable, false);
  assert.match(result.text, /inputs\[1\] differs from what this client_request_id submitted earlier/);
  assert.doesNotMatch(result.text, /To finish the batch/);
  assert.equal(result.recovery, undefined);
  // Nothing is left that the same request ID could finish: the batch is closed with its two tasks.
  const saved = await f.state.read('quotes', quote.quote_id);
  assert.equal(saved.state, 'submitted'); assert.equal(saved.task_ids.length, 2);
  const posts = f.posts.length;
  assert.equal((await f.media.generate('image', quote.quote_id, { confirmed: true })).recovered, true);
  assert.equal((await f.media.resume(quote.quote_id)).recovered, true);
  assert.equal(f.posts.length, posts);
});

test('a partly submitted batch keeps its accepted tasks when finishing it is refused before anything is sent', async t => {
  const f = await gateway(t);
  const quote = await f.media.estimate({ model: SEEDREAM, inputs: [{ prompt: 'kept [accept]' }, { prompt: 'later [ratelimit]' }] });
  await f.media.generate('image', quote.quote_id, { confirmed: true });
  assert.equal((await f.state.read('quotes', quote.quote_id)).state, 'partial');
  // The price moved before the resume: the approved batch cannot be finished; nothing is sent.
  f.delta = 1000; f.reset(); f.recovered = true;
  const posts = f.posts.length;
  await assert.rejects(f.media.resume(quote.quote_id), error => {
    assert.equal(error.code, 'price_changed'); assert.equal(error.details.error.code, 'price_changed'); assert.equal(error.details.charged, 'no');
    assert.match(error.message, /^The total price rose since the quote was approved, so nothing was sent\. Check evolink tasks batch --ids \S+ and evolink tasks list --since 2d first/);
    assert.deepEqual(error.details.items.map(item => item.submission_state), ['accepted', 'not_submitted']);
    assert.match(error.details.next_step, /Accepted inputs keep their tasks/);
    return true;
  });
  assert.equal(f.posts.length, posts);
  const saved = await f.state.read('quotes', quote.quote_id);
  assert.equal(saved.state, 'partial'); assert.equal(saved.task_ids.length, 1);
});

test('the CLI reads a batch from a JSON array or JSONL, refuses what it cannot hold, and submits a batch directly on request', async t => {
  const f = await gateway(t);
  const items = [0, 1, 2].map(i => ({ prompt: `file input ${i}` }));
  const array = await f.file('batch.json', JSON.stringify(items));
  const jsonl = await f.file('batch.jsonl', `${items.map(item => JSON.stringify(item)).join('\n')}\n\n`);
  for (const file of [array, jsonl]) {
    const quoted = await f.run(['estimate', '--model', SEEDREAM, '--inputs-file', file]);
    assert.equal(quoted.status, 0, JSON.stringify(quoted)); assert.equal(quoted.data.batch.items, 3); assert.deepEqual(quoted.data.inputs, items);
  }
  const one = await f.file('one.jsonl', JSON.stringify(items[0]));
  assert.equal((await f.run(['estimate', '--model', SEEDREAM, '--inputs-file', one])).data.batch.items, 1);
  const quoted = await f.run(['estimate', '--model', SEEDREAM, '--inputs-file', array]);
  const waited = await f.run(['generate', 'image', '--quote', quoted.data.quote_id, '--confirm', '--wait']);
  assert.notEqual(waited.status, 0); assert.equal(waited.data.error.code, 'invalid_option'); assert.equal(f.posts.length, 0);
  const generated = await f.run(['generate', 'image', '--quote', quoted.data.quote_id, '--confirm']);
  assert.equal(generated.status, 0, JSON.stringify(generated)); assert.equal(generated.data.task_ids.length, 3);
  assert.equal(generated.data.collect, `evolink tasks batch --ids ${generated.data.task_ids.join(',')}`);
  const resumed = await f.run(['tasks', 'resume', '--quote', quoted.data.quote_id]);
  assert.equal(resumed.status, 0); assert.equal(resumed.data.recovered, true); assert.equal(f.posts.length, 3);

  const tooMany = await f.file('many.jsonl', Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, i) => JSON.stringify({ prompt: `${i}` })).join('\n'));
  for (const args of [['--inputs-file', tooMany], ['--inputs-file', array, '--prompt', 'one'], ['--inputs-file', array, '--input', '{}'],
    ['--inputs-file', await f.file('bad.jsonl', '{"prompt":"a"}\nnot json')], ['--inputs-file', await f.file('scalars.json', '[1, 2]')]]) {
    const refused = await f.run(['estimate', '--model', SEEDREAM, ...args]);
    assert.notEqual(refused.status, 0, args.join(' ')); assert.equal(refused.data.error.code, 'invalid_input', args.join(' '));
  }
  assert.match((await f.run(['estimate', '--model', SEEDREAM, '--inputs-file', tooMany])).data.error.message, /1-50 inputs for one model; it has 51/);

  const direct = await f.run(['generate', 'image', '--model', SEEDREAM, '--inputs-file', array, '--skip-estimate']);
  assert.equal(direct.status, 0, JSON.stringify(direct)); assert.equal(direct.data.estimate_skipped, true); assert.equal(direct.data.task_ids.length, 3);
  const single = await f.run(['generate', 'image', '--model', SEEDREAM, '--input', JSON.stringify({ prompt: 'one direct image' }), '--skip-estimate']);
  assert.equal(single.status, 0, JSON.stringify(single)); assert.equal(single.data.estimate_skipped, true); assert.ok(single.data.task_id && single.data.quote_id);
  for (const args of [['--skip-estimate', '--quote', quoted.data.quote_id], ['--skip-estimate', '--confirm'], ['--inputs-file', array, '--skip-estimate', '--wait']]) {
    const refused = await f.run(['generate', 'image', '--model', SEEDREAM, ...(args.includes('--inputs-file') ? [] : ['--input', '{"prompt":"x"}']), ...args]);
    assert.notEqual(refused.status, 0, args.join(' ')); assert.equal(refused.data.error.code, 'invalid_option', args.join(' '));
  }
  const noSkip = await f.run(['generate', 'image', '--model', SEEDREAM, '--input', '{"prompt":"x"}']);
  assert.equal(noSkip.data.error.code, 'invalid_option'); assert.match(noSkip.data.error.message, /only for --skip-estimate/);
  const noQuote = await f.run(['generate', 'image']);
  assert.equal(noQuote.data.error.code, 'missing_quote'); assert.match(noQuote.data.error.message, /--skip-estimate only when the user explicitly said/);
  assert.equal(f.posts.length, 3 + 3 + 1);
});
