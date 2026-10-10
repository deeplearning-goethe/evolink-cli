import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Api } from '../src/api.mjs';
import { Credentials } from '../src/auth.mjs';
import { Media, priceFingerprint } from '../src/media.mjs';
import { State } from '../src/state.mjs';
import { dispatch, validateCommand } from '../src/cli.mjs';
import { fixture, MemoryVault } from './fixture.mjs';

async function context(t) {
  const f = await fixture(); t.after(f.close); f.mcpUnavailable = true;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-account-quote-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const state = new State(home), credentials = new Credentials({ state, server: f.server, vault: new MemoryVault(), token: 'fixture-account-quote' });
  const client = new Api(credentials), media = new Media({ client, state, server: f.server });
  return { f, state, credentials, client, media, server: f.server };
}

test('account quote saves backend identity and expiry, refreshes before submit, and keeps the user budget', async t => {
  const { f, state, media } = await context(t);
  const q = await media.estimate({ model: 'fixture-image', input: { prompt: 'approved image', n: 2 }, max_cost_usd: 0.05, pricing_source: 'account' });
  assert.equal(q.pricing_scope, 'account'); assert.equal(q.final_budget_enforced, false);
  const saved = await state.read('quotes', q.quote_id);
  assert.equal(saved.backend_estimate_id, q.estimate_id);
  assert.equal(saved.expires_at, Date.parse(q.account_quote.quote.expires_at));
  assert.equal(saved.args.max_cost_usd, 0.05); assert.equal(saved.account_quote.quote.amounts.uc, '27200');
  const result = await media.generate('image', q.quote_id, { confirmed: true });
  const submitted = await state.read('quotes', q.quote_id);
  assert.notEqual(submitted.backend_estimate_id, saved.backend_estimate_id);
  assert.equal(submitted.args.max_cost_usd, 0.05); assert.equal(result.final_budget_enforced, false);
  assert.equal(f.quoteRequests.length, 2); assert.equal(f.paid.size, 1);
});

test('explicit refresh preserves input and budget, changes local identity, and needs new approval', async t => {
  const c = await context(t);
  const q = await c.media.estimate({ model: 'fixture-image', input: { prompt: 'same input' }, max_cost_usd: 0.05 });
  c.f.multiplier = 2;
  const fresh = await dispatch(['estimate'], { 'refresh-quote': q.quote_id }, c);
  assert.equal(fresh.refreshed_from, q.quote_id); assert.notEqual(fresh.quote_id, q.quote_id);
  assert.deepEqual(fresh.input, q.input); assert.equal(fresh.max_cost_usd, 0.05); assert.equal(fresh.requires_confirmation, true);
  await assert.rejects(c.media.generate('image', fresh.quote_id), { code: 'confirmation_required' });
  assert.equal(c.f.paid.size, 0);
  await assert.rejects(dispatch(['estimate'], { 'refresh-quote': q.quote_id, model: 'changed' }, c), { code: 'invalid_option' });
});

test('backend errors and price/version changes stop submission without replacing the user budget', async t => {
  const { f, media, state } = await context(t);
  const q = await media.estimate({ model: 'fixture-image', input: { prompt: 'approved' }, max_cost_usd: 0.05 });
  f.quoteFailure = 503;
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), error => error.details.max_cost_usd === 0.05 && error.details.submission_allowed === false);
  assert.equal((await state.read('quotes', q.quote_id)).state, 'quoted'); assert.equal(f.paid.size, 0);
  f.quoteFailure = undefined; f.multiplier = 2;
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), { code: 'price_changed' });
  assert.equal(f.paid.size, 0);
});

test('public reference previews cannot create an approved submission record', async t => {
  const { f, media } = await context(t);
  const q = await media.estimate({ model: 'fixture-image', input: { prompt: 'preview' }, pricing_source: 'public_reference' });
  assert.equal(q.quote_id, undefined); assert.equal(q.submission_allowed, false); assert.equal(q.requires_confirmation, false);
  assert.equal(f.quoteRequests?.length || 0, 0); assert.equal(f.paid.size, 0);
});

test('unknown outcomes retain the exact backend quote and request ID, with no new account quote', async t => {
  const { f, media, state } = await context(t);
  const q = await media.estimate({ model: 'fixture-image', input: { prompt: 'one request' } });
  f.loseRestSubmissions = 2;
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }));
  const unknown = await state.read('quotes', q.quote_id), quoteCount = f.quoteRequests.length;
  assert.equal(unknown.state, 'outcome_unknown');
  const recovered = await media.resume(q.quote_id);
  const saved = await state.read('quotes', q.quote_id);
  assert.equal(recovered.task_id, f.paid.get(unknown.client_request_id));
  assert.deepEqual(saved.args, unknown.args); assert.equal(saved.backend_estimate_id, unknown.backend_estimate_id);
  assert.equal(f.quoteRequests.length, quoteCount); assert.equal(f.paid.size, 1);
  await assert.rejects(media.refresh(q.quote_id), { code: 'submission_already_started' });
});

test('quote approval compares account pricing and inputs but ignores new estimate IDs and expiry', () => {
  const q = { model: 'test', pricing_scope: 'account', estimate: { status: 'estimated', max_usd: 0.02 },
    account_quote: { request_hash: 'a', parameters: { duration_seconds: 5 }, quote: { amount: '0.02', estimate_id: 'old', expires_at: 'old', policy_checksum: 'a' } } };
  assert.equal(priceFingerprint(q), priceFingerprint({ ...q, account_quote: { ...q.account_quote, quote: { ...q.account_quote.quote, estimate_id: 'new', expires_at: 'new' } } }));
  for (const changed of [{ policy_checksum: 'b' }, { amount: '0.03' }]) assert.notEqual(priceFingerprint(q), priceFingerprint({ ...q, account_quote: { ...q.account_quote, quote: { ...q.account_quote.quote, ...changed } } }));
  assert.doesNotThrow(() => validateCommand(['estimate'], { 'refresh-quote': 'saved' }));
});
