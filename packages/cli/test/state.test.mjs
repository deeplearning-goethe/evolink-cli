import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { State } from '../src/state.mjs';
import { Vault } from '../src/auth.mjs';

const moduleURL = new URL('../src/state.mjs', import.meta.url).href;
const hostID = createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);

test('renamed command retains default and legacy state and credential identity', () => {
  const current = process.env.EVOLINK_CLI_HOME;
  const legacy = process.env.EVOLINK_MEDIA_HOME;
  try {
    delete process.env.EVOLINK_CLI_HOME;
    delete process.env.EVOLINK_MEDIA_HOME;
    const original = new State(path.join(os.homedir(), '.evolink-media'));
    assert.equal(new State().home, original.home);
    const server = new URL('https://mcp.evolink.ai/mcp');
    assert.equal(new Vault(server, new State()).account, new Vault(server, original).account);
    process.env.EVOLINK_MEDIA_HOME = path.join(os.tmpdir(), 'legacy-cli-state');
    assert.equal(new State().home, process.env.EVOLINK_MEDIA_HOME);
    process.env.EVOLINK_CLI_HOME = path.join(os.tmpdir(), 'renamed-cli-state');
    assert.equal(new State().home, process.env.EVOLINK_CLI_HOME);
  } finally {
    if (current === undefined) delete process.env.EVOLINK_CLI_HOME; else process.env.EVOLINK_CLI_HOME = current;
    if (legacy === undefined) delete process.env.EVOLINK_MEDIA_HOME; else process.env.EVOLINK_MEDIA_HOME = legacy;
  }
});

test('separate processes recover a dead owner and keep subsequent operations exclusive', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-lock-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  function start(code) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, home], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    return child;
  }
  const holder = start(`import { State } from ${JSON.stringify(moduleURL)};
    await new State(process.argv[1]).lock('shared', async () => {
      console.log('locked'); await new Promise(() => { setInterval(() => {}, 1000); });
    });`);
  await once(holder.stdout, 'data');
  holder.kill('SIGKILL'); await once(holder, 'close');
  // A crash inside recovery must not leave the next command permanently busy.
  const recovery = path.join(home, 'locks/shared.recovery');
  await fs.mkdir(recovery, { recursive: true });
  await fs.writeFile(path.join(recovery, `${hostID}.${holder.pid}.${randomUUID()}`), '');
  const work = String.raw`import { State } from ${JSON.stringify(moduleURL)};
    import * as fs from 'node:fs/promises'; import path from 'node:path';
    const trace = path.join(process.argv[1], 'trace');
    await new State(process.argv[1]).lock('shared', async () => {
      await fs.appendFile(trace, 'start\n');
      await new Promise(r => setTimeout(r, 80));
      await fs.appendFile(trace, 'end\n');
    });`;
  const workers = Array.from({ length: 6 }, () => start(work));
  const codes = await Promise.all(workers.map(async child => {
    let stderr = ''; child.stderr.on('data', b => { stderr += b; });
    const [code] = await once(child, 'close'); assert.equal(code, 0, stderr); return code;
  }));
  assert.equal(codes.length, 6);
  assert.equal(await fs.readFile(path.join(home, 'trace'), 'utf8'), 'start\nend\n'.repeat(6));
});

test('a live recovery ticket blocks entry until its owner exits; legacy empty guards do not block', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-recovery-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const recovery = path.join(home, 'locks/shared.recovery');
  const guard = spawn(process.execPath, ['--input-type=module', '-e', `
    import * as fs from 'node:fs/promises'; import path from 'node:path';
    await fs.mkdir(process.argv[1], { recursive: true });
    await fs.writeFile(path.join(process.argv[1], '${hostID}.' + process.pid + '.${randomUUID()}'), '');
    console.log('ready'); setInterval(() => {}, 1000);
  `, recovery], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (guard.exitCode === null) guard.kill(); });
  await once(guard.stdout, 'data');
  let entered = false;
  const run = new State(home).lock('shared', async () => { entered = true; });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(entered, false);
  guard.kill('SIGKILL'); await once(guard, 'close');
  await run; assert.equal(entered, true);
  await new State(home).lock('shared', async () => 'legacy guard reused');
});

test('an operation error is propagated once and never reruns the protected operation', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-lock-error-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let runs = 0;
  await assert.rejects(new State(home).lock('shared', async () => {
    runs++;
    throw Object.assign(new Error('missing result'), { code: 'ENOENT' });
  }), { code: 'ENOENT' });
  assert.equal(runs, 1);
  assert.equal(await new State(home).lock('shared', async () => 'next'), 'next');
});
