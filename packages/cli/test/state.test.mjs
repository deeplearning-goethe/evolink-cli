import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { State } from '../src/state.mjs';
import { Vault } from '../src/auth.mjs';

const moduleURL = new URL('../src/state.mjs', import.meta.url).href;

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
