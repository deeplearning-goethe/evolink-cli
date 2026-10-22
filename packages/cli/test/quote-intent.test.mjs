// One generation per estimate: a refresh replaces its quote and keeps its request ID; only the current quote can be submitted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api } from '../src/api.mjs';
import { Credentials } from '../src/auth.mjs';
import { Media } from '../src/media.mjs';
import { State } from '../src/state.mjs';
import { resetPricingRulesCacheForTests } from '../src/platform/core/src/services/pricing-rules-client.js';
import { fixture, MemoryVault } from './fixture.mjs';

const bin = process.env.EVOLINK_CLI_TEST_BIN || fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
const token = 'fixture-quote-intent-token';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const input = prompt => ({ model: 'fixture-image', input: { prompt } });
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const sent = (f, requestId) => f.calls.filter(call => call.name.startsWith('generate_') && (!requestId || call.args.client_request_id === requestId)).length;

async function context(t) {
  const f = await fixture(); t.after(f.close); f.mcpUnavailable = true;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-quote-intent-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { f, home, ...session(f, home) };
}
/** Another command on the same home, with its own client, as a separate process would be. */
function session(f, home) {
  const state = new State(home);
  const credentials = new Credentials({ state, server: f.server, vault: new MemoryVault(), token });
  return { state, media: new Media({ client: new Api(credentials), state, server: f.server }) };
}
async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) { assert.ok(Date.now() < until, 'timed out waiting for the race window'); await delay(10); }
}
/** Holds the first pricing-rule read until opened; later estimates make their own reads and answer at once. */
function holdFirstEstimate(f) {
  let open, reads = 0;
  const opened = new Promise(resolve => { open = resolve; });
  f.beforeRules = async () => { if (++reads === 1) { resetPricingRulesCacheForTests(); await opened; } };
  return { open, held: () => reads >= 1 };
}
async function quoteFiles(home) {
  return (await fs.readdir(path.join(home, 'quotes'))).filter(name => name.endsWith('.json')).sort();
}
async function cli(f, home, args) {
  const child = spawn(process.execPath, [bin, ...args, '--server', f.server.href, '--json', '--token-stdin'],
    { env: { ...process.env, EVOLINK_CLI_HOME: home, EVOLINK_CLI_UPDATE_CHECK: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(token);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.ok(stdout.trim(), stderr);
  return { code, view: JSON.parse(stdout.trim().split('\n').at(-1)) };
}

test('a refresh replaces the quote: the old one cannot be submitted, the request ID stays, and one task is created', async t => {
  const { f, state, media } = await context(t);
  const q1 = await media.estimate(input('replace on refresh'));
  const requestId = (await state.read('quotes', q1.quote_id)).client_request_id;
  const q2 = await media.refresh(q1.quote_id);
  assert.notEqual(q2.quote_id, q1.quote_id); assert.equal(q2.superseded_quote_id, q1.quote_id);
  assert.equal(q2.client_request_id, requestId, 'one generation keeps one request ID');
  assert.equal(q2.requires_confirmation, true);
  const old = await state.read('quotes', q1.quote_id);
  assert.equal(old.state, 'superseded'); assert.equal(old.superseded_by, q2.quote_id);
  assert.equal((await state.read('intents', q1.quote_id)).active_quote_id, q2.quote_id);
  for (const attempt of [() => media.generate('image', q1.quote_id, { confirmed: true }), () => media.resume(q1.quote_id)]) {
    await assert.rejects(attempt(), error => error.code === 'quote_superseded' && error.details.active_quote_id === q2.quote_id
      && error.details.submission_allowed === false && error.details.next_step.includes(`--quote ${q2.quote_id}`));
  }
  assert.equal(sent(f), 0);
  const done = await media.generate('image', q2.quote_id, { confirmed: true });
  assert.equal(done.client_request_id, requestId); assert.equal(sent(f), 1);
  // Once submitted, the replaced quote names the task, and no refresh asks for another estimate.
  await assert.rejects(media.generate('image', q1.quote_id, { confirmed: true }), error => error.code === 'quote_superseded'
    && error.details.task_id === done.task_id && error.details.recovery === `evolink tasks get ${done.task_id}`);
  const reads = f.ruleReads;
  for (const id of [q1.quote_id, q2.quote_id]) {
    await assert.rejects(media.refresh(id), error => error.code === 'submission_already_started' && error.details.task_id === done.task_id);
  }
  assert.equal(f.ruleReads, reads, 'a submitted generation is not estimated again');
  assert.equal(sent(f), 1); assert.equal(f.paid.size, 1);
});

test('a submission that finishes while a refresh waits for its estimate wins: no second quote is saved', async t => {
  const { f, home, state, media } = await context(t);
  const q1 = await media.estimate(input('refresh races a submission'));
  const hold = holdFirstEstimate(f);
  const refresh = settle(media.refresh(q1.quote_id));
  await waitFor(hold.held);
  const done = await session(f, home).media.generate('image', q1.quote_id, { confirmed: true });
  hold.open();
  const { value, error } = await refresh;
  assert.equal(value, undefined, 'the refresh saved no quote');
  assert.equal(error.code, 'submission_already_started'); assert.equal(error.details.task_id, done.task_id);
  assert.deepEqual(await quoteFiles(home), [`${q1.quote_id}.json`]);
  assert.equal(await state.read('intents', q1.quote_id), undefined);
  assert.equal(sent(f), 1);
});

test('a refresh during the current quote\'s submission waits for its lock and is refused; no second branch appears', async t => {
  const { f, home, state, media } = await context(t);
  const q1 = await media.estimate(input('submission holds the lock'));
  const q2 = await media.refresh(q1.quote_id);
  // The submission's own fresh estimate is held, inside the generation's lock.
  const hold = holdFirstEstimate(f);
  const submission = media.generate('image', q2.quote_id, { confirmed: true });
  await waitFor(hold.held);
  const refresh = settle(session(f, home).media.refresh(q1.quote_id));
  await delay(300);
  hold.open();
  const done = await submission;
  const { value, error } = await refresh;
  assert.equal(value, undefined, 'the refresh saved no quote');
  assert.equal(error.code, 'submission_already_started'); assert.equal(error.details.task_id, done.task_id);
  assert.equal((await state.read('intents', q1.quote_id)).active_quote_id, q2.quote_id);
  assert.equal(sent(f), 1);
});

test('two refreshes at once: one replaces the quote, the other names the current quote and saves nothing', async t => {
  const { f, home, state, media } = await context(t);
  const q1 = await media.estimate(input('double refresh'));
  const hold = holdFirstEstimate(f);
  const first = settle(media.refresh(q1.quote_id));
  await waitFor(hold.held);
  const second = settle(session(f, home).media.refresh(q1.quote_id));
  await delay(300); // the second refresh finishes while the first still waits for its estimate
  hold.open();
  const results = await Promise.all([first, second]);
  const won = results.filter(result => result.value).map(result => result.value);
  const lost = results.filter(result => result.error).map(result => result.error);
  assert.equal(won.length, 1); assert.equal(lost.length, 1);
  assert.equal(lost[0].code, 'quote_refresh_conflict'); assert.equal(lost[0].details.active_quote_id, won[0].quote_id);
  assert.equal((await state.read('intents', q1.quote_id)).active_quote_id, won[0].quote_id);
  assert.deepEqual(await quoteFiles(home), [q1.quote_id, won[0].quote_id].map(id => `${id}.json`).sort(), 'only the winner was saved');
  await media.generate('image', won[0].quote_id, { confirmed: true });
  assert.equal(sent(f), 1);
});

test('separate CLI processes: a refresh and a submission at once leave at most one paid branch', async t => {
  const { f, home, state, media } = await context(t);
  for (let round = 0; round < 3; round++) {
    const q = await media.estimate(input(`processes ${round}`));
    const requestId = (await state.read('quotes', q.quote_id)).client_request_id;
    f.beforeRules = () => delay(300); // every estimate takes a while, so the two commands overlap
    const [refresh, submit] = await Promise.all([cli(f, home, ['estimate', '--refresh-quote', q.quote_id]),
      cli(f, home, ['generate', 'image', '--quote', q.quote_id, '--confirm'])]);
    f.beforeRules = undefined;
    assert.ok(!(refresh.code === 0 && submit.code === 0), 'a refresh and a submission of one generation cannot both succeed');
    assert.ok(sent(f, requestId) <= 1);
    const intent = await state.read('intents', q.quote_id);
    const active = await state.read('quotes', intent?.active_quote_id ?? q.quote_id);
    if (submit.code === 0) {
      assert.equal(sent(f, requestId), 1); assert.equal(active.state, 'submitted');
      assert.equal(refresh.view.error.code, 'submission_already_started');
    } else {
      assert.equal(sent(f, requestId), 0); assert.equal(active.state, 'quoted');
      assert.ok(['quote_superseded', 'operation_busy'].includes(submit.view.error.code), JSON.stringify(submit.view.error));
      if (refresh.code === 0) assert.equal(active.id, refresh.view.quote_id);
    }
  }
});

test('crash orderings: a refreshed quote saved before its pointer is not submittable, and the pointer alone decides', async t => {
  const { f, state, media } = await context(t);
  // Stopped after saving the refreshed quote, before moving the pointer: only the original can be submitted.
  const q1 = await media.estimate(input('crash before the pointer'));
  const original = await state.read('quotes', q1.quote_id);
  const orphan = { ...original, id: 'orphan-quote-20261022', intent_id: q1.quote_id, refreshed_from: q1.quote_id };
  await state.write('quotes', orphan.id, orphan);
  await assert.rejects(media.generate('image', orphan.id, { confirmed: true }), error => error.code === 'quote_refresh_incomplete'
    && error.details.active_quote_id === q1.quote_id);
  assert.equal(sent(f), 0);
  assert.equal((await media.generate('image', q1.quote_id, { confirmed: true })).client_request_id, original.client_request_id);
  // Stopped after moving the pointer, before marking the replaced quote: the pointer still decides.
  const q3 = await media.estimate(input('crash before the mark'));
  const third = await state.read('quotes', q3.quote_id);
  const next = { ...third, id: 'pointed-quote-20261022', intent_id: q3.quote_id, refreshed_from: q3.quote_id };
  await state.write('quotes', next.id, next);
  await state.write('intents', q3.quote_id, { id: q3.quote_id, client_request_id: third.client_request_id, active_quote_id: next.id, quotes: [q3.quote_id, next.id] });
  assert.equal((await state.read('quotes', q3.quote_id)).state, 'quoted');
  await assert.rejects(media.generate('image', q3.quote_id, { confirmed: true }), { code: 'quote_superseded' });
  assert.equal((await media.generate('image', next.id, { confirmed: true })).client_request_id, third.client_request_id);
  assert.equal(sent(f), 2);
});

test('an unverified submission of the current quote resumes with the original request ID; the replaced quote points to it', async t => {
  const { f, state, media } = await context(t);
  const q1 = await media.estimate(input('resume after refresh'));
  const requestId = (await state.read('quotes', q1.quote_id)).client_request_id;
  const q2 = await media.refresh(q1.quote_id);
  // The core retries a lost paid request once with the same request ID; losing both leaves the outcome unknown.
  f.loseRestSubmissions = 2;
  await assert.rejects(media.generate('image', q2.quote_id, { confirmed: true }));
  assert.equal((await state.read('quotes', q2.quote_id)).state, 'outcome_unknown');
  await assert.rejects(media.generate('image', q1.quote_id, { confirmed: true }), error => error.code === 'quote_superseded'
    && error.details.recovery === `evolink tasks resume --quote ${q2.quote_id}`);
  await assert.rejects(media.refresh(q1.quote_id), error => error.code === 'submission_already_started'
    && error.details.recovery === `evolink tasks resume --quote ${q2.quote_id}`);
  const recovered = await media.resume(q2.quote_id);
  assert.equal(recovered.client_request_id, requestId);
  assert.equal(f.paid.size, 1, 'the replay found the one task of the original request ID');
});

test('a price change after a refresh needs another refresh; each one replaces the quote and keeps the request ID', async t => {
  const { f, state, media } = await context(t);
  const q1 = await media.estimate(input('price changes after a refresh'));
  const requestId = (await state.read('quotes', q1.quote_id)).client_request_id;
  const q2 = await media.refresh(q1.quote_id);
  f.multiplier = 2;
  await assert.rejects(media.generate('image', q2.quote_id, { confirmed: true }), { code: 'price_changed' });
  assert.equal((await state.read('quotes', q2.quote_id)).state, 'quoted');
  const q3 = await media.refresh(q2.quote_id);
  assert.equal(q3.superseded_quote_id, q2.quote_id); assert.equal(q3.client_request_id, requestId);
  assert.deepEqual((await state.read('intents', q1.quote_id)).quotes, [q1.quote_id, q2.quote_id, q3.quote_id]);
  for (const id of [q1.quote_id, q2.quote_id]) await assert.rejects(media.generate('image', id, { confirmed: true }), { code: 'quote_superseded' });
  assert.equal((await media.generate('image', q3.quote_id, { confirmed: true })).client_request_id, requestId);
  assert.equal(sent(f), 1);
});

test('seed 20261022: random refreshes, submissions and recoveries across sessions never leave two paid branches', async t => {
  const { f, home, state, media } = await context(t);
  let seed = 20261022;
  const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  f.beforeRules = () => delay(next(120));
  f.beforeSubmit = () => delay(next(120));
  const allowed = new Set(['quote_superseded', 'quote_refresh_conflict', 'submission_already_started', 'submission_not_started']);
  for (let round = 0; round < 12; round++) {
    const q = await media.estimate(input(`seeded ${round}`));
    const requestId = (await state.read('quotes', q.quote_id)).client_request_id;
    const known = [q.quote_id];
    const operations = Array.from({ length: 2 + next(4) }, () => ['refresh', 'generate', 'resume'][next(3)]);
    const results = await Promise.all(operations.map(async operation => {
      await delay(next(80));
      const { media: other } = session(f, home);
      const id = known[next(known.length)];
      const outcome = await settle(operation === 'refresh' ? other.refresh(id)
        : operation === 'generate' ? other.generate('image', id, { confirmed: true }) : other.resume(id));
      if (operation === 'refresh' && outcome.value) known.push(outcome.value.quote_id);
      return { operation, ...outcome };
    }));
    const trace = JSON.stringify({ round, operations, results: results.map(result => result.error?.code ?? (result.value.recovered ? 'recovered' : 'ok')) });
    for (const { error } of results) assert.ok(!error || allowed.has(error.code), `${error?.code}: ${error?.message} ${trace}`);
    // A recovery of an already submitted quote reads its task and carries no request ID.
    for (const { value } of results) if (value && !value.recovered) assert.equal(value.client_request_id, requestId, trace);
    assert.ok(sent(f, requestId) <= 1, trace);
    const intent = await state.read('intents', q.quote_id);
    const activeId = intent?.active_quote_id ?? q.quote_id;
    const active = await state.read('quotes', activeId);
    assert.equal(active.state, sent(f, requestId) ? 'submitted' : 'quoted', trace);
    // Every other quote of this generation is closed: it can only name the current quote or its task.
    for (const id of known.filter(id => id !== activeId)) {
      await assert.rejects(media.generate('image', id, { confirmed: true }), { code: 'quote_superseded' }, trace);
    }
    assert.ok(sent(f, requestId) <= 1, trace);
  }
});
