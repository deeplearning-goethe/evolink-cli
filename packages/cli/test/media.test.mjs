import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Media, checkEstimate } from '../src/media.mjs';
import { State } from '../src/state.mjs';
import { fakeMcp } from './fixture.mjs';
import { validateCommand } from '../src/cli.mjs';

async function context(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-media-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const state = new State(home); const data = { calls: [] }; const mcp = fakeMcp(data);
  const media = new Media({ mcp, state, server: new URL('http://127.0.0.1:9999/mcp') });
  return { state, data, mcp, media };
}

test('generation requires approval and preserves the quoted model and input', async t => {
  const { state, data, media } = await context(t);
  const input = { prompt: 'blue sailboat', quality: 'high', n: 2, references: ['https://example.com/a.png'] };
  const quote = await media.estimate({ model: 'image', input, max_cost_usd: 0.03 });
  await assert.rejects(media.generate('image', quote.quote_id), { code: 'confirmation_required' });
  assert.equal(data.calls.filter(c => c.name === 'generate_image').length, 0);
  const result = await media.generate('image', quote.quote_id, { confirmed: true });
  const paid = data.calls.find(c => c.name === 'generate_image').args;
  assert.deepEqual(paid.input, input); assert.equal(paid.model, 'image'); assert.equal(paid.max_cost_usd, 0.03);
  assert.equal(paid.client_request_id, (await state.read('quotes', quote.quote_id)).client_request_id);
  assert.equal(result.task_id, 'fixture-task');
  await media.generate('image', quote.quote_id, { confirmed: true });
  assert.equal(data.calls.filter(c => c.name === 'generate_image').length, 1);
});

test('quote changes, expiry, type and login changes prevent paid submission', async t => {
  const { state, data, mcp, media } = await context(t);
  const q = await media.estimate({ model: 'image', input: { prompt: 'test' } });
  data.cost = 0.025;
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), { code: 'price_changed' });
  data.cost = 0.015;
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), { code: 'price_changed' });
  data.cost = undefined;
  await assert.rejects(media.generate('video', q.quote_id, { confirmed: true }), { code: 'quote_type_mismatch' });
  let saved = await state.read('quotes', q.quote_id); saved.expires_at = 0; await state.write('quotes', q.quote_id, saved);
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), { code: 'quote_expired' });
  saved.expires_at = Date.now() + 10_000; saved.args.input.prompt = 'different'; await state.write('quotes', q.quote_id, saved);
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), { code: 'quote_changed' });
  saved.args.input.prompt = 'test'; await state.write('quotes', q.quote_id, saved);
  saved.args.max_cost_usd = 1; await state.write('quotes', q.quote_id, saved);
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), { code: 'quote_changed' });
  saved.args.max_cost_usd = 0.02; await state.write('quotes', q.quote_id, saved);
  mcp.credentials.access = async () => ({ binding: 'another-session' });
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), { code: 'quote_session_changed' });
  assert.equal(data.calls.filter(c => c.name.startsWith('generate_')).length, 0);
});

test('unknown outcomes recover with one request ID and retain a pre-submit journal', async t => {
  const { state, data, media } = await context(t);
  const q = await media.estimate({ model: 'image', input: { prompt: 'one task' } });
  data.failure = true;
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), { code: 'connection_failed' });
  const first = data.calls.find(c => c.name === 'generate_image').args;
  assert.equal((await state.read('quotes', q.quote_id)).state, 'outcome_unknown');
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), { code: 'submission_already_started' });
  data.failure = false;
  await media.resume(q.quote_id);
  const last = data.calls.filter(c => c.name === 'generate_image').at(-1).args;
  assert.deepEqual(last, first);
});

test('concurrent submissions resolve one task', async t => {
  const { data, media } = await context(t);
  const q = await media.estimate({ model: 'image', input: { prompt: 'same' } });
  const results = await Promise.all([media.generate('image', q.quote_id, { confirmed: true }), media.generate('image', q.quote_id, { confirmed: true })]);
  assert.equal(data.calls.filter(c => c.name === 'generate_image').length, 1);
  assert.equal(results[0].task_id, results[1].task_id);
});

test('caps, billing statuses, validity and balances: seeded cross combinations', () => {
  let seed = 20261008;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  let cases = 0;
  for (const status of ['estimated', 'partial', 'token_billed', 'uncheckable']) {
    for (const valid of [true, false]) for (const enough of [true, false]) {
      for (let i = 0; i < 20; i++) {
        const price = Math.round(random() * 10000) / 100;
        const cap = price + (i % 2 ? 0.01 : -0.01);
        const view = { input_valid: valid, enough_balance: enough, estimate: { status, max_usd: price } };
        const allowed = status === 'estimated' && valid && enough && cap > 0 && price <= cap;
        if (allowed) assert.doesNotThrow(() => checkEstimate(view, cap));
        else assert.throws(() => checkEstimate(view, cap));
        cases++;
      }
    }
  }
  assert.equal(cases, 320);
  for (const cap of [NaN, Infinity, 0, -1, 10001]) assert.throws(() => checkEstimate({ estimate: { status: 'estimated', max_usd: 0.02 } }, cap));
  for (const field of ['enough_balance', 'enough_limit', 'enough_daily_limit']) assert.throws(() => checkEstimate({ [field]: false, estimate: { status: 'estimated', max_usd: 0.02 } }, 1));
  assert.throws(() => checkEstimate({ estimate: { status: 'estimated' } }, 1));
  for (const status of ['no_price', 'needs_input', undefined, 'other']) assert.throws(() => checkEstimate({ estimate: { status } }));
  assert.doesNotThrow(() => checkEstimate({ input_valid: null, estimate: { status: 'token_billed' } }));
});

test('a complete quote automatically forwards its maximum as a submission guard', async t => {
  const { data, media } = await context(t);
  const q = await media.estimate({ model: 'image', input: { prompt: 'price guard' } });
  assert.equal(q.max_cost_usd, 0.02); assert.equal(q.cap_source, 'quote');
  await media.generate('image', q.quote_id, { confirmed: true });
  assert.equal(data.calls.find(c => c.name === 'generate_image').args.max_cost_usd, 0.02);
});

test('invalid command options fail before any task is submitted', () => {
  assert.throws(() => validateCommand(['generate', 'image'], { quote: 'q', confirm: true, wait: true, timeout: 'NaN' }));
  assert.throws(() => validateCommand(['generate', 'image'], { quote: 'q', confirm: true, model: 'changed' }));
  assert.throws(() => validateCommand(['balance'], { confirm: true }));
  assert.throws(() => validateCommand(['tasks', 'get', 'id', 'extra'], {}));
});


test('charged=no without verified submission evidence cannot refuse recovery', async t => {
  const { media, mcp, state } = await context(t);
  const quote = await media.estimate({ model: 'image', input: { prompt: 'test' } });
  const original = mcp.call.bind(mcp);
  mcp.call = async (name, args) => {
    if (name.startsWith('generate_')) throw Object.assign(new Error('ambiguous rejection'), { details: { charged: 'no' } });
    return original(name, args);
  };
  await assert.rejects(media.generate('image', quote.quote_id, { confirmed: true }), error => error.details.charged === 'unknown');
  assert.equal((await state.read('quotes', quote.quote_id)).state, 'outcome_unknown');
});
