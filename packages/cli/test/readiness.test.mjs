import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { checkEstimate, Media } from '../src/media.mjs';
import { publicURL, resultFetch, USER_AGENT } from '../src/network.mjs';
import { CliError, errorView } from '../src/errors.mjs';
import { State } from '../src/state.mjs';
import { fakeMcp } from './fixture.mjs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const quote = extra => ({ input_valid: true, enough_balance: true, enough_limit: true, enough_daily_limit: true,
  estimate: { status: 'estimated', min_usd: 0.02, max_usd: 0.02 }, ...extra });

test('readiness: account, MCP and daily limits retain different recovery categories', () => {
  assert.throws(() => checkEstimate(quote({ enough_balance: false }), 0.05), { code: 'insufficient_balance' });
  assert.throws(() => checkEstimate(quote({ enough_limit: false, limit_scope: 'mcp' }), 0.05), { code: 'insufficient_limit' });
  assert.throws(() => checkEstimate(quote({ enough_daily_limit: false }), 0.05), { code: 'insufficient_daily_limit' });
});

test('readiness: invalid estimated price ranges cannot authorize submission', () => {
  for (const [min_usd, max_usd] of [[-1, -1], [0.03, 0.02], [0.01, NaN], [0.01, Infinity]]) {
    assert.throws(() => checkEstimate(quote({ estimate: { status: 'estimated', min_usd, max_usd } }), 0.05));
  }
  for (const max_usd of [-1, NaN, Infinity]) {
    assert.throws(() => checkEstimate(quote({ estimate: { status: 'estimated', max_usd } })), { code: 'estimate_unavailable' });
  }
  assert.throws(() => checkEstimate(quote({ input_valid: null }), 0.05), { code: 'uncheckable_input' });
});

test('readiness: pre-submit price changes retain a blocked flow and the user budget', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-readiness-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const data = { calls: [] };
  const media = new Media({ mcp: fakeMcp(data), state: new State(home), server: new URL('http://127.0.0.1:9999/mcp') });
  const saved = await media.estimate({ model: 'image', input: { prompt: 'test' }, max_cost_usd: 0.05 });
  data.cost = 0.03;
  await assert.rejects(media.generate('image', saved.quote_id, { confirmed: true }), error => {
    assert.equal(error.code, 'price_changed');
    assert.equal(error.details?.submission_allowed, false);
    assert.equal(error.details?.max_cost_usd, 0.05);
    return true;
  });
  assert.equal(data.calls.some(c => c.name.startsWith('generate_')), false);
});

test('readiness: resuming a never-submitted quote does not claim an existing task', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-readiness-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const data = { calls: [] };
  const state = new State(home);
  const media = new Media({ mcp: fakeMcp(data), state, server: new URL('http://127.0.0.1:9999/mcp') });
  const saved = await media.estimate({ model: 'image', input: { prompt: 'test' }, max_cost_usd: 0.05 });
  await assert.rejects(media.resume(saved.quote_id), error => {
    assert.equal(error.code, 'submission_not_started');
    assert.equal(error.details.submission_allowed, false);
    assert.ok(error.details.next_step.includes(`generate image --quote ${saved.quote_id} --confirm`));
    return true;
  });
  assert.equal((await state.read('quotes', saved.quote_id)).state, 'quoted');
  assert.equal(data.calls.some(c => c.name.startsWith('generate_')), false);
  assert.ok((await media.generate('image', saved.quote_id, { confirmed: true })).task_id);
});

test('readiness: IPv4-mapped IPv6 and multicast DNS answers are blocked', async t => {
  const original = dns.lookup;
  t.after(() => { dns.lookup = original; });
  for (const address of ['::ffff:7f00:1', '::ffff:a00:1', '::ffff:c0a8:1', 'ff02::1']) {
    dns.lookup = async () => [{ address, family: 6 }];
    await assert.rejects(publicURL('https://result.invalid/media.png'), { code: 'invalid_result_url' });
  }
  dns.lookup = async () => [{ address: '2606:4700:4700::1111', family: 6 }];
  assert.equal((await publicURL('https://result.invalid/media.png')).hostname, 'result.invalid');
});

test('readiness: an explicitly refused submission cannot enter a recovery loop', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-readiness-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const data = { calls: [] }, state = new State(home), mcp = fakeMcp(data);
  const call = mcp.call.bind(mcp);
  mcp.call = async (name, args) => {
    if (name === 'generate_image') { data.calls.push({ name, args }); throw new CliError('insufficient_balance', 'Fixture refusal', { charged: 'no', submission_state: 'rejected' }); }
    return call(name, args);
  };
  const media = new Media({ mcp, state, server: new URL('http://127.0.0.1:9999/mcp') });
  const saved = await media.estimate({ model: 'image', input: { prompt: 'test' }, max_cost_usd: 0.05 });
  await assert.rejects(media.generate('image', saved.quote_id, { confirmed: true }), { code: 'insufficient_balance' });
  assert.equal((await state.read('quotes', saved.quote_id)).state, 'refused');
  await assert.rejects(media.resume(saved.quote_id), { code: 'submission_refused' });
  await assert.rejects(media.generate('image', saved.quote_id, { confirmed: true }), { code: 'submission_refused' });
  assert.equal(data.calls.filter(c => c.name === 'generate_image').length, 1);
});

test('readiness: errors remove API keys and secret upload query values', () => {
  const view = errorView(new CliError('fixture_error', 'Download failed at https://mcp.evolink.ai/uploads/id?token=fixture-upload-secret', {
    api_key: 'fixture-api-secret', nested: { 'x-api-key': 'fixture-header-secret', secret: 'fixture-other-secret' },
    quote_id: 'keep-quote', client_request_id: 'keep-request', task_id: 'keep-task',
  }));
  const serialized = JSON.stringify(view);
  for (const secret of ['fixture-upload-secret', 'fixture-api-secret', 'fixture-header-secret', 'fixture-other-secret']) {
    assert.ok(!serialized.includes(secret), `Leaked simulated value: ${secret}`);
  }
  assert.equal(view.details.quote_id, 'keep-quote');
  assert.equal(view.details.client_request_id, 'keep-request');
  assert.equal(view.details.task_id, 'keep-task');
});

test('readiness: download pins validated DNS answers and revalidates redirects', async t => {
  const originalLookup = dns.lookup, originalRequest = https.request;
  t.after(() => { dns.lookup = originalLookup; https.request = originalRequest; });
  let lookups = 0, requests = 0;
  dns.lookup = async () => { lookups++; return [{ address: '1.1.1.1', family: 4 }]; };
  https.request = (url, options, receive) => {
    requests++;
    assert.equal(url.hostname, 'result.invalid');
    assert.equal(options.agent, false);
    assert.equal(options.headers['User-Agent'], USER_AGENT);
    assert.equal(options.headers.Authorization, undefined);
    options.lookup('result.invalid', { all: true }, (error, addresses) => {
      assert.ifError(error);
      assert.deepEqual(addresses, [{ address: '1.1.1.1', family: 4 }]);
    });
    const request = new EventEmitter();
    request.end = () => {
      const incoming = Readable.from([Buffer.from('original-media')]);
      incoming.statusCode = requests === 1 ? 200 : 302;
      incoming.rawHeaders = requests === 1 ? ['Content-Type', 'image/png'] : ['Location', 'https://127.0.0.1/private'];
      receive(incoming);
    };
    return request;
  };
  assert.equal(await (await resultFetch('https://result.invalid/media.png')).text(), 'original-media');
  assert.equal(lookups, 1, 'The transport must not perform a second DNS resolution');
  await assert.rejects(resultFetch('https://result.invalid/redirect'), { code: 'invalid_result_url' });
  assert.equal(requests, 2, 'The private redirect must not be requested');
});

test('readiness: seeded cap and input combinations fail closed', () => {
  let seed = 20261009;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 200; i++) {
    const input_valid = [true, false, null][Math.floor(random() * 3)];
    const cap = [0.01, 0.02, 0.05][Math.floor(random() * 3)];
    const max_usd = [0.01, 0.02, 0.03, -1, Infinity][Math.floor(random() * 5)];
    const value = quote({ input_valid, estimate: { status: 'estimated', min_usd: max_usd, max_usd } });
    if (input_valid === true && Number.isFinite(max_usd) && max_usd >= 0 && max_usd <= cap) assert.doesNotThrow(() => checkEstimate(value, cap));
    else assert.throws(() => checkEstimate(value, cap));
  }
});
