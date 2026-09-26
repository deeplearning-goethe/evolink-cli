// Control experiment: the same stale ANTHROPIC_API_KEY, but settings.json WITHOUT the blank
// ANTHROPIC_API_KEY entry. Shows which headers Claude Code then sends to the gateway.
//
//   node test/real_claude_control.mjs [path-to-claude]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startMockGateway } from './mock-server.mjs';

const CLAUDE = process.argv[2] || path.join(os.homedir(), '.local', 'bin', 'claude');
const KEY = `sk-${'Ct4Rl0ab'.repeat(6)}`;
const STALE = `sk-${'St4Le0ld'.repeat(6)}`;

const gw = await startMockGateway({ keys: { [KEY.slice(3)]: {} } });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-control-'));
fs.mkdirSync(path.join(home, '.claude'));
fs.writeFileSync(
  path.join(home, '.claude', 'settings.json'),
  JSON.stringify({ env: { ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_AUTH_TOKEN: KEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }, null, 2),
);
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));

const env = { HOME: home, PATH: '/usr/bin:/bin', TERM: 'xterm-256color', DISABLE_AUTOUPDATER: '1', ANTHROPIC_API_KEY: STALE };
const res = await new Promise((resolve) => {
  const child = spawn(CLAUDE, ['-p', 'Reply with exactly: OK', '--model', 'claude-haiku-4-5-20251001'], { env, cwd: home });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const t = setTimeout(() => child.kill('SIGTERM'), 60000);
  child.on('close', (code) => {
    clearTimeout(t);
    resolve({ code, out });
  });
});
console.log(`claude -p exit=${res.code}  output: ${res.out.trim().slice(0, 300)}`);
for (const q of gw.requests.filter((r) => r.path === '/v1/messages')) {
  const mask = (v) => (v === undefined ? '(absent)' : v.replace(KEY, '<evolink key>').replace(STALE, '<stale shell key>'));
  console.log(`  POST /v1/messages  authorization=${mask(q.headers.authorization)}  x-api-key=${mask(q.headers['x-api-key'])}  key used by gateway=${q.keyUsed === KEY.slice(3) ? 'evolink key' : q.keyUsed === STALE.slice(3) ? 'STALE key' : q.keyUsed}`);
}
await gw.close();
fs.rmSync(home, { recursive: true, force: true });
