import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, fakeMcp } from './fixture.mjs';
import { State } from '../src/state.mjs';
import { Media } from '../src/media.mjs';
import { CliError } from '../src/errors.mjs';

const bin = process.env.EVOLINK_CLI_TEST_BIN || fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url)), id = 'task-original-20261017';
async function setup(t) {
  const f = await fixture(); t.after(f.close);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-task-response-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { f, home, state: new State(home) };
}
async function cli(f, home, args, json = true) {
  const token = 'synthetic-task-response-token';
  const child = spawn(process.execPath, [bin, ...args, '--server', f.server.href, ...(json ? ['--json'] : []), '--token-stdin'],
    { env: { ...process.env, EVOLINK_CLI_HOME: home, EVOLINK_CLI_UPDATE_CHECK: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(token);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.ok(!`${stdout}${stderr}`.includes(token));
  if (!json) { assert.equal(stdout, ''); return { code, stderr }; }
  assert.equal(stdout.trim().split('\n').length, 1);
  return { code, view: JSON.parse(stdout) };
}

test('real CLI get rejects four HTTP-200 anomalies and blocks download without creating a file', async t => {
  const { f, home } = await setup(t);
  for (const [response, code] of [[{}, 'task_response_invalid'], [{ message: 'maintenance' }, 'task_response_invalid'],
    [{ id: 'task-foreign', status: 'completed', results: ['https://foreign.test/secret.png'] }, 'task_identity_mismatch'],
    [{ id, status: 'future' }, 'task_status_unknown']]) {
    f.taskResponse = response;
    const result = await cli(f, home, ['tasks', 'get', id]);
    assert.equal(result.code, 1); assert.equal(result.view.ok, false); assert.equal(result.view.error.code, code);
    assert.equal(result.view.error.details.task_id, id); assert.equal(result.view.error.details.status_check, 'unverified');
    assert.equal(result.view.error.details.dashboard_url, 'https://evolink.ai/dashboard');
    assert.ok(result.view.error.details.text.includes('https://evolink.ai/dashboard'));
    assert.doesNotMatch(JSON.stringify(result.view), /foreign\.test|secret.png/);
  }
  const text = await cli(f, home, ['tasks', 'get', id], false);
  assert.equal(text.code, 1); assert.ok(text.stderr.includes('https://evolink.ai/dashboard'));
  assert.ok(text.stderr.includes('Sign in with the same EvoLink account'));
  const output = path.join(home, 'must-not-exist.png');
  const result = await cli(f, home, ['download', id, '--output', output]);
  assert.equal(result.code, 1); await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  assert.equal(f.downloads.length, 0); assert.equal(f.paid.size, 0);
});

test('real CLI handles minimal/resource-only/failed responses and never fabricates missing zero values', async t => {
  const { f, home } = await setup(t);
  for (const body of [{ id, status: 'completed' }, { id, status: 'completed', result_data: { voice_id: 'voice-keep' } },
    { id, status: 'completed', type: 'audio', result_data: [{ audio_url: 'https://media.test/song.mp3?sig=keep', title: 'Song' }] },
    { id, status: 'pending' }, { id, status: 'failed', error: { code: 'invalid_parameters', message: 'Invalid task input.' } }]) {
    f.taskResponse = body;
    const result = await cli(f, home, ['tasks', 'get', id]);
    assert.equal(result.code, 0); assert.equal(result.view.status, body.status);
    assert.equal(result.view.progress, undefined); assert.equal(result.view.charged_credits, undefined);
    if (body.result_data?.voice_id) assert.equal(result.view.outputs[0].voice_id, 'voice-keep');
    if (Array.isArray(body.result_data)) assert.equal(result.view.results[0].url, body.result_data[0].audio_url);
  }
  const failed = await cli(f, home, ['tasks', 'wait', id]);
  assert.equal(failed.code, 1); assert.equal(failed.view.error.code, 'task_failed');
  assert.equal(f.paid.size, 0);
});

test('real CLI persists an ID-only accepted receipt despite a bad follow-up read; resume is read-only', async t => {
  const { f, home, state } = await setup(t);
  f.receiptOnly = true; f.taskResponse = { message: 'maintenance' };
  const quote = await cli(f, home, ['estimate', '--model', 'fixture-image', '--input', '{"prompt":"one synthetic task"}']);
  assert.equal(quote.code, 0);
  const generated = await cli(f, home, ['generate', 'image', '--quote', quote.view.quote_id, '--confirm']);
  assert.equal(generated.code, 0); assert.equal(generated.view.submission_state, 'accepted');
  assert.equal(generated.view.status, undefined); assert.equal(generated.view.status_check, 'unverified');
  assert.equal(generated.view.dashboard_url, 'https://evolink.ai/dashboard');
  const saved = await state.read('quotes', quote.view.quote_id);
  assert.equal(saved.state, 'submitted'); assert.equal(saved.task_id, generated.view.task_id); assert.equal(f.paid.size, 1);
  const paidCalls = f.calls.filter(call => call.name === 'generate_image').length;
  const uncertain = await cli(f, home, ['tasks', 'resume', '--quote', quote.view.quote_id]);
  assert.equal(uncertain.code, 1); assert.equal(uncertain.view.error.details.task_id, saved.task_id);
  assert.equal((await state.read('quotes', quote.view.quote_id)).state, 'submitted');
  f.taskResponse = undefined;
  const recovered = await cli(f, home, ['tasks', 'resume', '--quote', quote.view.quote_id]);
  assert.equal(recovered.code, 0); assert.equal(recovered.view.task_id, saved.task_id);
  assert.equal(f.calls.filter(call => call.name === 'generate_image').length, paidCalls);
});

test('real CLI retains base page and marks missing details; explicit batches preserve valid rows', async t => {
  const { f, home } = await setup(t);
  f.tasks.set(id, { task_id: id, status: 'completed', model: 'fixture-image', type: 'image', results: [{ url: `${f.origin}/assets/result`, kind: 'image' }] });
  f.batchResponse = { message: 'maintenance' };
  let result = await cli(f, home, ['tasks', 'list']);
  assert.equal(result.code, 0); assert.equal(result.view.partial, true); assert.equal(result.view.tasks[0].task_id, id);
  assert.equal(result.view.tasks[0].details_available, false); assert.deepEqual(result.view.details_missing, [id]);
  assert.equal(result.view.tasks[0].details_reason, 'read_failed'); assert.equal(result.view.details_status, 'unavailable');
  assert.deepEqual(result.view.details_retry_task_ids, [id]); assert.equal(result.view.last_page, 1);
  assert.equal(result.view.dashboard_url, 'https://evolink.ai/dashboard');
  f.batchResponse = { data: [{ id, status: 'completed' }, { id: 'task-bad', status: 'future' }, { id: 'task-foreign', status: 'completed', results: ['https://foreign.test/private'] }] };
  result = await cli(f, home, ['tasks', 'batch', '--ids', `${id},task-bad`]);
  assert.equal(result.code, 0); assert.equal(result.view.partial, true); assert.equal(result.view.tasks.length, 1);
  assert.equal(result.view.dashboard_url, 'https://evolink.ai/dashboard');
  assert.doesNotMatch(JSON.stringify(result.view), /foreign\.test|task-foreign/);
});

test('defensive accepted-error journal survives failures and prevents paid replay', async t => {
  const { home, state } = await setup(t), data = { calls: [] }, client = fakeMcp(data);
  const original = client.call.bind(client);
  client.call = async (name, args) => {
    if (name === 'generate_image') throw new CliError('task_response_invalid', 'Accepted, but query unavailable.', { submission_state: 'accepted', task_id: id, charged: 'unknown' });
    return original(name, args);
  };
  const media = new Media({ mcp: client, state, server: new URL('http://127.0.0.1:9999/mcp') });
  const quote = await media.estimate({ model: 'image', input: { prompt: 'accepted journal' } });
  await assert.rejects(media.generate('image', quote.quote_id, { confirmed: true }), { code: 'task_response_invalid' });
  assert.equal((await state.read('quotes', quote.quote_id)).task_id, id);
  assert.equal((await state.read('quotes', quote.quote_id)).state, 'submitted');
  await media.resume(quote.quote_id);
  assert.equal(data.calls.at(-1).name, 'get_task');
});
