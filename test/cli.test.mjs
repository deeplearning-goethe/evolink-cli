// End-to-end runs of the CLI in a throwaway HOME against the local mock gateway.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startMockGateway } from './mock-server.mjs';

const CLI = fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
const KEY = `sk-${'Zq9Xw8Vu'.repeat(6)}`;
const LOW_KEY = `sk-${'Lo7Wb6Al'.repeat(6)}`;
const NO_CLAUDE_KEY = `sk-${'Nc5Cl4De'.repeat(6)}`;
let gw;

before(async () => {
  gw = await startMockGateway({
    keys: {
      [KEY.slice(3)]: {},
      [LOW_KEY.slice(3)]: { balance: { user: 0.5, token: 0.5, unlimited: false } },
      [NO_CLAUDE_KEY.slice(3)]: { models: ['gpt-6-luna'] },
    },
  });
});
after(() => gw.close());

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cli-test-'));
}

const WIN = process.platform === 'win32';

// A throwaway home. Windows reads USERPROFILE / APPDATA instead of HOME, and its programs (reg, tasklist,
// even Node's own sockets) need SystemRoot and System32 on PATH.
function homeEnv(home) {
  if (!WIN) return { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
  const root = process.env.SystemRoot || 'C:\\Windows';
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    SystemRoot: root,
    windir: root,
    ComSpec: process.env.ComSpec || path.join(root, 'System32', 'cmd.exe'),
    PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    PATH: [path.dirname(process.execPath), path.join(root, 'System32'), root, path.join(root, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
  };
}

function runCli(args, { home, env = {}, input, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: cwd || home,
      env: {
        ...homeEnv(home),
        LANG: 'en_US.UTF-8',
        NO_COLOR: '1',
        EVOLINK_BASE_URL: gw.url,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(input ?? '');
    child.on('close', (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
  });
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const settingsOf = (home) => readJson(path.join(home, '.claude', 'settings.json'));
const noFullKey = (r, key = KEY) => assert.ok(!r.all.includes(key.slice(3)), 'the full key must never be printed');

test('fresh setup writes settings, onboarding flag and state, then test request passes', async () => {
  const home = tmpHome();
  const before = gw.requests.length;
  const r = await runCli(['setup', '--yes', '--no-install'], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(r.code, 0, r.all);
  noFullKey(r);
  const s = settingsOf(home);
  assert.deepEqual(s.env, {
    ANTHROPIC_BASE_URL: gw.url,
    ANTHROPIC_AUTH_TOKEN: KEY,
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  assert.equal(readJson(path.join(home, '.claude.json')).hasCompletedOnboarding, true);
  const state = readJson(path.join(home, '.evolink', 'state.json'));
  assert.ok(!JSON.stringify(state).includes(KEY.slice(3)), 'state file does not hold the key');
  if (!WIN) assert.equal((fs.statSync(path.join(home, '.claude', 'settings.json')).mode & 0o777).toString(8), '600');
  const calls = gw.requests.slice(before).map((q) => `${q.method} ${q.path}`);
  assert.deepEqual(calls, ['GET /v1/models', 'GET /v1/credits', 'POST /v1/messages']);
  const msg = gw.requests.at(-1);
  assert.equal(msg.body.max_tokens, 1);
  assert.equal(msg.body.model, 'claude-haiku-4-5-20251001');
  assert.equal(msg.headers.authorization, `Bearer ${KEY}`);
  assert.match(r.stdout, /Test passed/);
  assert.match(r.stdout, /All set/);
  assert.match(r.stdout, /Yes, I trust this folder/);

  // Second run is a no-op.
  const snapshot = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
  const r2 = await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(r2.code, 0, r2.all);
  assert.match(r2.stdout, /Already up to date/);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), snapshot);
});

test('existing config from another vendor is fixed and reset restores it exactly', async () => {
  const home = tmpHome();
  const original = {
    env: {
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'zhipu-old-token',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
      CLAUDE_CODE_USE_BEDROCK: '1',
      API_TIMEOUT_MS: '3000000',
    },
    model: 'glm-5.3',
    permissions: { allow: ['Bash(npm test)'] },
    includeCoAuthoredBy: false,
  };
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(original, null, 4));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 3, projects: { '/x': { allowedTools: [] } } }));

  const r = await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(r.code, 0, r.all);
  noFullKey(r);
  const s = settingsOf(home);
  assert.equal(s.env.ANTHROPIC_BASE_URL, gw.url);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(s.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined, 'unusable model override removed');
  assert.equal(s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-4-5-20251001', 'usable override kept');
  assert.equal(s.env.CLAUDE_CODE_USE_BEDROCK, undefined, 'provider switch removed');
  assert.equal(s.env.API_TIMEOUT_MS, '3000000', 'unrelated env kept');
  assert.equal(s.model, undefined, 'unusable top-level model removed');
  assert.deepEqual(s.permissions, original.permissions);
  assert.equal(s.includeCoAuthoredBy, false);
  const g = readJson(path.join(home, '.claude.json'));
  assert.equal(g.numStartups, 3);
  assert.equal(g.hasCompletedOnboarding, true);
  const backups = fs.readdirSync(path.join(home, '.evolink', 'backups'));
  assert.equal(backups.length, 1);
  assert.deepEqual(readJson(path.join(home, '.evolink', 'backups', backups[0], 'settings.json')), original);

  const rr = await runCli(['reset', '--yes'], { home });
  assert.equal(rr.code, 0, rr.all);
  assert.deepEqual(settingsOf(home), original);
  assert.ok(!fs.existsSync(path.join(home, '.evolink', 'state.json')) || !readJson(path.join(home, '.evolink', 'state.json')).claudeCode);
  const again = await runCli(['reset', '--yes'], { home });
  assert.match(again.stdout, /nothing to undo/i);
});

test('stale shell exports are neutralised in settings and reported with file:line', async () => {
  const home = tmpHome();
  // Windows keeps them in the PowerShell profile instead of ~/.zshrc.
  const profile = WIN ? path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1') : path.join(home, '.zshrc');
  const lines = WIN
    ? ['$env:PATH = "C:\\bin;$env:PATH"', '$env:ANTHROPIC_API_KEY = "sk-old-kimi-key-123456"', '$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "kimi-k3"', '$env:ANTHROPIC_BASE_URL = "https://api.moonshot.cn/anthropic"']
    : ['export PATH="$HOME/bin:$PATH"', 'export ANTHROPIC_API_KEY="sk-old-kimi-key-123456"', 'export ANTHROPIC_DEFAULT_SONNET_MODEL=kimi-k3', 'export ANTHROPIC_BASE_URL=https://api.moonshot.cn/anthropic'];
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, lines.join('\n'));
  const shown = `~${path.sep}${path.relative(home, profile)}`;
  const r = await runCli(['setup', '--yes', '--no-install', '--no-test'], {
    home,
    env: { EVOLINK_API_KEY: KEY, ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3', CLAUDE_CODE_USE_VERTEX: '1' },
  });
  assert.equal(r.code, 0, r.all);
  const s = settingsOf(home);
  assert.equal(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL, '', 'unusable shell model neutralised');
  assert.equal(s.env.CLAUDE_CODE_USE_VERTEX, '', 'shell provider switch neutralised');
  assert.equal(s.env.ANTHROPIC_API_KEY, '');
  assert.ok(r.stdout.includes(`${shown}:2 · ANTHROPIC_API_KEY=sk-old-…3456`), r.stdout);
  assert.ok(r.stdout.includes(`${shown}:3 · ANTHROPIC_DEFAULT_SONNET_MODEL=kimi-k3`), r.stdout);
  assert.ok(!r.all.includes('sk-old-kimi-key-123456'), 'old key masked too');
});

test('invalid key stops before any file is written', async () => {
  const home = tmpHome();
  const r = await runCli(['setup', '--yes', '--no-install'], { home, env: { EVOLINK_API_KEY: `sk-${'x'.repeat(48)}` } });
  assert.equal(r.code, 2, r.all);
  assert.match(r.stdout, /Invalid key/);
  assert.ok(!fs.existsSync(path.join(home, '.claude')));
  assert.ok(!fs.existsSync(path.join(home, '.claude.json')));
});

test('a key with pasted junk is cleaned up; a key with a suffix gets a warning', async () => {
  const home = tmpHome();
  const r = await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: ` "Bearer ${KEY}"　` } });
  assert.equal(r.code, 0, r.all);
  assert.equal(settingsOf(home).env.ANTHROPIC_AUTH_TOKEN, KEY);
  const r2 = await runCli(['setup', '--yes', '--no-install', '--dry-run'], { home: tmpHome(), env: { EVOLINK_API_KEY: `${KEY}-3` } });
  assert.match(r2.stdout, /channel pin/);
});

test('broken settings.json is kept unless --replace-invalid', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.claude'));
  const broken = '{\n  "env": {\n    "ANTHROPIC_BASE_URL"： "https://direct.evolink.ai"，\n  }\n}\n';
  const file = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(file, broken);
  const r = await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(r.code, 4, r.all);
  assert.match(r.stdout, /full-width punctuation/);
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
  const r2 = await runCli(['setup', '--yes', '--no-install', '--no-test', '--replace-invalid'], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(r2.code, 0, r2.all);
  assert.equal(settingsOf(home).env.ANTHROPIC_AUTH_TOKEN, KEY);
  const dir = fs.readdirSync(path.join(home, '.evolink', 'backups'))[0];
  assert.equal(fs.readFileSync(path.join(home, '.evolink', 'backups', dir, 'settings.json'), 'utf8'), broken);
});

test('dry run writes nothing', async () => {
  const home = tmpHome();
  const r = await runCli(['setup', '--yes', '--no-install', '--dry-run'], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /Preview only/);
  assert.ok(!fs.existsSync(path.join(home, '.claude')));
  assert.ok(!fs.existsSync(path.join(home, '.evolink')));
});

test('model typo gets a suggestion; a valid --model is written', async () => {
  const home = tmpHome();
  const bad = await runCli(['setup', '--yes', '--no-install', '--model', 'claude-opus-5.5'], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(bad.code, 2, bad.all);
  assert.match(bad.stdout, /did you mean claude-opus-5-5/);
  const ok = await runCli(['setup', '--yes', '--no-install', '--model', 'claude-sonnet-5'], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(ok.code, 0, ok.all);
  assert.equal(settingsOf(home).env.ANTHROPIC_MODEL, 'claude-sonnet-5');
  assert.equal(gw.requests.at(-1).body.model, 'claude-sonnet-5', 'test request uses the chosen model');
});

test('low balance warns and the failed test request explains the hold', async () => {
  const home = tmpHome();
  const r = await runCli(['setup', '--yes', '--no-install'], { home, env: { EVOLINK_API_KEY: LOW_KEY } });
  assert.equal(r.code, 2, r.all);
  noFullKey(r, LOW_KEY);
  assert.match(r.stdout, /Account balance 0\.5 credits/);
  assert.match(r.stdout, /Low balance/);
  assert.match(r.stdout, /Not enough credits/);
  assert.equal(settingsOf(home).env.ANTHROPIC_AUTH_TOKEN, LOW_KEY, 'config is still written');
});

test('key without Claude models is flagged', async () => {
  const home = tmpHome();
  const r = await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: NO_CLAUDE_KEY } });
  assert.match(r.stdout, /no Claude models/);
});

test('network failure exits with the network code and a hint', async () => {
  const home = tmpHome();
  const closed = await new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
  const r = await runCli(['setup', '--yes', '--no-install'], { home, env: { EVOLINK_API_KEY: KEY, EVOLINK_BASE_URL: `http://127.0.0.1:${closed}`, HTTPS_PROXY: 'http://127.0.0.1:7890' } });
  assert.equal(r.code, 5, r.all);
  assert.match(r.stdout, /Cannot connect/);
  assert.match(r.stdout, /--skip-checks/);
  assert.ok(!fs.existsSync(path.join(home, '.claude')));
});

test('editor extension: login prompt disabled with comments kept, and undone by reset', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.vscode', 'extensions', 'anthropic.claude-code-2.1.280-darwin-arm64'), { recursive: true });
  const userDir = WIN
    ? path.join(home, 'AppData', 'Roaming', 'Code', 'User')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Code', 'User')
      : path.join(home, '.config', 'Code', 'User');
  fs.mkdirSync(userDir, { recursive: true });
  const vs = path.join(userDir, 'settings.json');
  const original = '{\n  // keep me\n  "editor.fontSize": 13,\n}\n';
  fs.writeFileSync(vs, original);
  const r = await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(r.code, 0, r.all);
  const edited = fs.readFileSync(vs, 'utf8');
  assert.match(edited, /"claudeCode\.disableLoginPrompt": true/);
  assert.match(edited, /\/\/ keep me/);
  const rr = await runCli(['reset', '--yes'], { home });
  assert.equal(rr.code, 0, rr.all);
  assert.equal(fs.readFileSync(vs, 'utf8'), original);
});

test('trust flag pre-trusts a folder and reset removes it', async () => {
  const home = tmpHome();
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  const r = await runCli(['setup', '--yes', '--no-install', '--no-test', '--trust', proj], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(r.code, 0, r.all);
  if (WIN) {
    // Not supported on Windows yet: a warning, and nothing is written.
    assert.match(r.stdout, /not supported on Windows yet/);
    assert.equal(readJson(path.join(home, '.claude.json')).projects, undefined);
    return;
  }
  const real = fs.realpathSync(proj);
  assert.equal(readJson(path.join(home, '.claude.json')).projects[real].hasTrustDialogAccepted, true, 'keyed by the physical path');
  assert.doesNotMatch(r.stdout, /Yes, I trust this folder/);
  await runCli(['reset', '--yes'], { home });
  assert.equal(readJson(path.join(home, '.claude.json')).projects?.[real], undefined);
});

test('doctor: healthy setup passes, both-keys conflict is a problem, output is redacted', async () => {
  const home = tmpHome();
  await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: KEY } });
  const d = await runCli(['doctor'], { home });
  assert.equal(d.code, 1, 'claude is not installed in the test PATH, so doctor reports one problem');
  noFullKey(d);
  assert.match(d.stdout, /Key valid/);
  assert.match(d.stdout, /evolink-doctor \d+\.\d+\.\d+/);
  assert.match(d.stdout, /Claude Code is not installed/);

  const s = settingsOf(home);
  s.env.ANTHROPIC_API_KEY = 'sk-some-old-key-999999';
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(s));
  const d2 = await runCli(['doctor', '--json'], { home });
  const rep = JSON.parse(d2.stdout.slice(d2.stdout.indexOf('{')));
  assert.ok(rep.problems.some((p) => /Both ANTHROPIC_API_KEY/.test(p)));
  assert.ok(!d2.all.includes('sk-some-old-key-999999'));
});

test('--json setup output is machine readable and redacted', async () => {
  const home = tmpHome();
  const r = await runCli(['setup', '--yes', '--json', '--no-install'], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(r.code, 0, r.all);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.key, `sk-${KEY.slice(3, 7)}…${KEY.slice(-4)}`);
  assert.equal(out.test.ok, true);
  noFullKey(r);
  const noYes = await runCli(['setup', '--json'], { home });
  assert.equal(noYes.code, 2);
});

test('Chinese interface', async () => {
  const home = tmpHome();
  const r = await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: KEY, LANG: 'zh_CN.UTF-8' } });
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /配置完成/);
  assert.match(r.stdout, /Key 有效/);
});

test('official login: warns before switching, Enter means No, y applies, and the warning is not repeated', async () => {
  const home = tmpHome();
  const signedIn = { numStartups: 7, oauthAccount: { accountUuid: 'u-1', emailAddress: 'dev@example.com' } };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(signedIn));
  fs.mkdirSync(path.join(home, '.claude'));
  const userSettings = { model: 'claude-opus-5-5[1m]', env: { HTTP_PROXY: 'http://127.0.0.1:7890' } };
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(userSettings));

  // Enter at the model picker, then Enter at the final confirmation, whose default is now No.
  const r = await runCli(['setup', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: KEY }, input: '\n\n' });
  assert.equal(r.code, 130, r.all);
  assert.match(r.stdout, /signed in to an Anthropic account \(dev@example\.com\)/);
  assert.match(r.stdout, /already open in VS Code/);
  assert.match(r.stdout, /Apply these changes\? \[y\/N\]/);
  assert.deepEqual(settingsOf(home), userSettings, 'nothing written');

  const r2 = await runCli(['setup', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: KEY }, input: '\ny\n' });
  assert.equal(r2.code, 0, r2.all);
  assert.equal(settingsOf(home).env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.deepEqual(readJson(path.join(home, '.claude.json')).oauthAccount, signedIn.oauthAccount, 'the login itself is kept');

  const r3 = await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(r3.code, 0, r3.all);
  assert.doesNotMatch(r3.stdout, /signed in to an Anthropic account/);
  const d = await runCli(['doctor'], { home });
  assert.match(d.stdout, /Also signed in to an Anthropic account/);
  assert.match(d.stdout, /official_login: yes/);
  assert.doesNotMatch(d.stdout, /dev@example\.com/, 'the support report leaves the email out');

  // --yes still proceeds on a signed-in home, and says so.
  const home2 = tmpHome();
  fs.writeFileSync(path.join(home2, '.claude.json'), JSON.stringify(signedIn));
  const j = await runCli(['setup', '--yes', '--json', '--no-install', '--no-test'], { home: home2, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(j.code, 0, j.all);
  assert.equal(JSON.parse(j.stdout).officialLogin, true);
});

test('run from the home folder through a symlinked HOME: no trust question', { skip: WIN }, async () => {
  // macOS temp folders (/var -> /private/var) and some servers' /home are symlinks; cwd comes back resolved.
  const real = tmpHome();
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  const r = await runCli(['setup', '--no-install', '--no-test'], { home: link, env: { EVOLINK_API_KEY: KEY }, input: '\n\n' });
  assert.equal(r.code, 0, r.all);
  assert.doesNotMatch(r.stdout, /Mark the current folder as trusted/);
  assert.equal(settingsOf(real).env.ANTHROPIC_AUTH_TOKEN, KEY);
});

test('test home: announced as test mode, and every command shown carries the same HOME', { skip: WIN }, async () => {
  const home = tmpHome();
  const r = await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /Test mode: HOME is /);
  assert.ok(r.stdout.includes(`HOME=${JSON.stringify(home)} claude`), r.stdout);
  assert.ok(r.stdout.includes(`HOME=${JSON.stringify(home)} node `), 'reset and doctor hints too');
  assert.doesNotMatch(r.stdout, /Open a new terminal/);

  // setup.sh passes EVOLINK_CMD="~/…"; after HOME="…" on the same line, ~ would still be the real home.
  const r2 = await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: KEY, EVOLINK_CMD: '~/.evolink/bin/evolink' } });
  assert.ok(r2.stdout.includes(`HOME=${JSON.stringify(home)} ${home}/.evolink/bin/evolink reset`), r2.stdout);
  assert.ok(!r2.stdout.includes(`HOME=${JSON.stringify(home)} ~`), 'no ~ after HOME=');
});

test('run through the installed launcher, hints name the launcher', { skip: process.platform === 'win32' }, async () => {
  const home = tmpHome();
  const cliDir = path.join(home, '.evolink', 'cli');
  const binDir = path.join(home, '.evolink', 'bin');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(CLI, path.join(cliDir, 'evolink.mjs'));
  const launcher = path.join(binDir, 'evolink');
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${path.join(cliDir, 'evolink.mjs')}" "$@"\n`, { mode: 0o755 });
  await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: KEY } });
  const d = await new Promise((resolve) => {
    const child = spawn(launcher, ['doctor'], { cwd: home, env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, LANG: 'en_US.UTF-8', NO_COLOR: '1', EVOLINK_BASE_URL: gw.url } });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.on('close', () => resolve(out));
  });
  assert.ok(d.includes(`HOME=${JSON.stringify(home)} ${launcher} setup`), d);
});

test('an outdated Claude Code gets an update hint in setup and doctor', { skip: process.platform === 'win32' }, async () => {
  const home = tmpHome();
  const bin = path.join(home, 'fakebin');
  fs.mkdirSync(bin);
  const fake = (v) => fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "${v} (Claude Code)"\n`, { mode: 0o755 });
  fake('2.1.260');
  const env = { EVOLINK_API_KEY: KEY, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
  const r = await runCli(['setup', '--yes', '--no-test', '--registry', gw.url], { home, env });
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /Claude Code 2\.1\.283 is available \(you have 2\.1\.260\)/);
  const d = await runCli(['doctor', '--registry', gw.url], { home, env });
  assert.match(d.stdout, /2\.1\.283 is available/);
  assert.match(d.stdout, /claude 2\.1\.260 \(latest 2\.1\.283\)/);
  fake('2.1.283');
  const r2 = await runCli(['setup', '--yes', '--no-test', '--registry', gw.url], { home, env });
  assert.equal(r2.code, 0, r2.all);
  assert.doesNotMatch(r2.stdout, /is available/);
});
