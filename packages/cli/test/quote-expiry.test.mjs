import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Media } from '../src/media.mjs';
import { State } from '../src/state.mjs';

const minute = 60_000;

async function context(t, kind, source, serverMinutes, budget, seed) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-quote-expiry-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const start = Date.parse('2026-10-15T00:00:00Z') + seed % 1000;
  let now = start;
  const state = new State(home);
  const submissions = [];
  const quote = {
    ok: true, _binding: 'expiry-test', model: `fixture-${kind}`, type: kind, input_valid: true,
    estimate: { status: 'estimated', min_usd: 0.02, max_usd: 0.02 },
    ...(source === 'rules' ? { pricing_quote: { source: 'pricing_rules', request_hash: 'a'.repeat(64),
      fingerprint: 'b'.repeat(64), total_uc: '13600', expires_at: new Date(start + serverMinutes * minute).toISOString() } } : {}),
    ...(source === 'account' ? { account_quote: { request_hash: 'a'.repeat(64), parameters: {},
      quote: { amount: '0.02', policy_checksum: 'b'.repeat(64), expires_at: new Date(start + serverMinutes * minute).toISOString() } } } : {}),
  };
  const client = {
    credentials: { access: async () => ({ binding: 'expiry-test' }) },
    async call(name, args) {
      if (name === 'estimate_cost') return structuredClone(quote);
      assert.equal(name, `generate_${kind}`);
      submissions.push(args);
      return { ok: true, task_id: `fixture-task-${seed}` };
    },
  };
  const media = new Media({ client, state, server: new URL('https://mcp.evolink.ai/mcp'), now: () => now });
  const result = await media.estimate({ model: quote.model, input: { prompt: `expiry-${seed}` },
    ...(budget === undefined ? {} : { max_cost_usd: budget }) });
  return { media, state, result, start, submissions, advance: elapsed => { now = start + elapsed; } };
}

test('seed 20261015: saved quotes use 30 minutes without extending a shorter server approval', async t => {
  let seed = 20261015, cases = 0;
  for (const kind of ['image', 'video', 'audio']) for (const source of ['rules', 'account', 'legacy']) {
    for (const serverMinutes of source === 'legacy' ? [undefined] : [10, 30, 45]) for (const budget of [undefined, 0.05]) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const c = await context(t, kind, source, serverMinutes, budget, seed);
      const saved = await c.state.read('quotes', c.result.quote_id);
      const expected = c.start + Math.min(30, serverMinutes ?? Infinity) * minute;
      assert.equal(saved.expires_at, expected, `${kind}/${source}/${serverMinutes}`);
      assert.equal(Date.parse(c.result.expires_at), expected);
      assert.equal(saved.args.max_cost_usd, budget);
      assert.equal(c.result.requires_confirmation, true);
      assert.equal(c.submissions.length, 0);
      cases++;
    }
  }
  assert.equal(cases, 42);
});

test('seed 20261015: minute 16 and just before 30 can submit; the expiry instant and later cannot', async t => {
  let seed = 20261015, cases = 0;
  for (const kind of ['image', 'video', 'audio']) for (const source of ['rules', 'account', 'legacy']) {
    for (const budget of [undefined, 0.05]) for (const elapsed of [16 * minute, 30 * minute - 1, 30 * minute, 30 * minute + 1]) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const c = await context(t, kind, source, 30, budget, seed);
      c.advance(elapsed);
      if (elapsed < 30 * minute) {
        await assert.rejects(c.media.generate(kind, c.result.quote_id), { code: 'confirmation_required' });
        await c.media.generate(kind, c.result.quote_id, { confirmed: true });
        assert.equal(c.submissions.length, 1);
        assert.equal(c.submissions[0].max_cost_usd, budget);
      } else {
        await assert.rejects(c.media.generate(kind, c.result.quote_id, { confirmed: true }), { code: 'quote_expired' });
        assert.equal(c.submissions.length, 0);
        assert.equal((await c.state.read('quotes', c.result.quote_id)).state, 'quoted');
      }
      cases++;
    }
  }
  assert.equal(cases, 72);
});
