import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Media } from '../src/media.mjs';
import { State } from '../src/state.mjs';
import { APPROVAL_TTL_MS } from '../src/platform/core/src/services/pricing-rules-estimate.js';

const minute = 60_000;

async function context(t, kind, source, serverMinutes, budget, seed) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-quote-expiry-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const start = Date.parse('2026-10-15T00:00:00Z') + seed % 1000;
  let now = start, usd = 0.02, rules = 'b', request = 'a';
  const state = new State(home);
  const submissions = [];
  // Each estimate is current from the moment it is made, at the price, rules and input reading of that moment.
  const quote = () => ({
    ok: true, _binding: 'expiry-test', model: `fixture-${kind}`, type: kind, input_valid: true,
    estimate: { status: 'estimated', min_usd: usd, max_usd: usd },
    ...(source === 'rules' ? { pricing_quote: { source: 'pricing_rules', model_id: `fixture-${kind}`, request_hash: request.repeat(64),
      fingerprint: rules.repeat(64), total_uc: String(Math.round(usd * 680_000)), expires_at: new Date(now + serverMinutes * minute).toISOString() } } : {}),
    ...(source === 'account' ? { account_quote: { request_hash: request.repeat(64), parameters: {},
      quote: { amount: String(usd), policy_checksum: rules.repeat(64), expires_at: new Date(now + serverMinutes * minute).toISOString() } } } : {}),
  });
  const client = {
    credentials: { access: async () => ({ binding: 'expiry-test' }) },
    async call(name, args) {
      if (name === 'estimate_cost') return quote();
      assert.equal(name, `generate_${kind}`);
      submissions.push(args);
      return { ok: true, task_id: `fixture-task-${seed}` };
    },
  };
  const media = new Media({ client, state, server: new URL('https://mcp.evolink.ai/mcp'), now: () => now });
  const result = await media.estimate({ model: `fixture-${kind}`, input: { prompt: `expiry-${seed}` },
    ...(budget === undefined ? {} : { max_cost_usd: budget }) });
  return { media, state, result, start, submissions, advance: elapsed => { now = start + elapsed; }, setPrice: value => { usd = value; },
    setRules: value => { rules = value; }, setRequest: value => { request = value; } };
}

test('seed 20261015: saved quotes use the core approval window without extending a shorter server approval', async t => {
  let seed = 20261015, cases = 0;
  for (const kind of ['image', 'video', 'audio']) for (const source of ['rules', 'account', 'legacy']) {
    for (const serverMinutes of source === 'legacy' ? [undefined] : [10, 30, 45, 48 * 60]) for (const budget of [undefined, 0.05]) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const c = await context(t, kind, source, serverMinutes, budget, seed);
      const saved = await c.state.read('quotes', c.result.quote_id);
      const expected = c.start + Math.min(APPROVAL_TTL_MS, (serverMinutes ?? Infinity) * minute);
      assert.equal(saved.expires_at, expected, `${kind}/${source}/${serverMinutes}`);
      assert.equal(Date.parse(c.result.expires_at), expected);
      assert.equal(saved.args.max_cost_usd, budget);
      assert.equal(c.result.requires_confirmation, true);
      assert.equal(c.submissions.length, 0);
      cases++;
    }
  }
  assert.equal(cases, 54);
});

test('seed 20261015: a quote submits before its expiry; at the expiry instant and later it is refused and stays unsubmitted', async t => {
  let seed = 20261015, cases = 0;
  for (const kind of ['image', 'video', 'audio']) for (const source of ['rules', 'account', 'legacy']) {
    // A server approval of 30 minutes bounds the saved quote; without one the core's window does.
    const ttl = source === 'legacy' ? APPROVAL_TTL_MS : 30 * minute;
    for (const budget of [undefined, 0.05]) for (const elapsed of [Math.floor(ttl / 2), ttl - 1, ttl, ttl + 1, ttl + 3 * 86_400_000]) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const c = await context(t, kind, source, 30, budget, seed), label = `${kind}/${source}/${elapsed}`;
      c.advance(elapsed);
      await assert.rejects(c.media.generate(kind, c.result.quote_id), { code: 'confirmation_required' });
      const saved = () => c.state.read('quotes', c.result.quote_id);
      if (elapsed < ttl) {
        const result = await c.media.generate(kind, c.result.quote_id, { confirmed: true });
        assert.equal(c.submissions.length, 1, label); assert.equal(c.submissions[0].max_cost_usd, budget, label);
        assert.equal(result.approval_expired, undefined, label);
        assert.equal((await saved()).state, 'submitted', label);
      } else {
        await assert.rejects(c.media.generate(kind, c.result.quote_id, { confirmed: true }), error => error.code === 'quote_expired'
          && error.message === `This quote expired at ${new Date(c.start + ttl).toISOString()}. Refresh it with evolink estimate --refresh-quote ${c.result.quote_id} and obtain the user's approval again. Nothing was submitted.`
          && error.details.next_step === `evolink estimate --refresh-quote ${c.result.quote_id}` && error.details.submission_allowed === false, label);
        assert.equal(c.submissions.length, 0, label);
        assert.equal((await saved()).state, 'quoted', label);
      }
      cases++;
    }
  }
  assert.equal(cases, 90);
});

test('seed 20261015: a quote whose price rose is refused before its expiry (price_changed) and after it (quote_expired), unsubmitted', async t => {
  let seed = 20261015, cases = 0;
  for (const kind of ['image', 'video', 'audio']) for (const source of ['rules', 'account', 'legacy']) for (const elapsed of [10 * minute, APPROVAL_TTL_MS + 1]) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const c = await context(t, kind, source, 30, undefined, seed);
    c.advance(elapsed); c.setPrice(0.03);
    await assert.rejects(c.media.generate(kind, c.result.quote_id, { confirmed: true }), { code: elapsed < 30 * minute ? 'price_changed' : 'quote_expired' });
    assert.equal(c.submissions.length, 0);
    assert.equal((await c.state.read('quotes', c.result.quote_id)).state, 'quoted');
    cases++;
  }
  assert.equal(cases, 18);
});

test('seed 20261015: before its expiry a lower or unchanged price submits, also under other rules; a changed input does not', async t => {
  let seed = 20261015, cases = 0;
  for (const kind of ['image', 'video', 'audio']) for (const source of ['rules', 'account', 'legacy']) {
    for (const change of ['lower', 'same', 'other-rules', 'other-rules-lower', 'other-input']) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const c = await context(t, kind, source, 30, undefined, seed), label = `${kind}/${source}/${change}`;
      c.advance(10 * minute);
      if (change.endsWith('lower')) c.setPrice(0.015);
      if (change.startsWith('other-rules')) c.setRules('c');
      if (change === 'other-input') c.setRequest('d');
      // An approval record holds at its price or lower; without one (an older service) any change needs a new approval.
      const want = change === 'other-input' && source !== 'legacy' ? 'quote_input_changed'
        : source === 'legacy' && change.endsWith('lower') ? 'price_changed' : undefined;
      if (want) {
        await assert.rejects(c.media.generate(kind, c.result.quote_id, { confirmed: true }), { code: want }, label);
        assert.equal(c.submissions.length, 0, label);
      } else {
        await c.media.generate(kind, c.result.quote_id, { confirmed: true });
        assert.equal(c.submissions.length, 1, label);
        // The submission carries the fresh approval record, at the price of the moment.
        if (source === 'rules') assert.equal(c.submissions[0].pricing_quote.total_uc, String(Math.round((change.endsWith('lower') ? 0.015 : 0.02) * 680_000)), label);
      }
      cases++;
    }
  }
  assert.equal(cases, 45);
});
