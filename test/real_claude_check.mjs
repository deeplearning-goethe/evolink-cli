// Runs the real, locally installed Claude Code against the mock gateway, in a throwaway HOME,
// with the settings written by `evolink setup`. Confirms Claude Code picks the config up.
//
//   node test/real_claude_check.mjs [path-to-claude]
//
// Nothing outside the temporary HOME is touched; the key is fake and the gateway is local.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockGateway } from './mock-server.mjs';

const CLI = fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
const CLAUDE = process.argv[2] || path.join(os.homedir(), '.local', 'bin', 'claude');
const KEY = `sk-${'Rc3Cl0de'.repeat(6)}`;

function run(cmd, args, env, timeoutMs = 90000) {
  return new Promise((resolve) => {
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

const gw = await startMockGateway({ keys: { [KEY.slice(3)]: {} } });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-real-claude-'));
const baseEnv = { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

const setup = await run(process.execPath, [CLI, 'setup', '--yes', '--no-install', '--no-test', '--model', 'claude-sonnet-5'], {
  ...baseEnv,
  NO_COLOR: '1',
  EVOLINK_API_KEY: KEY,
  EVOLINK_BASE_URL: gw.url,
});
console.log(`evolink setup exit=${setup.code}`);

const before = gw.requests.length;
// Stale key in the shell environment, as left behind by an old tutorial or another vendor.
const claude = await run(CLAUDE, ['-p', 'Reply with exactly: OK', '--output-format', 'json'], { ...baseEnv, DISABLE_AUTOUPDATER: '1', ANTHROPIC_API_KEY: 'sk-stale-shell-key-000' });
console.log(`claude -p exit=${claude.code}`);
console.log(`stdout: ${claude.out.slice(0, 400)}`);
if (claude.err.trim()) console.log(`stderr: ${claude.err.slice(0, 400)}`);

const reqs = gw.requests.slice(before);
console.log(`\nrequests seen by the mock gateway: ${reqs.length}`);
for (const q of reqs) {
  const auth = q.headers.authorization ? q.headers.authorization.replace(KEY, '<evolink key>') : '-';
  const xkey = q.headers['x-api-key'] === undefined ? '(absent)' : q.headers['x-api-key'] === '' ? '(empty)' : q.headers['x-api-key'].replace(KEY, '<evolink key>');
  console.log(`  ${q.method} ${q.path}${q.query}  model=${q.body?.model ?? '-'} max_tokens=${q.body?.max_tokens ?? '-'} stream=${q.body?.stream ?? '-'} auth=${auth} x-api-key=${xkey}`);
}
// The "sonnet" alias: Claude Code 2.1.284 sends claude-sonnet-5-5 for it (09-29 live test), which EvoLink does not
// serve; the ANTHROPIC_DEFAULT_SONNET_MODEL pin written by setup must win.
const before2 = gw.requests.length;
const alias = await run(CLAUDE, ['-p', 'Reply with exactly: OK', '--model', 'sonnet', '--output-format', 'json'], { ...baseEnv, DISABLE_AUTOUPDATER: '1' });
const aliasMsgs = gw.requests.slice(before2).filter((q) => q.path === '/v1/messages');
console.log(`claude -p --model sonnet exit=${alias.code}; model(s) sent: ${aliasMsgs.map((q) => q.body?.model).join(', ') || '-'}`);

const msgs = reqs.filter((q) => q.path === '/v1/messages');
const writtenEnv = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).env || {};
const checks = {
  'setup succeeded': setup.code === 0,
  'claude reached the gateway': msgs.length > 0,
  'Bearer carries the EvoLink key': msgs.length > 0 && msgs.every((q) => q.headers.authorization === `Bearer ${KEY}`),
  'stale shell ANTHROPIC_API_KEY never sent': reqs.every((q) => !String(q.headers['x-api-key'] || '').includes('stale')),
  'main request uses the chosen model': msgs.some((q) => q.body?.model === 'claude-sonnet-5'),
  'no output cap written by default (Claude Code picks max_tokens)': writtenEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS === undefined && msgs.every((q) => typeof q.body?.max_tokens === 'number'),
  'claude printed OK': /OK/.test(claude.out),
  'the sonnet alias follows the pin written by setup': writtenEnv.ANTHROPIC_DEFAULT_SONNET_MODEL === 'claude-sonnet-5' && aliasMsgs.length > 0 && aliasMsgs.every((q) => q.body?.model === 'claude-sonnet-5'),
};
console.log('');
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'PASS' : 'FAIL'} ${k}`);
await gw.close();
fs.rmSync(home, { recursive: true, force: true });
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
