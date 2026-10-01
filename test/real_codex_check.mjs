// Runs the real, locally installed Codex CLI against the mock gateway, in throwaway HOMEs:
//   1. with the profile written by `evolink setup codex` (codex exec -p evolink);
//   2. with config.toml written by `evolink setup codex --vscode`: a plain `codex exec`, then `codex app-server`
//      started the way the VS Code extension starts it, asked whether it needs a sign-in and sent one turn.
//
//   node test/real_codex_check.mjs [path-to-codex] [--app-server <codex binary bundled with the extension>]
//
// Nothing outside the temporary HOMEs is touched; the key is fake and the gateway is local.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockGateway } from './mock-server.mjs';

const CLI = fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
const args = process.argv.slice(2);
const asIdx = args.indexOf('--app-server');
const APP_SERVER = asIdx >= 0 ? args.splice(asIdx, 2)[1] : null;
const CODEX = args[0] || 'codex';
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

// --- 2. VS Code mode: config.toml itself, read by a plain codex and by the extension's app-server -------------------
console.log('\n=== setup codex --vscode ===');
const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-real-codex-vscode-'));
const env2 = { ...baseEnv, HOME: home2 };
fs.mkdirSync(path.join(home2, '.codex'));
// A setting of the user's own, which must survive: a trusted folder.
fs.writeFileSync(path.join(home2, '.codex', 'config.toml'), '[projects."/work/app"]\ntrust_level = "trusted"\n');
const setup2 = await run(process.execPath, [CLI, 'setup', 'codex', '--vscode', '--yes', '--no-install-extension', '--no-test'], { ...env2, NO_COLOR: '1', EVOLINK_API_KEY: KEY, EVOLINK_BASE_URL: gw.url });
console.log(`evolink setup codex --vscode exit=${setup2.code}`);
const before2 = gw.requests.length;
const plain = await run(CODEX, ['exec', '--skip-git-repo-check', 'Reply with exactly: OK'], { ...env2, OPENAI_API_KEY: 'sk-stale-openai-key-000' });
console.log(`codex exec (no -p) exit=${plain.code}`);
console.log(`stdout: ${plain.out.slice(0, 200)}`);
if (plain.err.trim()) console.log(`stderr (last lines): ${plain.err.trim().split('\n').slice(-5).join('\n  ')}`);
const plainResp = gw.requests.slice(before2).filter((q) => q.path === '/v1/responses');

// The extension runs `codex -c features.code_mode_host=true app-server --analytics-default-enabled` (extension.js,
// openai.chatgpt 26.928) and shows its login page unless account/read says requiresOpenaiAuth = false.
const appBin = APP_SERVER || CODEX;
console.log(`app-server binary: ${appBin}`);
const app = await appServerTurn(appBin, env2);
console.log(`account/read: ${JSON.stringify(app.account)}`);
console.log(`thread/start: model=${app.thread?.model ?? '-'} provider=${app.thread?.modelProvider ?? '-'}`);
console.log(`turn: status=${app.status ?? '-'} agent=${JSON.stringify(app.texts)}${app.error ? ` error=${app.error}` : ''}`);
const appResp = gw.requests.slice(before2).filter((q) => q.path === '/v1/responses').slice(plainResp.length);
const cfgAfter = fs.readFileSync(path.join(home2, '.codex', 'config.toml'), 'utf8');
Object.assign(checks, {
  'vscode: setup succeeded': setup2.code === 0,
  'vscode: a plain codex reaches the gateway with the EvoLink key': plainResp.length > 0 && plainResp.every((q) => q.headers.authorization === `Bearer ${KEY}`),
  'vscode: a plain codex printed OK': /\bOK\b/.test(plain.out),
  'vscode: no hosted web_search tool is sent': plainResp.every((q) => !(q.body?.tools || []).some((t) => /web_search/.test(String(t.type || '')))),
  'vscode: app-server needs no OpenAI sign-in': app.account?.requiresOpenaiAuth === false,
  'vscode: app-server turn completed with OK': app.status === 'completed' && app.texts.some((t) => /\bOK\b/.test(t)),
  'vscode: app-server used the EvoLink provider and key': app.thread?.modelProvider === 'evolink-cli' && appResp.length > 0 && appResp.every((q) => q.headers.authorization === `Bearer ${KEY}`),
  "vscode: the user's own settings are kept": cfgAfter.includes('[projects."/work/app"]\ntrust_level = "trusted"'),
});
const reset2 = await run(process.execPath, [CLI, 'reset', 'codex', '--yes'], { ...env2, NO_COLOR: '1' });
checks['vscode: reset puts config.toml back'] = reset2.code === 0 && fs.readFileSync(path.join(home2, '.codex', 'config.toml'), 'utf8').startsWith('[projects."/work/app"]\ntrust_level = "trusted"\n') && !fs.readFileSync(path.join(home2, '.codex', 'config.toml'), 'utf8').includes('evolink');

console.log('');
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'PASS' : 'FAIL'} ${k}`);
await gw.close();
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(home2, { recursive: true, force: true });
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);

// One JSON-RPC session with `codex app-server` over stdio (newline-delimited JSON), as the extension holds it.
async function appServerTurn(bin, env) {
  const child = spawn(bin, ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'], { env, cwd: env.HOME, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = { account: null, thread: null, status: null, texts: [], error: null };
  const pending = new Map();
  const notes = [];
  let buf = '';
  let id = 0;
  child.stderr.on('data', () => {});
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.id !== undefined && pending.has(m.id) && (m.result !== undefined || m.error !== undefined)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      } else if (m.method && m.id !== undefined) child.stdin.write(`${JSON.stringify({ id: m.id, result: { decision: 'denied' } })}\n`);
      else if (m.method) notes.push(m);
    }
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, resolve);
      child.stdin.write(`${JSON.stringify({ id: n, method, params })}\n`);
      setTimeout(() => reject(new Error(`no answer to ${method}`)), 60000).unref();
    });
  try {
    await call('initialize', { clientInfo: { name: 'evolink_real_codex_check', title: 'EvoLink check', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    out.account = (await call('account/read', {})).result ?? null;
    const ts = await call('thread/start', { cwd: env.HOME, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
    if (ts.error) throw new Error(`thread/start: ${JSON.stringify(ts.error)}`);
    out.thread = ts.result;
    const tr = await call('turn/start', { threadId: ts.result.thread.id, input: [{ type: 'text', text: 'Reply with exactly: OK' }] });
    if (tr.error) throw new Error(`turn/start: ${JSON.stringify(tr.error)}`);
    const t0 = Date.now();
    while (!notes.some((n) => n.method === 'turn/completed') && Date.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 100));
    const done = notes.find((n) => n.method === 'turn/completed');
    out.status = done?.params?.turn?.status ?? 'timeout';
    out.texts = notes.filter((n) => n.method === 'item/completed' && n.params?.item?.type === 'agentMessage').map((n) => n.params.item.text);
  } catch (e) {
    out.error = e.message;
  } finally {
    child.kill('SIGTERM');
  }
  return out;
}
