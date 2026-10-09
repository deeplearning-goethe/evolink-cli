import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dispatch, validateCommand } from '../src/cli.mjs';
import { State } from '../src/state.mjs';
import { downloadAll, downloadNames } from '../src/files.mjs';
import { fixture } from './fixture.mjs';

const bin = fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
async function homeFor(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-capabilities-'));
  t.after(() => fs.rm(home, { force: true, recursive: true })); return home;
}
async function cli(home, args, server) {
  const child = spawn(process.execPath, [bin, ...args, '--json', ...(server ? ['--server', server.href, '--token-stdin'] : [])], {
    env: { ...process.env, EVOLINK_CLI_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(server ? 'fixture-only-token' : '');
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  assert.equal(stdout.trim().split('\n').length, 1, stderr);
  return { code, view: JSON.parse(stdout), stderr };
}

test('command-specific structured help needs no login and documents schema, coverage and budget limits', async t => {
  const home = await homeFor(t);
  for (const args of [['models', 'schema', 'a-model'], ['models', 'recommend'], ['docs', 'search'], ['usage'], ['download', 'a-task'], ['estimate']]) {
    const result = await cli(home, [...args, '--help']);
    assert.equal(result.code, 0); assert.equal(result.view.command, args.slice(0, args[0] === 'models' || args[0] === 'docs' ? 2 : 1).join(' '));
    assert.ok(result.view.usage.startsWith('evolink ')); assert.ok(result.view.options);
  }
  assert.deepEqual(await fs.readdir(home), []);
  for (const group of ['auth', 'models', 'tasks', 'generate', 'skills', 'docs', 'uploads']) {
    const result = await cli(home, [group, '--help']); assert.equal(result.code, 0); assert.ok(result.view.subcommands.length);
  }
  const help = (await cli(home, ['tasks', 'list', '--help'])).view;
  assert.equal(help.options.page.maximum, 100000);
  assert.deepEqual(help.options.status.allowed_values, ['processing', 'completed', 'failed', 'cancelled']);
});

test('seed 20261009: new page/model/until combinations are forwarded without losing existing filters', async () => {
  let seed = 20261009;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let i = 0; i < 96; i++) {
    const page = String(1 + random() % 100), model = ['model-a', 'model-b'][random() % 2];
    const options = { page, model, until: '2026-10-09T00:00:00Z', since: '30d', limit: ['1', '20', '50'][random() % 3] };
    validateCommand(['tasks', 'list'], options);
    const calls = [];
    await dispatch(['tasks', 'list'], options, { state: {}, server: new URL('http://127.0.0.1/mcp'), mcp: { call: async (...args) => { calls.push(args); return {}; } } });
    assert.equal(calls[0][0], 'list_tasks'); assert.equal(calls[0][1].page, Number(page)); assert.equal(calls[0][1].model, model);
    assert.equal(calls[0][1].until, options.until); assert.equal(calls[0][1].since, options.since);
    assert.equal(calls[0][2].requireCapability, true);
    assert.deepEqual(calls[0][2].requiredInputs.sort(), ['model', 'page', 'until']);
  }
});

test('updated CLI refuses missing service tools and missing page schema before calling a tool', async t => {
  const home = await homeFor(t); const f = await fixture(); t.after(f.close);
  for (const args of [['usage'], ['docs', 'search', '--query', 'voice'], ['tasks', 'list', '--page', '2']]) {
    const result = await cli(home, args, f.server);
    assert.equal(result.code, 1); assert.equal(result.view.error.code, 'capability_unavailable');
    assert.equal(result.view.error.details.request_sent, false);
  }
  f.tools = [{ name: 'list_tasks', inputSchema: { type: 'object', properties: {} } }];
  assert.equal((await cli(home, ['tasks', 'list', '--page', '2'], f.server)).view.error.code, 'capability_unavailable');
  assert.equal(f.calls.length, 0); assert.equal(f.paid.size, 0);
});

test('real CLI executes advertised discovery, usage, pagination and legacy batch queries', async t => {
  const home = await homeFor(t); const f = await fixture(); t.after(f.close);
  f.tools = ['get_task_usage', 'recommend_models', 'search_docs', 'list_tasks'].map(name => ({ name, inputSchema: { type: 'object', properties: { page: {}, model: {}, until: {} } } }));
  f.responses = {
    get_task_usage: args => ({ scope: 'account_retained_task_summary', is_bill: false, args }),
    recommend_models: args => ({ models: [], args }), search_docs: args => ({ documents: [], args }),
  };
  for (const args of [['usage', '--max-pages', '2'], ['models', 'recommend', '--type', 'video', '--references', 'image,audio'], ['docs', 'search', '--query', 'voice'],
    ['tasks', 'list', '--page', '3', '--model', 'a-model'], ['tasks', 'batch', '--ids', 'task-one,task-two,task-one']]) {
    const result = await cli(home, args, f.server); assert.equal(result.code, 0, JSON.stringify(result));
  }
  assert.deepEqual(f.calls.at(-1), { name: 'list_tasks', args: { task_ids: ['task-one', 'task-two'] } });
  assert.equal(f.paid.size, 0);
});

test('invalid new enum, range and mutually exclusive options are rejected locally', () => {
  for (const [args, options] of [[['usage'], { 'max-pages': '21' }], [['tasks', 'list'], { page: '0' }], [['models', 'recommend'], { type: 'all' }],
    [['models', 'recommend'], { type: 'image', references: 'picture' }], [['tasks', 'batch'], { ids: 'a' }],
    [['download', 'task-one'], { all: true, output: 'x', 'output-dir': 'y' }], [['download', 'task-one'], { output: 'x', resume: true }]]) {
    assert.throws(() => validateCommand(args, options));
  }
  assert.throws(() => validateCommand(['tasks', 'cancel', 'task-one'], {}), /Unknown command/);
});

test('all original results download once; resume verifies digests and rejects changed files', async t => {
  const home = await homeFor(t); const f = await fixture(); t.after(f.close);
  f.tasks.set('multi-task', { task_id: 'multi-task', status: 'completed', results: [1, 2].map(n => ({ url: `${f.origin}/assets/${n}.png`, kind: 'image' })) });
  const mcp = { call: async (name, args) => { assert.equal(name, 'get_task'); return f.tasks.get(args.task_id); } };
  const state = new State(path.join(home, 'state')), directory = path.join(home, 'output');
  const first = await downloadAll('multi-task', directory, { state, mcp, server: f.server });
  assert.equal(first.ok, true); assert.equal(first.files.length, 2); assert.equal(f.downloads.length, 2);
  assert.ok(first.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  await assert.rejects(downloadAll('multi-task', directory, { state, mcp, server: f.server }), error => error.code === 'delivery_exists');
  const resumed = await downloadAll('multi-task', directory, { state, mcp, server: f.server, resume: true });
  assert.equal(resumed.ok, true); assert.ok(resumed.files.every(file => file.verified_existing)); assert.equal(f.downloads.length, 2);
  const original = await fs.readFile(first.files[0].path); original[original.length - 1] ^= 1; await fs.writeFile(first.files[0].path, original);
  const changed = await downloadAll('multi-task', directory, { state, mcp, server: f.server, resume: true });
  assert.equal(changed.ok, false); assert.equal(changed.failures[0].error.code, 'saved_file_changed'); assert.equal(f.downloads.length, 2);
});

test('partial download failure preserves successful receipts and resumes only the remainder', async t => {
  const home = await homeFor(t); const f = await fixture(); t.after(f.close);
  f.tasks.set('multi-task', { task_id: 'multi-task', status: 'completed', results: [1, 2, 3].map(n => ({ url: `${f.origin}/assets/${n}.png`, kind: 'image' })) });
  const mcp = { call: async (name, args) => f.tasks.get(args.task_id) }, state = new State(path.join(home, 'state'));
  let breakSecond = true; const seen = [];
  const fetchFn = async (url, init) => { seen.push(new URL(url).pathname); if (breakSecond && String(url).includes('/2.png')) return new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }); return fetch(url, init); };
  const opts = { mcp, state, server: f.server, fetchFn };
  const directory = path.join(home, 'output');
  const first = await downloadAll('multi-task', directory, opts);
  assert.equal(first.ok, false); assert.equal(first.generation_status, 'completed'); assert.equal(first.delivery_status, 'partial');
  assert.deepEqual(first.files.map(file => file.result_index), [1, 3]); assert.equal(first.failures[0].error.code, 'invalid_download_content');
  breakSecond = false;
  const resumed = await downloadAll('multi-task', directory, { ...opts, resume: true });
  assert.equal(resumed.ok, true); assert.deepEqual(seen, ['/assets/1.png', '/assets/2.png', '/assets/3.png', '/assets/2.png']);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['multi-task-1.png', 'multi-task-2.png', 'multi-task-3.png']);
});

test('real all-download partial delivery exits nonzero and never submits a paid task', async t => {
  const home = await homeFor(t); const f = await fixture(); t.after(f.close);
  f.bytes = Buffer.from('<html>error</html>'); f.contentType = 'text/html';
  f.tasks.set('multi-task', { task_id: 'multi-task', status: 'completed', results: [{ url: `${f.origin}/assets/1.png`, kind: 'image' }] });
  const result = await cli(home, ['download', 'multi-task', '--all', '--output-dir', path.join(home, 'output')], f.server);
  assert.equal(result.code, 1); assert.equal(result.view.ok, false); assert.equal(result.view.generation_status, 'completed');
  assert.equal(f.paid.size, 0); assert.deepEqual(await fs.readdir(path.join(home, 'output')), []);
});

test('portable templates reject traversal, collisions and unknown placeholders', () => {
  const results = [1, 2].map(n => ({ kind: 'image', url: `https://files.example/${n}.png?signature=example` }));
  assert.deepEqual(downloadNames('a:task', results), ['a_task-1.png', 'a_task-2.png']);
  for (const template of ['../x-{index}', 'x\\{index}', '{unknown}', 'same.png', 'CON.png', 'x..{index}']) {
    assert.throws(() => downloadNames('a-task', results, template));
  }
});

test('delivery restores both sides of the atomic-file/receipt commit window without overwriting files', async t => {
  const home = await homeFor(t); const f = await fixture(); t.after(f.close);
  const task = { task_id: 'commit-task', status: 'completed', results: [{ kind: 'image', url: `${f.origin}/assets/1.png` }] };
  const mcp = { call: async () => task };
  for (const afterPublication of [false, true]) {
    const state = new State(path.join(home, `state-${afterPublication}`));
    const directory = path.join(home, `output-${afterPublication}`), write = state.write.bind(state);
    let failOnce = true;
    state.write = async (group, id, receipt) => {
      if (failOnce && receipt.files?.length && receipt.files[0].pending_commit === !afterPublication) {
        failOnce = false;
        if (!afterPublication) await write(group, id, receipt);
        throw new Error('fixture interruption at commit');
      }
      return write(group, id, receipt);
    };
    const before = f.downloads.length;
    assert.equal((await downloadAll('commit-task', directory, { state, mcp, server: f.server })).ok, false);
    state.write = write;
    const resumed = await downloadAll('commit-task', directory, { state, mcp, server: f.server, resume: true });
    assert.equal(resumed.ok, true);
    assert.equal(f.downloads.length - before, afterPublication ? 1 : 2);
    assert.equal(resumed.files[0].verified_existing, afterPublication ? true : undefined);
    assert.equal((await fs.readdir(directory)).length, 1);
  }
});
