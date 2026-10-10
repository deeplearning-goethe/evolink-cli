import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fixture, mediaSamples } from './fixture.mjs';
import { State } from '../src/state.mjs';
import { Mcp } from './legacy-mcp.mjs';
import { Credentials } from '../src/auth.mjs';
import { download, upload } from '../src/files.mjs';
import { doctor } from '../src/doctor.mjs';
import { CliError, errorView } from '../src/errors.mjs';

const bin = fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
async function setup(t) {
  const f = await fixture(); t.after(f.close);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-acceptance-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const state = new State(home);
  const credentials = new Credentials({ state, server: f.server, token: 'fixture-acceptance-token' });
  const mcp = new Mcp(credentials);
  // An existing completed task; these checks must never generate or charge.
  const task = { task_id: 'completed-task', status: 'completed', type: 'image', results: [{ kind: 'image', url: `${f.origin}/assets/result` }] };
  f.tasks.set(task.task_id, task);
  const cli = async args => {
    const child = spawn(process.execPath, [bin, ...args, '--server', f.server.href, '--token-stdin', '--json'],
      { env: { ...process.env, EVOLINK_CLI_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end('fixture-acceptance-token');
    let out = '', err = '';
    child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
    const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    assert.equal(out.trim().split('\n').length, 1);
    assert.ok(!out.includes('fixture-acceptance-token') && !err.includes('fixture-acceptance-token'));
    return { code, view: JSON.parse(out), stderr: err };
  };
  return { f, home, state, credentials, mcp, task, cli };
}

test('failed quote returns a blocked flow with the original cap and creates no saved quote or task', async t => {
  const { f, home, cli } = await setup(t);
  for (const [model, input, failure, code, balance = 1000] of [
    ['fixture-image', { prompt: 'test' }, true, 'service_unavailable'],
    ['fixture-image', { invalid: true }, false, 'invalid_input'],
    ['fixture-image', { prompt: 'test' }, false, 'insufficient_balance', 0],
    ['fixture-token-image', { prompt: 'test' }, false, 'uncheckable_cap'],
    ['fixture-partial-video', { prompt: 'test', duration: 5, video_urls: ['https://example.com/reference.mp4'] }, false, 'uncheckable_cap'],
    ['fixture-image', { prompt: 'test', n: 10 }, false, 'cost_exceeds_cap'],
  ]) {
    f.estimateFailure = failure;
    f.balanceCredits = balance;
    const result = await cli(['estimate', '--model', model, '--input', JSON.stringify(input), '--max-cost-usd', '0.05']);
    assert.equal(result.code, 1, model); assert.equal(result.view.ok, false); assert.equal(result.view.error.code, code);
    assert.equal(result.view.error.details.submission_allowed, false);
    assert.equal(result.view.error.details.max_cost_usd, 0.05);
    assert.equal(result.view.quote_id, undefined);
  }
  assert.equal(f.paid.size, 0);
  assert.equal(f.calls.some(c => c.name.startsWith('generate_')), false);
  await assert.rejects(fs.stat(path.join(home, 'quotes')), { code: 'ENOENT' });
});

test('actual CLI estimate-confirm-submit flow shows the cost without an automatic cap', async t => {
  const { f, state, cli } = await setup(t);
  const estimate = await cli(['estimate', '--model', 'fixture-image', '--input', JSON.stringify({ prompt: 'cost confirmation' })]);
  assert.equal(estimate.code, 0); assert.equal(estimate.view.ok, true);
  assert.equal(estimate.view.estimate.max_usd, 0.02);
  assert.equal(Object.hasOwn(estimate.view, 'max_cost_usd'), false); assert.equal(Object.hasOwn(estimate.view, 'cap_source'), false);
  const id = estimate.view.quote_id;
  assert.equal(Object.hasOwn((await state.read('quotes', id)).args, 'max_cost_usd'), false);
  const unapproved = await cli(['generate', 'image', '--quote', id]);
  assert.equal(unapproved.view.error.code, 'confirmation_required'); assert.equal(f.paid.size, 0);
  const approved = await cli(['generate', 'image', '--quote', id, '--confirm']);
  assert.equal(approved.code, 0); assert.equal(approved.view.final_budget_enforced, false); assert.equal(f.paid.size, 1);
  const submitted = f.calls.find(call => call.name === 'generate_image');
  assert.equal(Object.hasOwn(submitted.args, 'max_cost_usd'), false);
});

test('HTTP 200 HTML, JSON and wrong media types are refused without output or new tasks', async t => {
  const { f, home, mcp, task, cli } = await setup(t);
  const output = path.join(home, 'result.png');
  for (const bytes of [Buffer.from('<!doctype html><html>Access denied</html>'), Buffer.from('\uFEFF  <html>Challenge</html>'),
    Buffer.from(JSON.stringify({ error: 'expired' })), Buffer.from(' '.repeat(1024) + '<html>Denied</html>')]) {
    for (const type of ['text/html; charset=UTF-8', 'application/json', 'image/png', 'application/octet-stream', undefined]) {
      for (const chunked of [false, true]) {
        f.bytes = bytes; f.contentType = type; f.chunkedDownload = chunked;
        await assert.rejects(download(task.task_id, output, { mcp, server: f.server }), { code: 'invalid_download_content' });
        assert.equal((await fs.readdir(home)).some(n => n === 'result.png' || n.endsWith('.part')), false);
      }
    }
  }
  f.bytes = mediaSamples.image.bytes; f.contentType = 'audio/wav';
  const rejected = await cli(['download', task.task_id, '--output', output]);
  assert.equal(rejected.code, 1); assert.equal(rejected.view.error.code, 'invalid_download_content');
  assert.equal(f.paid.size, 0); assert.equal(f.tasks.size, 1);
});

test('seed 20261008: media formats, generic MIME and fragmented bodies preserve original bytes', async t => {
  const { f, home, mcp, task } = await setup(t);
  const samples = [
    ...Object.entries(mediaSamples).map(([kind, s]) => ({ kind, ...s })),
    { kind: 'image', type: 'image/jpeg', bytes: Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex') },
    { kind: 'image', type: 'image/webp', bytes: Buffer.from('524946461000000057454250565038200400000000000000', 'hex') },
    { kind: 'image', type: 'image/avif', bytes: Buffer.from('00000018667479706176696600000000617669666d696631', 'hex') },
    { kind: 'audio', type: 'audio/mpeg', bytes: Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000fixture') },
    { kind: 'audio', type: 'audio/ogg', bytes: Buffer.from('OggS\u0000\u0002fixture') },
    { kind: 'video', type: 'video/webm', bytes: Buffer.from('1a45dfa39f4286810142f7810142f2810442f38108', 'hex') },
  ];
  let seed = 20261008;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (const sample of samples) for (const type of [sample.type, 'application/octet-stream', undefined]) {
    task.results[0].kind = sample.kind;
    const output = path.join(home, `original-${random()}.bin`);
    // One-byte and seeded boundaries ensure signatures split across stream chunks.
    const fetchFn = async () => new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < sample.bytes.length;) {
        const end = Math.min(sample.bytes.length, offset + 1 + random() % 7);
        controller.enqueue(sample.bytes.subarray(offset, end)); offset = end;
      }
      controller.close();
    } }), { headers: type ? { 'Content-Type': type } : {} });
    const result = await download(task.task_id, output, { mcp, server: f.server, fetchFn });
    assert.deepEqual(await fs.readFile(output), sample.bytes);
    assert.equal(result.sha256, createHash('sha256').update(sample.bytes).digest('hex'));
  }
  assert.equal(f.paid.size, 0);
});

test('local path failures are specific and happen before upload or download HTTP requests', async t => {
  const { f, home, state, mcp, task, cli } = await setup(t);
  const missing = path.join(home, 'not-present.png');
  await assert.rejects(upload(missing, { state, mcp, server: f.server }), { code: 'file_not_found' });
  const badInput = await cli(['estimate', '--model', 'fixture-image', '--input-file', missing]);
  assert.equal(badInput.view.error.code, 'file_not_found');
  const nested = await cli(['download', task.task_id, '--output', path.join(home, 'missing', 'file.png')]);
  assert.equal(nested.view.error.code, 'output_directory_missing');
  const existing = path.join(home, 'existing.png'); await fs.writeFile(existing, 'keep-original');
  await assert.rejects(download(task.task_id, existing, { mcp, server: f.server }), { code: 'file_exists' });
  assert.equal(await fs.readFile(existing, 'utf8'), 'keep-original');
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const denied = path.join(home, 'denied'); await fs.mkdir(denied, { mode: 0o500 });
    await assert.rejects(download(task.task_id, path.join(denied, 'result.png'), { mcp, server: f.server }), { code: 'file_permission_denied' });
    const unreadable = path.join(home, 'unreadable.png'); await fs.writeFile(unreadable, f.bytes, { mode: 0o000 });
    await assert.rejects(upload(unreadable, { state, mcp, server: f.server }), { code: 'file_permission_denied' });
    await fs.chmod(denied, 0o700);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 0); assert.equal(f.uploads.size, 0);
  for (const code of ['ENOSPC', 'EDQUOT']) {
    const view = errorView(Object.assign(new Error('raw system error'), { code }));
    assert.equal(view.code, 'disk_full'); assert.match(view.message, /space|quota/);
  }
});

test('doctor reports all prerequisites, skips unsafe connection attempts and preserves failing exit status', async t => {
  const { f, home, state, credentials, mcp, cli } = await setup(t);
  const cases = [
    { status: async () => { throw new CliError('credential_store_unavailable', 'Start a Secret Service keyring.'); } },
    { status: async () => ({ authenticated: false }) },
    credentials,
  ];
  for (const c of cases) {
    f.calls.length = 0;
    const result = await doctor({ state, server: f.server, credentials: c, mcp, platform: 'linux', remote: true });
    assert.equal(result.checks.length, 6);
    assert.equal(result.ok, c === credentials);
    assert.equal(result.checks.find(c => c.name === 'connection').status, result.ok ? 'passed' : 'skipped');
    assert.equal(f.calls.length, result.ok ? 2 : 0);
    assert.ok(result.guidance.some(g => g.includes('port forwarding')));
    assert.equal((await fs.readdir(home)).some(n => n.startsWith('.doctor-')), false);
  }
  f.balanceFailure = true;
  const failed = await cli(['doctor']);
  assert.equal(failed.code, 1); assert.equal(failed.view.ok, false); assert.equal(failed.view.connection_verified, false);
  assert.equal(failed.view.checks.find(c => c.name === 'connection').status, 'failed');
  f.balanceFailure = false;
  const healthy = await cli(['doctor']);
  assert.equal(healthy.code, 0); assert.equal(healthy.view.ok, true);
  assert.equal(healthy.view.checks.every(c => c.status === 'passed'), true);
  const old = await doctor({ state, server: f.server, credentials, mcp, version: 'v20.0.0' });
  assert.equal(old.ok, false); assert.equal(old.checks[0].error.code, 'unsupported_runtime');
});
