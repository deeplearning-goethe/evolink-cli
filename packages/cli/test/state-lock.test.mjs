import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { State } from '../src/state.mjs';

const moduleURL = new URL('../src/state.mjs', import.meta.url).href;
async function homeFor(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-lock-'));
  t.after(() => fs.rm(home, { recursive: true, force: true })); return home;
}
function worker(home, action) {
  return spawn(process.execPath, ['--input-type=module', '-e', `import { State } from ${JSON.stringify(moduleURL)};
    import * as fs from 'node:fs/promises';
    const state = new State(${JSON.stringify(home)}); await state.lock('shared', async () => { ${action} });`], { stdio: ['ignore', 'pipe', 'pipe'] });
}
function finished(child) {
  return new Promise((resolve, reject) => {
    let err = ''; child.stderr.on('data', b => err += b);
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, err }));
  });
}

test('crashed owners and crashed recovery guards do not block the next command', async t => {
  const home = await homeFor(t), child = worker(home, "console.log('locked'); await new Promise(() => {});");
  const exit = finished(child);
  await new Promise(resolve => child.stdout.once('data', resolve));
  child.kill('SIGKILL'); await exit;
  const guard = path.join(home, 'locks/shared.recovery');
  await fs.mkdir(guard);
  const hostID = createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);
  await fs.writeFile(path.join(guard, `${hostID}.${child.pid}.${randomUUID()}`), '');
  assert.equal(await new State(home).lock('shared', async () => 'recovered'), 'recovered');
  await assert.rejects(fs.stat(path.join(home, 'locks/shared')), { code: 'ENOENT' });
});

test('legacy empty recovery guards and dead owners recover without clearing saved request IDs', async t => {
  const home = await homeFor(t), state = new State(home);
  await state.write('quotes', 'retained', { client_request_id: 'same-id' });
  const child = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe'] });
  await finished(child);
  const dir = path.join(home, 'locks/shared'), guard = `${dir}.recovery`;
  await fs.mkdir(dir, { recursive: true }); await fs.mkdir(guard);
  await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify({ pid: child.pid, hostname: os.hostname() }));
  const age = new Date(Date.now() - 60_000); await fs.utimes(guard, age, age);
  await state.lock('shared', async () => {});
  assert.equal((await state.read('quotes', 'retained')).client_request_id, 'same-id');
});

test('multiple processes serialize repeated writes across a stale recovery guard', async t => {
  const home = await homeFor(t), counter = path.join(home, 'counter');
  await fs.writeFile(counter, '0');
  const dir = path.join(home, 'locks/shared.recovery'); await fs.mkdir(dir, { recursive: true });
  const age = new Date(Date.now() - 60_000); await fs.utimes(dir, age, age);
  const action = `const file = ${JSON.stringify(counter)};
    const current = Number(await fs.readFile(file, 'utf8'));
    await new Promise(r => setTimeout(r, 20));
    await fs.writeFile(file, String(current + 1));`;
  for (let round = 0; round < 3; round++) {
    const exits = await Promise.all(Array.from({ length: 8 }, () => finished(worker(home, action))));
    assert.ok(exits.every(e => e.code === 0), JSON.stringify(exits));
  }
  assert.equal(await fs.readFile(counter, 'utf8'), '24');
});
