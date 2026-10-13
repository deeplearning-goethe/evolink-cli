import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture.mjs';

const bin = fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
const NOT_CHARGED = 'The task failed, so it is not charged. The credits reserved at submission are returned automatically.';
const LEAKS = /channel_|secret\.upstream|sk-synthetic/;
const GATEWAY = 'GATEWAY_PROSE_SENTINEL\nBearer sk-synthetic secret.upstream.test';
const SHOWN = 'GATEWAY_PROSE_SENTINEL Bearer [redacted] [service address]';
const UPLOAD_DOCS = 'https://evolink.ai/docs/en/api-manual/file-series/upload-url';
// Gateway code → the code the CLI reports. channel_* concern EvoLink's own upstream accounts.
const CASES = [
  ['channel_credential_invalid', 'service_unavailable'], ['channel_membership_insufficient', 'service_unavailable'],
  ['invalid_parameters', 'invalid_parameters'], ['content_policy_violation', 'content_policy_violation'],
  ['invalid_audio', 'invalid_audio'], ['secret.upstream.test', 'unknown_error'], [undefined, 'unknown_error'],
];
const shownFor = gatewayCode => gatewayCode === undefined ? 'Generation failed; the cause is unknown.' : SHOWN;

async function homeFor(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-failed-task-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

async function cli(home, args, { server, json = true }) {
  const child = spawn(process.execPath, [bin, ...args, '--server', server.href, '--token-stdin', ...(json ? ['--json'] : [])], {
    env: { ...process.env, EVOLINK_CLI_HOME: home, EVOLINK_CLI_UPDATE_CHECK: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end('fixture-failed-task-token');
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  return { code, stdout, stderr, ...(json ? { view: JSON.parse(stdout) } : {}) };
}

function failedTask(id, gatewayCode, message = GATEWAY) {
  return { task_id: id, status: 'failed', type: 'video', model: 'fixture-video', progress: 100,
    ...(gatewayCode === undefined ? {} : { error: { code: gatewayCode, message } }) };
}

test('tasks get reports the user-facing code, EvoLink explanation and the failed-task charge', async t => {
  const home = await homeFor(t);
  const f = await fixture(); t.after(f.close);
  for (const [i, [gatewayCode, code]] of CASES.entries()) {
    f.tasks.set(`failed-${i}`, failedTask(`failed-${i}`, gatewayCode));
    const result = await cli(home, ['tasks', 'get', `failed-${i}`], { server: f.server });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.view.ok, true); assert.equal(result.view.status, 'failed');
    assert.equal(result.view.error.code, code, String(gatewayCode));
    assert.equal(result.view.error.message, shownFor(gatewayCode));
    assert.equal(result.view.billing_note, NOT_CHARGED);
    assert.ok(result.view.text.includes(`Error: ${code} — ${shownFor(gatewayCode)}\n`));
    assert.ok(result.view.text.includes(NOT_CHARGED));
    assert.doesNotMatch(result.view.text, /verify billing|cannot be verified/);
    assert.doesNotMatch(result.stdout + result.stderr, LEAKS);
  }
  f.tasks.set('cancelled-task', { task_id: 'cancelled-task', status: 'cancelled', type: 'video', model: 'fixture-video' });
  const cancelled = await cli(home, ['tasks', 'get', 'cancelled-task'], { server: f.server });
  assert.equal(cancelled.view.error.code, 'request_cancelled');
  assert.equal(cancelled.view.error.message, 'Generation did not complete (request_cancelled).');
  assert.equal(cancelled.view.billing_note, undefined);
  assert.match(cancelled.view.text, /cannot be verified from the available billing evidence/);
  assert.equal(f.paid.size, 0);
});

test('tasks wait names the error code in JSON and text modes and keeps the explanation', async t => {
  const home = await homeFor(t);
  const f = await fixture(); t.after(f.close);
  for (const [i, [gatewayCode, code]] of CASES.entries()) {
    f.tasks.set(`wait-${i}`, failedTask(`wait-${i}`, gatewayCode));
    const json = await cli(home, ['tasks', 'wait', `wait-${i}`], { server: f.server });
    assert.equal(json.code, 1);
    assert.equal(json.view.ok, false); assert.equal(json.view.error.code, 'task_failed');
    assert.equal(json.view.error.message, `The generation task failed with error code ${code}.`);
    assert.equal(json.view.error.details.task.error.code, code);
    assert.equal(json.view.error.details.task.error.message, shownFor(gatewayCode));
    assert.equal(json.view.error.details.task.billing_note, NOT_CHARGED);
    assert.doesNotMatch(json.stdout + json.stderr, LEAKS);
    const text = await cli(home, ['tasks', 'wait', `wait-${i}`], { server: f.server, json: false });
    assert.equal(text.code, 1); assert.equal(text.stdout, '');
    assert.ok(text.stderr.startsWith(`task_failed: The generation task failed with error code ${code}.\n`), text.stderr);
    assert.ok(text.stderr.includes(NOT_CHARGED));
    assert.ok(text.stderr.includes(shownFor(gatewayCode)));
    assert.doesNotMatch(text.stderr, LEAKS);
  }
  // The EvoLink upload guide in a gateway explanation survives the error projection of tasks wait.
  f.tasks.set('wait-docs', failedTask('wait-docs', 'image_processing_error',
    `Your input media URL is invalid. If it remains inaccessible, upload the file through EvoLink: https: //evolink.ai/docs/en/api-manual/file-series/upload-url`));
  const docs = await cli(home, ['tasks', 'wait', 'wait-docs'], { server: f.server });
  assert.equal(docs.view.error.details.task.error.message,
    `Your input media URL is invalid. If it remains inaccessible, upload the file through EvoLink: ${UPLOAD_DOCS}`);
  f.tasks.set('wait-cancelled', { task_id: 'wait-cancelled', status: 'cancelled', type: 'video', model: 'fixture-video' });
  const cancelled = await cli(home, ['tasks', 'wait', 'wait-cancelled'], { server: f.server });
  assert.equal(cancelled.view.error.message, 'The generation task was cancelled with error code request_cancelled.');
  assert.equal(cancelled.view.error.details.task.billing_note, undefined);
  assert.equal(f.paid.size, 0);
});

test('tasks list shows each failed row with the user-facing code', async t => {
  const home = await homeFor(t);
  const f = await fixture(); t.after(f.close);
  for (const [i, [gatewayCode]] of CASES.entries()) f.tasks.set(`row-${i}`, failedTask(`row-${i}`, gatewayCode));
  f.tasks.set('row-processing', { task_id: 'row-processing', status: 'processing', type: 'video', model: 'fixture-video' });
  const result = await cli(home, ['tasks', 'list', '--limit', '50'], { server: f.server });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  for (const [i, [, code]] of CASES.entries()) {
    assert.equal(result.view.tasks.find(row => row.task_id === `row-${i}`).error_code, code, `row-${i}`);
  }
  assert.equal(result.view.tasks.find(row => row.task_id === 'row-processing').error_code, undefined);
  // List rows carry codes only; the explanation is read with tasks get.
  assert.doesNotMatch(result.stdout + result.stderr, /channel_|secret\.upstream|GATEWAY_PROSE_SENTINEL|"error_code":"failed"/);
  const batch = f.restCalls.filter(call => call.path === '/v1/tasks/batch');
  assert.equal(batch.length, 1, 'failed rows are read in one batch');
});
