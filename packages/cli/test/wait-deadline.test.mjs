// tasks wait: one local deadline for every round, read, renewal check, pause and the optional update notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, MemoryVault } from './fixture.mjs';
import { State } from '../src/state.mjs';
import { Media } from '../src/media.mjs';
import { Credentials } from '../src/auth.mjs';
import { Api } from '../src/api.mjs';
import { CliError } from '../src/errors.mjs';
import { beforeDeadline } from '../src/cli.mjs';

const bin = process.env.EVOLINK_CLI_TEST_BIN || fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
const id = 'task-wait-deadline-20261020';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t) {
  const f = await fixture(); t.after(f.close);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-wait-deadline-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { f, home };
}

async function cli(f, home, args, json = true) {
  const token = 'synthetic-wait-deadline-token';
  const started = performance.now();
  const child = spawn(process.execPath, [bin, ...args, '--server', f.server.href, ...(json ? ['--json'] : []), '--token-stdin'],
    { env: { ...process.env, EVOLINK_CLI_HOME: home, EVOLINK_CLI_UPDATE_CHECK: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(token);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const ms = performance.now() - started;
  assert.ok(!`${stdout}${stderr}`.includes(token));
  return { code, ms, stderr, ...(json ? { view: JSON.parse(stdout.trim().split('\n').at(-1)) } : {}) };
}

function fakeMedia(home, call) {
  const calls = [];
  const client = { call: async (name, args, options) => { calls.push({ name, args, options, at: performance.now() }); return call(calls.length, options); } };
  return { calls, media: new Media({ client, state: new State(home), server: new URL('http://127.0.0.1:1/mcp') }) };
}

test('real CLI: a gateway that never answers ends tasks wait at its limit with an unverified status, not a 15 s read', async t => {
  const { f, home } = await setup(t);
  // The response closes when the CLI gives up on the read; nothing is ever sent.
  f.taskRead = ({ res }) => new Promise(resolve => res.on('close', resolve));
  const result = await cli(f, home, ['tasks', 'wait', id, '--timeout', '2']);
  assert.equal(result.code, 1);
  assert.equal(result.view.error.code, 'wait_timeout');
  const details = result.view.error.details;
  assert.equal(details.task_id, id); assert.equal(details.status_check, 'unverified');
  assert.equal(details.dashboard_url, 'https://evolink.ai/dashboard');
  assert.match(result.view.error.message, /does not cancel the task/);
  assert.doesNotMatch(result.view.error.message, /still running/i);
  assert.ok(result.ms >= 1500 && result.ms < 4500, `took ${Math.round(result.ms)} ms`);
  assert.equal(f.paid.size, 0);
});

test('real CLI: at its limit tasks wait reports the last verified status and its read time, keeping the polling rhythm', async t => {
  const { f, home } = await setup(t);
  f.tasks.set(id, { task_id: id, status: 'processing', type: 'image', progress: 30 });
  const result = await cli(f, home, ['tasks', 'wait', id, '--timeout', '3']);
  assert.equal(result.code, 1);
  assert.equal(result.view.error.code, 'wait_timeout');
  const details = result.view.error.details;
  assert.equal(details.status_check, 'verified'); assert.equal(details.last_status, 'processing');
  assert.ok(Date.parse(details.read_at) > 0);
  assert.equal(details.recovery, `evolink tasks wait ${id}`);
  assert.match(result.view.error.message, /Last verified status: processing/);
  assert.ok(result.ms >= 2500 && result.ms < 5500, `took ${Math.round(result.ms)} ms`);
  const reads = f.taskReads.filter(read => read.id === id);
  assert.ok(reads.length <= 2, `${reads.length} reads in 3 s: an image task is read about every 3 s`);

  const text = await cli(f, home, ['tasks', 'wait', id, '--timeout', '1'], false);
  assert.equal(text.code, 1);
  assert.match(text.stderr, /wait_timeout: Stopped waiting at the timeout\. Stopping does not cancel the task\./);
});

test('rounds share one deadline: whole seconds left, a later round needs 2 s, and pauses keep the polling rhythm', async t => {
  const { home } = await setup(t);
  // read_at long ago: pauses fall to the 500 ms minimum, so several rounds fit.
  const old = () => ({ task_id: id, status: 'processing', type: 'image', read_at: new Date(Date.now() - 10_000).toISOString() });
  const fresh = () => ({ task_id: id, status: 'processing', type: 'image', read_at: new Date().toISOString() });
  let { calls, media } = fakeMedia(home, async n => { await delay(n === 1 ? 400 : 100); return old(); });
  const budget = {};
  let started = performance.now();
  await assert.rejects(media.wait(id, { timeout: 4, budget }), error => error.code === 'wait_timeout'
    && error.details.status_check === 'verified' && error.details.last_status === 'processing');
  const ms = performance.now() - started;
  assert.ok(ms >= 1900 && ms < 4150, `took ${Math.round(ms)} ms`);
  assert.equal(calls[0].args.wait_seconds, 4);
  assert.equal(calls[1].args.wait_seconds, 3, 'about 3.1 s left is a 3 s round, not 4 s');
  assert.ok(calls.length >= 2 && calls.length <= 3, `${calls.length} rounds`);
  assert.ok(calls.slice(1).every(call => call.at - started <= 4000 - 2000), 'a later round starts only with at least 2 s left');
  assert.ok(calls.every(call => call.options.deadline === budget.deadline), 'every round carries the wait deadline');

  // The first round always runs, even when the whole wait is 1 s.
  ({ calls, media } = fakeMedia(home, async () => fresh()));
  await assert.rejects(media.wait(id, { timeout: 1 }), error => error.code === 'wait_timeout' && error.details.status_check === 'verified');
  assert.equal(calls.length, 1); assert.equal(calls[0].args.wait_seconds, 1);

  // A fresh read: the next round waits for the image polling interval instead of reading every 500 ms;
  // after that 3 s pause less than 2 s of the 4 s wait is left, so no later round starts.
  ({ calls, media } = fakeMedia(home, async () => fresh()));
  await assert.rejects(media.wait(id, { timeout: 4 }), { code: 'wait_timeout' });
  assert.equal(calls.length, 1);
  // The pause itself still ends at the wait's limit.
  ({ calls, media } = fakeMedia(home, async () => fresh()));
  started = performance.now();
  await assert.rejects(media.wait(id, { timeout: 2 }), { code: 'wait_timeout' });
  assert.equal(calls.length, 1);
  assert.ok(performance.now() - started < 2150, 'the 3 s image interval is cut at the 2 s limit');
});

test('after a verified status, rounds that cannot verify it again report it as unverified, never as current', async t => {
  const { home } = await setup(t);
  const old = new Date(Date.now() - 10_000).toISOString();
  const verified = { task_id: id, status: 'processing', type: 'image', read_at: old, status_check: 'verified' };
  const unverifiedView = error => error.code === 'wait_timeout' && error.details.status_check === 'unverified'
    && error.details.last_status === 'processing' && error.details.dashboard_url === 'https://evolink.ai/dashboard'
    && /could not be verified \(last verified: processing\)/.test(error.message) && !/Last verified status/.test(error.message);
  // Later rounds run out of time.
  let { calls, media } = fakeMedia(home, async n => {
    if (n === 1) return verified;
    await delay(100); throw new CliError('task_query_timeout', 'The wait limit was reached.');
  });
  await assert.rejects(media.wait(id, { timeout: 4 }), unverifiedView);
  assert.ok(calls.length >= 2);
  // Later rounds return the shared core's unverified snapshot (a later read inside the round failed).
  ({ calls, media } = fakeMedia(home, async n => n === 1 ? verified
    : { task_id: id, type: 'image', status_check: 'unverified', last_known_status: 'processing', read_at: old }));
  await assert.rejects(media.wait(id, { timeout: 4 }), unverifiedView);
  assert.ok(calls.length >= 2);
});

test('a round that ran out of time continues while the wait has time; if none verifies, the status stays unverified', async t => {
  const { home } = await setup(t);
  let { calls, media } = fakeMedia(home, async n => {
    if (n === 1) { await delay(300); throw new CliError('task_query_timeout', 'The wait limit was reached.'); }
    return { task_id: id, status: 'processing', type: 'image', read_at: new Date().toISOString() };
  });
  await assert.rejects(media.wait(id, { timeout: 4 }), error => error.code === 'wait_timeout' && error.details.status_check === 'verified');
  assert.equal(calls.length, 2);

  ({ calls, media } = fakeMedia(home, async () => { await delay(200); throw new CliError('task_query_timeout', 'The wait limit was reached.'); }));
  const started = performance.now();
  await assert.rejects(media.wait(id, { timeout: 2 }), error => error.code === 'wait_timeout' && error.details.status_check === 'unverified'
    && error.details.dashboard_url === 'https://evolink.ai/dashboard' && !/still running/i.test(error.message));
  assert.ok(performance.now() - started < 2150);

  ({ calls, media } = fakeMedia(home, async () => { throw new CliError('server_error', 'EvoLink could not complete this operation.'); }));
  await assert.rejects(media.wait(id, { timeout: 5 }), { code: 'server_error' });
  assert.equal(calls.length, 1, 'other read errors still end the wait at once');
});

test('Ctrl-C during a round stops the local wait at once with exit 130', async t => {
  const { home } = await setup(t);
  const controller = new AbortController();
  const { media } = fakeMedia(home, () => new Promise((resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new CliError('interrupted', 'Interrupted.', {}, 130)), { once: true });
  }));
  setTimeout(() => controller.abort(), 100);
  const started = performance.now();
  await assert.rejects(media.wait(id, { timeout: 30, signal: controller.signal }), error => error.code === 'interrupted' && error.exitCode === 130);
  assert.ok(performance.now() - started < 400);
});

test('near a deadline a still-valid token is used without renewal, and a renewal that cannot finish is not started', async t => {
  const { f, home } = await setup(t);
  const vault = new MemoryVault();
  const credentials = new Credentials({ server: f.server, state: new State(home), vault });
  await credentials.login({ progress: () => {}, browser: async url => { await fetch(url); } });
  const original = vault.value.tokens.access_token;

  vault.value.expires_at = Date.now() + 20_000; // normally renewed within 60 s of expiry
  assert.equal((await credentials.access(false, { deadline: performance.now() + 2_000 })).access_token, original);
  assert.equal(f.refreshCount, 0, 'a token valid past the deadline is enough');

  vault.value.expires_at = Date.now() - 1_000;
  await assert.rejects(credentials.access(false, { deadline: performance.now() + 1_000 }), { code: 'wait_deadline_reached' });
  await assert.rejects(credentials.access(true, { deadline: performance.now() + 1_000 }), { code: 'wait_deadline_reached' });
  assert.equal(f.refreshCount, 0, 'no renewal starts without time to finish it');

  // Through the API client: a get_task round near the limit fails as a round timeout before any renewal.
  await assert.rejects(new Api(credentials).call('get_task', { task_id: id, wait_seconds: 0 }, { deadline: performance.now() + 1_000 }),
    { code: 'wait_deadline_reached' });
  assert.equal(f.refreshCount, 0, 'the API client passes the wait deadline to the renewal check');

  assert.notEqual((await credentials.access(false, { deadline: performance.now() + 60_000 })).access_token, original);
  assert.equal(f.refreshCount, 1, 'with time left the renewal runs');
  vault.value.expires_at = Date.now() + 20_000;
  await credentials.access(true, { deadline: performance.now() + 5_000 });
  assert.equal(f.refreshCount, 2, 'a token the service refused is renewed even when it looks valid past the deadline');
  vault.value.expires_at = Date.now() + 20_000;
  await credentials.access();
  assert.equal(f.refreshCount, 3, 'without a wait deadline the usual 60 s renewal rule applies');
});

test('one get_task round carries the wait deadline into the shared core: a single read stops there, not after its 15 s read timeout', async t => {
  const { f, home } = await setup(t);
  f.taskRead = ({ res }) => new Promise(resolve => res.on('close', resolve));
  const api = new Api(new Credentials({ server: f.server, state: new State(home), token: 'synthetic-wait-deadline-token' }));
  const started = performance.now();
  await assert.rejects(api.call('get_task', { task_id: id, wait_seconds: 0 }, { deadline: performance.now() + 800 }), error =>
    error.code === 'task_query_timeout' && /does not cancel the task/.test(error.message));
  const ms = performance.now() - started;
  assert.ok(ms >= 600 && ms < 2000, `took ${Math.round(ms)} ms`);
  assert.equal(f.taskReads.filter(read => read.id === id).length, 1, 'a single read is not retried');
});

test('the update notice is awaited only inside a local wait: in time it is kept, at the limit it is dropped', async () => {
  assert.equal(await beforeDeadline(Promise.resolve('notice'), performance.now() + 1_000), 'notice');
  assert.equal(await beforeDeadline(undefined, performance.now() + 1_000), undefined);
  const started = performance.now();
  assert.equal(await beforeDeadline(delay(800).then(() => 'late notice'), performance.now() + 100), undefined);
  assert.ok(performance.now() - started < 400);
  assert.equal(await beforeDeadline(delay(800).then(() => 'late notice'), performance.now() - 1), undefined);
});
