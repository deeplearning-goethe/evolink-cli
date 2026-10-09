import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { fixture, mediaSamples } from './fixture.mjs';
import { State } from '../src/state.mjs';
import { Credentials } from '../src/auth.mjs';
import { Mcp } from '../src/mcp.mjs';
import { Media } from '../src/media.mjs';
import { upload, download } from '../src/files.mjs';
import { publicURL } from '../src/network.mjs';
import { installSkill } from '../src/skills.mjs';

const bin = fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
async function cli(f, home, args, token = 'fixture-command-token') {
  const child = spawn(process.execPath, [bin, ...args, '--server', f.server.href, '--json', '--token-stdin'],
    { env: { ...process.env, EVOLINK_CLI_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(token);
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.ok(!stdout.includes(token)); assert.ok(!stderr.includes(token));
  assert.equal(stdout.trim().split('\n').length, 1);
  return { code, view: JSON.parse(stdout), stderr };
}
async function context(t) {
  const f = await fixture(); t.after(f.close);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-e2e-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const state = new State(home); const credentials = new Credentials({ server: f.server, state, token: 'fixture-command-token' });
  const mcp = new Mcp(credentials); const media = new Media({ mcp, state, server: f.server });
  return { f, home, state, mcp, media };
}

test('real CLI processes: discovery, quote, approval, generation, result and original download', async t => {
  const { f, home } = await context(t);
  assert.equal((await cli(f, home, ['balance'])).view.balance_credits, 1000);
  assert.equal((await cli(f, home, ['models', 'search', '--query', 'image', '--type', 'image'])).view.models[0].id, 'fixture-image');
  assert.equal((await cli(f, home, ['models', 'show', 'fixture-image'])).view.model, 'fixture-image');
  for (const kind of ['image', 'video', 'audio']) {
    f.bytes = mediaSamples[kind].bytes; f.contentType = mediaSamples[kind].type;
    const q = await cli(f, home, ['estimate', '--model', `fixture-${kind}`, '--input', JSON.stringify({ prompt: 'one output', quality: 'high', n: 2 }), '--max-cost-usd', '0.10']);
    assert.equal(q.view.ok, true); assert.equal(q.view.requires_confirmation, true);
    assert.ok(!q.view._binding); assert.ok(!JSON.stringify(q.view).includes('iVBORw0'));
    const before = f.paid.size;
    const refused = await cli(f, home, ['generate', kind, '--quote', q.view.quote_id]);
    assert.equal(refused.view.error.code, 'confirmation_required'); assert.equal(f.paid.size, before);
    const badWait = await cli(f, home, ['generate', kind, '--quote', q.view.quote_id, '--confirm', '--wait', '--timeout', 'NaN']);
    assert.equal(badWait.view.error.code, 'invalid_option'); assert.equal(f.paid.size, before);
    const task = await cli(f, home, ['generate', kind, '--quote', q.view.quote_id, '--confirm']);
    assert.equal(task.view.ok, true); assert.equal(f.paid.size, before + 1);
    const waited = await cli(f, home, ['tasks', 'wait', task.view.task_id]); assert.equal(waited.view.status, 'completed');
    const output = path.join(home, `${kind}.bin`);
    const downloaded = await cli(f, home, ['download', task.view.task_id, '--output', output]);
    assert.equal(downloaded.view.ok, true); assert.deepEqual(await fs.readFile(output), f.bytes);
    const overwrite = await cli(f, home, ['download', task.view.task_id, '--output', output]); assert.equal(overwrite.view.error.code, 'file_exists');
  }
  const list = await cli(f, home, ['tasks', 'list', '--since', '30m']); assert.equal(list.view.tasks.length, 3);
  assert.equal(f.downloads.length, 3);
  assert.ok(f.downloads.every(h => !h.authorization && !h.cookie && h['user-agent'].startsWith('EvoLinkCLI/')));
});

test('lost paid reply: persisted journal and replay recover exactly one task', async t => {
  const { f, state, media } = await context(t);
  const q = await media.estimate({ model: 'fixture-image', input: { prompt: 'uncertain reply' }, max_cost_usd: 0.03 });
  f.beforeSubmit = async args => {
    const stored = await state.read('quotes', q.quote_id);
    assert.equal(stored.state, 'submitting'); assert.equal(stored.client_request_id, args.client_request_id);
  };
  f.loseSubmission = true;
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), { code: 'connection_failed' });
  assert.equal(f.paid.size, 1); assert.equal((await state.read('quotes', q.quote_id)).state, 'outcome_unknown');
  const recovered = await media.resume(q.quote_id);
  assert.equal(f.paid.size, 1); assert.equal(recovered.task_id, [...f.paid.values()][0]);
  assert.equal(new Set(f.calls.filter(c => c.name === 'generate_image').map(c => c.args.client_request_id)).size, 1);
});

test('real MCP responses for invalid input, price changes and incomplete caps block submission', async t => {
  const { f, media } = await context(t);
  await assert.rejects(media.estimate({ model: 'fixture-image', input: { invalid: true } }), { code: 'invalid_input' });
  await assert.rejects(media.estimate({ model: 'fixture-image', input: { insufficient: true } }), { code: 'insufficient_balance' });
  await assert.rejects(media.estimate({ model: 'fixture-image', input: { n: 10 }, max_cost_usd: 0.10 }), { code: 'cost_exceeds_cap' });
  for (const model of ['fixture-token-image', 'fixture-partial-image']) await assert.rejects(media.estimate({ model, input: { prompt: 'test' }, max_cost_usd: 1 }), { code: 'uncheckable_cap' });
  const q = await media.estimate({ model: 'fixture-image', input: { prompt: 'fresh quote' } });
  f.multiplier = 2;
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), { code: 'price_changed' });
  assert.equal(f.paid.size, 0);
});

test('one-time reference upload streams bytes without forwarding OAuth credentials', async t => {
  const { f, home, state, mcp } = await context(t);
  const file = path.join(home, 'reference.png'); await fs.writeFile(file, f.bytes);
  const result = await upload(file, { mcp, state, server: f.server });
  assert.equal(result.state, 'done'); assert.equal(result.size_bytes, f.bytes.length);
  assert.equal(f.uploadHeaders[0].authorization, undefined); assert.equal(f.uploadHeaders[0].cookie, undefined);
  assert.equal(f.uploadHeaders[0]['content-length'], String(f.bytes.length));
  const saved = await fs.readFile(state.file('uploads', result.upload_id), 'utf8');
  assert.ok(!saved.includes('one-time-fixture-token')); assert.ok(!saved.includes('upload_url'));
  f.loseUploadReply = true;
  const recovered = await upload(file, { mcp, state, server: f.server });
  assert.equal(recovered.state, 'done'); assert.equal(f.uploadHeaders.length, 2);
  const prepared = await mcp.call('prepare_upload', { file_name: 'waiting.png' });
  const waiting = await cli(f, home, ['uploads', 'get', prepared.upload_id]);
  assert.equal(waiting.view.state, 'waiting');
  assert.ok(!JSON.stringify(waiting).includes('one-time-fixture-token'));
});

test('download size limits and unsafe URLs leave no partial output', async t => {
  const { f, home, media, mcp } = await context(t);
  const q = await media.estimate({ model: 'fixture-image', input: { prompt: 'download' } });
  const result = await media.generate('image', q.quote_id, { confirmed: true });
  const output = path.join(home, 'limited.png');
  await assert.rejects(download(result.task_id, output, { mcp, server: f.server, maxBytes: 1 }), { code: 'download_too_large' });
  f.chunkedDownload = true;
  await assert.rejects(download(result.task_id, output, { mcp, server: f.server, maxBytes: 8 }), { code: 'download_too_large' });
  assert.equal((await fs.readdir(home)).some(n => n.endsWith('.part') || n === 'limited.png'), false);
  for (const url of ['file:///etc/passwd', 'http://example.com/a.png', 'https://127.0.0.1/a.png', 'https://user:pass@example.com/a.png']) await assert.rejects(publicURL(url));
});

test('interrupted local wait preserves the running task and never generates again', async t => {
  const { f, home, state, mcp, media } = await context(t); f.immediate = false;
  const q = await media.estimate({ model: 'fixture-video', input: { prompt: 'wait' } });
  const result = await media.generate('video', q.quote_id, { confirmed: true });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(media.wait(result.task_id, { signal: controller.signal }), { code: 'interrupted' });
  assert.equal(f.paid.size, 1); assert.equal(f.tasks.get(result.task_id).status, 'processing');
  assert.equal((await state.read('quotes', q.quote_id)).task_id, result.task_id);
  const current = f.tasks.get(result.task_id); current.status = 'completed';
  assert.equal((await media.wait(result.task_id)).status, 'completed');
  const unrelated = await cli(f, home, ['tasks', 'get', randomID()]); assert.equal(unrelated.view.ok, false);
  assert.equal(f.paid.size, 1);
});
function randomID() { return '00000000-0000-4000-8000-000000000000'; }

test('skill installation uses bundled content and protects another skill', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-skill-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const first = await installSkill({ home }); assert.equal(first.updated, false);
  assert.equal(first.installations.length, 4);
  assert.equal(await fs.readFile(first.installations[0].path, 'utf8'), await fs.readFile(first.installations[1].path, 'utf8'));
  assert.equal((await installSkill({ home })).updated, true);
  await fs.writeFile(first.path, 'a different user skill');
  await assert.rejects(installSkill({ home }), { code: 'skill_conflict' });
  assert.equal(await fs.readFile(first.path, 'utf8'), 'a different user skill');
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-skill-one-')); t.after(() => fs.rm(other, { recursive: true, force: true }));
  const selected = await installSkill({ home: other, agent: 'claude-code' });
  assert.equal(selected.installations.length, 1); assert.ok(selected.path.includes('.claude'));
  for (const [agent, directory] of [['codex', '.agents'], ['cursor', '.agents'], ['gemini', '.agents'], ['opencode', '.agents'],
    ['copilot', '.agents'], ['openclaw', '.openclaw'], ['hermes', '.hermes']]) {
    const installed = await installSkill({ home: other, agent });
    assert.equal(installed.installations.length, 1);
    assert.equal(installed.path, path.join(other, directory, 'skills/evolink-cli/SKILL.md'));
  }
  await assert.rejects(installSkill({ home: other, agent: 'unknown' }), { code: 'invalid_agent' });
  // An unrelated skill at a later destination prevents updating any earlier file.
  const protectedHome = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-skill-conflict-'));
  t.after(() => fs.rm(protectedHome, { recursive: true, force: true }));
  const installed = await installSkill({ home: protectedHome });
  const last = installed.installations.at(-1).path;
  await fs.writeFile(last, 'another skill');
  await fs.writeFile(installed.path, '---\nname: evolink-cli\n---\n<!-- evolink-media-cli-owned -->\nprevious version');
  await assert.rejects(installSkill({ home: protectedHome }), { code: 'skill_conflict' });
  assert.ok((await fs.readFile(installed.path, 'utf8')).endsWith('previous version'));
});
