// Runs the real, locally installed Codex CLI against the mock gateway, in a throwaway HOME, with the
// profile written by `evolink setup codex`. Confirms Codex picks the profile up and talks the Responses API through it.
//
//   node test/real_codex_check.mjs [path-to-codex]
//
// Nothing outside the temporary HOME is touched; the key is fake and the gateway is local.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockGateway } from './mock-server.mjs';

const CLI = fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
const CODEX = process.argv[2] || 'codex';
const KEY = `sk-${'Rx4Cd3Ex'.repeat(6)}`;

function run(cmd, args, env, timeoutMs = 150000) {
  return new Promise((resolve) => {
    // stdin closed: `codex exec` reads a prompt from a piped stdin.
    const child = spawn(cmd, args, { env, cwd: env.HOME, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

const gw = await startMockGateway({ keys: { [KEY.slice(3)]: { models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.5', 'gpt-image-2'] } } });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-real-codex-'));
// Codex sends even 127.0.0.1 through a macOS system proxy unless told otherwise.
const baseEnv = { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };

// No --model: setup picks Codex's own default when the key has it.
const setup = await run(process.execPath, [CLI, 'setup', 'codex', '--yes', '--no-install', '--no-test'], {
  ...baseEnv,
  NO_COLOR: '1',
  EVOLINK_API_KEY: KEY,
  EVOLINK_BASE_URL: gw.url,
});
console.log(`evolink setup codex exit=${setup.code}`);

const version = await run(CODEX, ['--version'], baseEnv, 30000);
console.log(`codex --version: ${(version.out || version.err).trim()}`);

const before = gw.requests.length;
// A stale OpenAI key in the shell environment must not reach EvoLink.
const codex = await run(CODEX, ['exec', '-p', 'evolink', '--skip-git-repo-check', 'Reply with exactly: OK'], { ...baseEnv, OPENAI_API_KEY: 'sk-stale-openai-key-000' });
console.log(`codex exec -p evolink exit=${codex.code}`);
console.log(`stdout: ${codex.out.slice(0, 400)}`);
if (codex.err.trim()) console.log(`stderr (last lines): ${codex.err.trim().split('\n').slice(-8).join('\n  ')}`);

const reqs = gw.requests.slice(before);
console.log(`\nrequests seen by the mock gateway: ${reqs.length}`);
for (const q of reqs) {
  const auth = q.headers.authorization ? q.headers.authorization.replace(KEY, '<evolink key>') : '-';
  const tools = Array.isArray(q.body?.tools) ? q.body.tools.map((t) => t.name || t.type).join(',') : '-';
  console.log(`  ${q.method} ${q.path}${q.query}  model=${q.body?.model ?? '-'} stream=${q.body?.stream ?? '-'} auth=${auth} tools=${tools}`);
  if (q.body) console.log(`    body keys: ${Object.keys(q.body).join(', ')}`);
}
const resp = reqs.filter((q) => q.path === '/v1/responses');
const checks = {
  'setup succeeded': setup.code === 0,
  'codex reached the gateway on /v1/responses': resp.length > 0,
  'Bearer carries the EvoLink key': resp.length > 0 && resp.every((q) => q.headers.authorization === `Bearer ${KEY}`),
  'a stale OPENAI_API_KEY is never sent': reqs.every((q) => !String(q.headers.authorization || '').includes('stale')),
  "requests use Codex's own default model": resp.length > 0 && resp.every((q) => q.body?.model === 'gpt-6.1-sol'),
  'no hosted web_search tool is sent': resp.every((q) => !(q.body?.tools || []).some((t) => /web_search/.test(String(t.type || '')))),
  'codex printed OK': /\bOK\b/.test(codex.out),
  'the main config.toml was not created': !fs.existsSync(path.join(home, '.codex', 'config.toml')),
};
console.log('');
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'PASS' : 'FAIL'} ${k}`);
await gw.close();
fs.rmSync(home, { recursive: true, force: true });
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
