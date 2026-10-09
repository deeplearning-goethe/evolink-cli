import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateCommand, dispatch } from '../src/cli.mjs';
import { errorView } from '../src/errors.mjs';
import { installSkill } from '../src/skills.mjs';
import { fixture } from './fixture.mjs';

const statuses = ['processing', 'completed', 'failed', 'cancelled'];
const bin = fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
const skillPath = fileURLToPath(new URL('../skills/evolink-cli/SKILL.md', import.meta.url));

async function homeFor(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-task-help-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

async function cli(home, args, { server, json = true, token = '' } = {}) {
  const child = spawn(process.execPath, [bin, ...args, ...(server ? ['--server', server.href] : []),
    '--token-stdin', ...(json ? ['--json'] : [])], {
    env: { ...process.env, EVOLINK_CLI_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(token);
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise((resolve, reject) => {
    child.once('close', resolve); child.once('error', reject);
  });
  if (json) assert.equal(stdout.trim().split('\n').length, 1);
  return { code, stdout, stderr, ...(json ? { view: JSON.parse(stdout) } : {}) };
}

test('general and task-list help work without login, token or state in text and JSON modes', async t => {
  const home = await homeFor(t);
  for (const args of [[], ['--help'], ['tasks', 'list', '--help']]) for (const json of [false, true]) {
    const result = await cli(home, args, { json });
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    const help = json ? result.view.help : result.stdout;
    if (json) { assert.equal(result.view.ok, true); assert.equal(result.view.schema_version, 1); }
    assert.ok(help.includes(`Allowed task status filters: ${statuses.join(', ')}.`));
    assert.match(help, /processing includes queued tasks/);
    assert.match(help, /pending and queued are not filter values/);
    assert.match(help, /Omit --status/);
    assert.match(help, /evolink tasks list --status processing --json/);
    if (args[0] === 'tasks') {
      assert.match(help, /^Usage: evolink tasks list/);
      assert.match(help, /Integer from 1 to 50 \(default 20\)/);
      assert.match(help, /ISO 8601, Unix seconds, or 30m, 2h, 1d/);
      assert.match(help, /returned task status can be pending/);
      assert.match(help, /does not search all history/);
      assert.match(help, /empty list does not prove/);
      assert.match(help, /does not provide a cancel command/);
    }
  }
  assert.deepEqual(await fs.readdir(home), []);
});

test('240 task-list filter combinations preserve the documented MCP contract and defaults', async () => {
  let count = 0;
  for (const status of [undefined, ...statuses]) for (const type of [undefined, 'image', 'video', 'audio'])
    for (const since of [undefined, '30m', '2026-10-09T00:00:00Z', '1791504000']) for (const limit of [undefined, '1', '50']) {
      const options = Object.fromEntries(Object.entries({ status, type, since, limit }).filter(([, value]) => value !== undefined));
      validateCommand(['tasks', 'list'], options);
      const calls = [];
      const result = await dispatch(['tasks', 'list'], options, { state: {}, server: new URL('http://127.0.0.1/mcp'),
        mcp: { call: async (name, args) => { calls.push({ name, args }); return { tasks: [] }; } } });
      assert.deepEqual(calls, [{ name: 'list_tasks', args: { type, status, since, limit: limit === undefined ? 20 : Number(limit) } }]);
      assert.deepEqual(result, { tasks: [] }); count++;
    }
  assert.equal(count, 240);
});

test('seed 20261009: invalid statuses are rejected with actionable details for every media filter', async t => {
  const home = await homeFor(t);
  const f = await fixture(); t.after(f.close);
  let seed = 20261009;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const invalid = ['', 'pending', 'queued', 'all', 'canceled', 'Processing', 'COMPLETED', 'failed ', 'processing,completed'];
  for (let i = 0; i < 32; i++) invalid.push(`${statuses[random() % statuses.length]}-${random().toString(36)}`);
  for (const status of invalid) for (const type of [undefined, 'image', 'video', 'audio']) {
    assert.throws(() => validateCommand(['tasks', 'list'], { status, ...(type ? { type } : {}) }), error => {
      const view = errorView(error);
      assert.equal(view.code, 'invalid_status');
      assert.deepEqual(view.details.allowed_values, statuses);
      assert.equal(view.details.param, 'status'); assert.equal(view.details.value, status);
      assert.equal(view.details.queued_filter, 'processing'); assert.equal(view.details.request_sent, false);
      assert.match(view.details.next_step, /evolink tasks list --help/);
      return true;
    });
  }
  for (const status of ['pending', 'queued']) for (const type of [undefined, 'image', 'video', 'audio']) for (const json of [false, true]) {
    const result = await cli(home, ['tasks', 'list', '--status', status, ...(type ? ['--type', type] : [])], { server: f.server, json });
    assert.equal(result.code, 1);
    if (json) {
      assert.equal(result.stderr, ''); assert.equal(result.view.ok, false);
      assert.equal(result.view.error.code, 'invalid_status');
      assert.deepEqual(result.view.error.details.allowed_values, statuses);
      assert.equal(result.view.error.details.request_sent, false);
    } else {
      assert.equal(result.stdout, ''); assert.match(result.stderr, /^invalid_status:/);
      for (const allowed of statuses) assert.ok(result.stderr.includes(allowed));
      assert.match(result.stderr, /processing includes queued tasks/);
    }
  }
  assert.equal(f.calls.length, 0); assert.equal(f.paid.size, 0);
  assert.deepEqual(await fs.readdir(home), []);
});

test('real CLI forwards valid filters; pending and failed task outcomes remain successful query responses', async t => {
  const home = await homeFor(t);
  const f = await fixture(); t.after(f.close);
  f.tasks.set('queued-task', { task_id: 'queued-task', status: 'pending', type: 'video' });
  f.tasks.set('failed-task', { task_id: 'failed-task', status: 'failed', type: 'image' });
  for (const status of [undefined, ...statuses]) {
    const result = await cli(home, ['tasks', 'list', ...(status ? ['--status', status] : []), '--type', 'video', '--since', '30m', '--limit', '50'],
      { server: f.server, token: 'fixture-task-help-token' });
    assert.equal(result.code, 0); assert.equal(result.view.ok, true);
    assert.equal(f.calls.at(-1).name, 'list_tasks');
    assert.deepEqual(f.calls.at(-1).args, { ...(status ? { status } : {}), type: 'video', since: '30m', limit: 50 });
    // The fixture records filters but deliberately returns both response states unchanged.
    assert.deepEqual(result.view.tasks.map(task => task.status), ['pending', 'failed']);
  }
  assert.equal(f.paid.size, 0);
});

test('installed bundled skill carries setup and task-filter recovery guidance into all assistant directories', async t => {
  const home = await homeFor(t);
  const source = await fs.readFile(skillPath, 'utf8');
  const first = await installSkill({ home });
  assert.equal(first.installations.length, 4);
  for (const file of first.installations) {
    const text = await fs.readFile(file.path, 'utf8');
    assert.equal(text, source);
    for (const status of statuses) assert.ok(text.includes(`\`${status}\``));
    assert.match(text, /if command -v evolink/);
    assert.match(text, /missing command is not an EvoLink service failure/);
    assert.match(text, /pending.*queued.*canceled.*all/);
    assert.match(text, /allowed_values/);
    assert.match(text, /Updating the npm package alone does not refresh/);
  }
  assert.equal((await installSkill({ home })).updated, false);
});

test('POSIX setup preflight treats absence as normal and preserves an installed command failure', { skip: process.platform === 'win32' }, async t => {
  const home = await homeFor(t);
  const source = await fs.readFile(skillPath, 'utf8');
  const script = /```sh\n([\s\S]*?)\n```/.exec(source)[1];
  const run = async () => {
    const child = spawn('/bin/bash', ['-c', script], { env: { ...process.env, PATH: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    return { code, stdout, stderr };
  };
  const missing = await run();
  assert.equal(missing.code, 0); assert.equal(missing.stderr, '');
  assert.match(missing.stdout, /not installed or not on PATH/);
  const command = path.join(home, 'evolink');
  await fs.writeFile(command, '#!/bin/sh\nprintf "%s\\n" "fixture-version"\n', { mode: 0o700 });
  assert.deepEqual(await run(), { code: 0, stdout: 'fixture-version\n', stderr: '' });
  await fs.writeFile(command, '#!/bin/sh\nprintf "%s\\n" "fixture-runtime-failure" >&2\nexit 7\n');
  const broken = await run();
  assert.equal(broken.code, 7); assert.match(broken.stderr, /fixture-runtime-failure/);
});
