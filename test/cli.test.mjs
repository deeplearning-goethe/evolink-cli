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
const OLD_SONNET_KEY = `sk-${'Os4Sn6Et'.repeat(6)}`;
const NEW_SONNET_KEY = `sk-${'Ns5Sn5Et'.repeat(6)}`;
const CODEX_KEY = `sk-${'Cx7Gp6Td'.repeat(6)}`;
const CHAT_KEY = `sk-${'Ch4Tm0Dl'.repeat(6)}`;
let gw;

before(async () => {
  gw = await startMockGateway({
    keys: {
      [KEY.slice(3)]: {},
      [LOW_KEY.slice(3)]: { balance: { user: 0.5, token: 0.5, unlimited: false } },
      [NO_CLAUDE_KEY.slice(3)]: { models: ['gpt-6-luna'] },
      [OLD_SONNET_KEY.slice(3)]: { models: ['claude-opus-5-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'] },
      [NEW_SONNET_KEY.slice(3)]: { models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'] },
      [CODEX_KEY.slice(3)]: { models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.5', 'gpt-6-luna', 'gpt-image-2', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'] },
      [CHAT_KEY.slice(3)]: { models: ['claude-haiku-4-5-20251001', 'gpt-6-luna', 'gpt-image-2', 'deepseek-v4-flash', 'gemini-3.1-flash-lite', 'kimi-k3'] },
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
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5', // Claude Code 2.1.284 sends claude-sonnet-5-5 for "sonnet"; EvoLink does not serve it
  });
  assert.equal(s.disableAutoMode, 'disable', 'auto mode is turned off until the gateway can serve its review requests');
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
  assert.equal(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5', 'Sonnet alias pinned to the newest usable Sonnet');
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
  assert.equal(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5', 'unusable shell model overridden by the Sonnet pin (settings beat the shell)');
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

test('--auto-mode keeps auto mode on; --max-output-tokens and --disable-nonessential-traffic are opt-in', async () => {
  const home = tmpHome();
  const r = await runCli(['setup', '--yes', '--no-install', '--no-test', '--auto-mode', '--max-output-tokens', '32000', '--disable-nonessential-traffic'], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(r.code, 0, r.all);
  const s = settingsOf(home);
  assert.equal(s.disableAutoMode, undefined);
  assert.equal(s.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '32000');
  assert.equal(s.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  const d = await runCli(['doctor'], { home });
  assert.match(d.stdout, /auto mode is not turned off/);
  const rr = await runCli(['reset', '--yes'], { home });
  assert.equal(rr.code, 0, rr.all);
  assert.equal(settingsOf(home).env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
});

test('dry run writes nothing', async () => {
  const home = tmpHome();
  const r = await runCli(['setup', '--yes', '--no-install', '--dry-run'], { home, env: { EVOLINK_API_KEY: KEY } });
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /Preview only/);
  assert.ok(!fs.existsSync(path.join(home, '.claude')));
  assert.ok(!fs.existsSync(path.join(home, '.evolink')));
});

test('dry run does not install Claude Code (it only shows the npm command)', { skip: WIN }, async () => {
  const home = tmpHome();
  const bin = path.join(home, 'fakebin');
  const mark = path.join(home, 'npm-called');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$@" >> "${mark}"\nexit 1\n`, { mode: 0o755 });
  const env = { EVOLINK_API_KEY: KEY, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
  const r = await runCli(['setup', '--yes', '--dry-run', '--registry', gw.url], { home, env });
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /would install Claude Code/);
  assert.match(r.stdout, /Preview only/);
  assert.ok(!fs.existsSync(mark), 'npm must not run in a dry run');
  // Control: a real run does call npm (the fake one fails, and setup still writes the settings).
  const r2 = await runCli(['setup', '--yes', '--no-test', '--registry', gw.url], { home, env });
  assert.equal(r2.code, 0, r2.all);
  assert.match(fs.readFileSync(mark, 'utf8'), /install -g @anthropic-ai\/claude-code/);
});

test('--install-extension installs the Claude Code extension with the editor CLI; without it setup only shows the link', { skip: WIN }, async () => {
  const home = tmpHome();
  const bin = path.join(home, 'fakebin');
  const calls = path.join(home, 'code-calls');
  fs.mkdirSync(bin);
  // A fake `code`: lists nothing until it has "installed" the extension into ~/.vscode/extensions.
  fs.writeFileSync(
    path.join(bin, 'code'),
    `#!/bin/sh
echo "$@" >> "${calls}"
if [ "$1" = "--list-extensions" ]; then ls "$HOME/.vscode/extensions" 2>/dev/null | sed 's/-[0-9.]*$//'; exit 0; fi
if [ "$1" = "--install-extension" ]; then mkdir -p "$HOME/.vscode/extensions/$2-9.9.9"; echo "Extension '$2' v9.9.9 was successfully installed."; exit 0; fi
exit 1
`,
    { mode: 0o755 },
  );
  // VS Code has been opened once (its settings folder exists) but has no Claude Code extension.
  const settingsDir = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Code', 'User') : path.join(home, '.config', 'Code', 'User');
  fs.mkdirSync(settingsDir, { recursive: true });
  const env = { EVOLINK_API_KEY: KEY, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` };

  const r = await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env });
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /open vscode:extension\/anthropic\.claude-code in the editor/);
  assert.ok(!fs.existsSync(calls), 'without --install-extension the editor CLI is not run');

  const dry = await runCli(['setup', '--yes', '--no-install', '--no-test', '--install-extension', '--dry-run'], { home, env });
  assert.equal(dry.code, 0, dry.all);
  assert.match(dry.stdout, /would run .*code --install-extension anthropic\.claude-code/);
  assert.doesNotMatch(fs.readFileSync(calls, 'utf8'), /--install-extension/);

  const r2 = await runCli(['setup', '--yes', '--no-install', '--no-test', '--install-extension'], { home, env });
  assert.equal(r2.code, 0, r2.all);
  assert.match(r2.stdout, /VS Code: anthropic\.claude-code installed/);
  assert.match(fs.readFileSync(calls, 'utf8'), /--install-extension anthropic\.claude-code/);
  // The freshly installed extension also gets its login prompt turned off, and the link is no longer shown.
  assert.match(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8'), /"claudeCode\.disableLoginPrompt": true/);
  assert.doesNotMatch(r2.stdout, /open vscode:extension/);

  const r3 = await runCli(['setup', '--yes', '--no-install', '--no-test', '--install-extension'], { home, env });
  assert.match(r3.stdout, /VS Code already has anthropic\.claude-code/);
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
  assert.match(d.stdout, /auto mode is off/);

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

test('Sonnet alias pin: newest usable Sonnet, user pin kept, --no-pin-sonnet, doctor hint, reset', async () => {
  // Claude Code 2.1.284 resolves "sonnet" to claude-sonnet-5-5 (09-29 live test); a key without it needs the pin.
  const home = tmpHome();
  const r = await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: OLD_SONNET_KEY } });
  assert.equal(r.code, 0, r.all);
  assert.equal(settingsOf(home).env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-4-6', 'dated ids lose to plain ids of the same version');
  assert.match(r.stdout, /ANTHROPIC_DEFAULT_SONNET_MODEL\s+\(none\) → claude-sonnet-4-6/);
  const d1 = await runCli(['doctor'], { home });
  assert.match(d1.stdout, /ANTHROPIC_DEFAULT_SONNET_MODEL = claude-sonnet-4-6 \(used for the Sonnet alias\)/);
  assert.match(d1.stdout, /sonnet=claude-sonnet-4-6/);

  // A key that already has claude-sonnet-5-5 gets pinned to it (same as the alias, harmless).
  const home2 = tmpHome();
  await runCli(['setup', '--yes', '--no-install', '--no-test'], { home: home2, env: { EVOLINK_API_KEY: NEW_SONNET_KEY } });
  assert.equal(settingsOf(home2).env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5-5');

  // The user's own usable pin is kept.
  const home3 = tmpHome();
  fs.mkdirSync(path.join(home3, '.claude'));
  fs.writeFileSync(path.join(home3, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5-20250929' } }));
  await runCli(['setup', '--yes', '--no-install', '--no-test'], { home: home3, env: { EVOLINK_API_KEY: OLD_SONNET_KEY } });
  assert.equal(settingsOf(home3).env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-4-5-20250929', 'usable user pin kept');

  // --no-pin-sonnet writes nothing; doctor then explains what the alias would do.
  const home4 = tmpHome();
  await runCli(['setup', '--yes', '--no-install', '--no-test', '--no-pin-sonnet'], { home: home4, env: { EVOLINK_API_KEY: OLD_SONNET_KEY } });
  assert.equal(settingsOf(home4).env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
  const d4 = await runCli(['doctor'], { home: home4 });
  assert.match(d4.stdout, /ANTHROPIC_DEFAULT_SONNET_MODEL is not set: Claude Code 2\.1\.284\+ resolves the Sonnet alias to claude-sonnet-5-5, which this key cannot use; re-run setup to pin it to claude-sonnet-4-6/);
  assert.match(d4.stdout, /sonnet=-/);

  // reset removes the pin it wrote.
  const rr = await runCli(['reset', '--yes'], { home });
  assert.equal(rr.code, 0, rr.all);
  assert.equal(settingsOf(home).env?.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
});

// ---------------------------------------------------------------------------
// Codex

const codexDir = (home) => path.join(home, '.codex');
const codexProfile = (home) => path.join(codexDir(home), 'evolink.config.toml');
// A fake `codex` on PATH (reports a version, like the real one).
function fakeCodex(home, version = '0.159.2') {
  const bin = path.join(home, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
  return `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
}

test('setup codex writes only the evolink profile, leaves config.toml alone, and reset removes it', async () => {
  const home = tmpHome();
  fs.mkdirSync(codexDir(home));
  const mainToml = '# my own Codex config\nmodel = "gpt-5.5"\n\n[profiles.work]\nmodel = "o3"\n';
  fs.writeFileSync(path.join(codexDir(home), 'config.toml'), mainToml);
  const before = gw.requests.length;
  const r = await runCli(['setup', 'codex', '--yes', '--no-install'], { home, env: { EVOLINK_API_KEY: CODEX_KEY } });
  assert.equal(r.code, 0, r.all);
  noFullKey(r, CODEX_KEY);
  assert.match(r.stdout, /Key is valid \(sk-Cx7G…p6Td\) · 7 models, 4 GPT/);
  const prof = fs.readFileSync(codexProfile(home), 'utf8');
  assert.match(prof, /^model = "gpt-6\.1-sol"$/m, "Codex's own default model, which the key has");
  assert.match(prof, /^model_provider = "evolink-cli"$/m);
  assert.match(prof, /^base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"$/m);
  assert.match(prof, /^wire_api = "responses"$/m);
  assert.ok(prof.includes(`experimental_bearer_token = "${CODEX_KEY}"`));
  assert.equal(fs.readFileSync(path.join(codexDir(home), 'config.toml'), 'utf8'), mainToml, 'the main config.toml is untouched');
  if (!WIN) assert.equal(fs.statSync(codexProfile(home)).mode & 0o777, 0o600, 'the profile holds the key: owner-only');
  const resp = gw.requests.slice(before).filter((q) => q.path === '/v1/responses');
  assert.equal(resp.length, 1, 'one test request on the Responses API');
  assert.equal(resp[0].body.model, 'gpt-6.1-sol');
  assert.equal(resp[0].headers.authorization, `Bearer ${CODEX_KEY}`);
  assert.match(r.stdout, /Run: codex -p evolink|codex -p evolink/);
  assert.match(r.stdout, /reset codex/);

  const r2 = await runCli(['setup', 'codex', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: CODEX_KEY } });
  assert.equal(r2.code, 0, r2.all);
  assert.match(r2.stdout, /Keeping model: gpt-6\.1-sol/);
  assert.match(r2.stdout, /Already up to date/);

  const rr = await runCli(['reset', 'codex', '--yes'], { home });
  assert.equal(rr.code, 0, rr.all);
  assert.ok(!fs.existsSync(codexProfile(home)));
  assert.equal(fs.readFileSync(path.join(codexDir(home), 'config.toml'), 'utf8'), mainToml);
});

test('setup codex: reuses the Claude Code key; --model must be a GPT model of this key; a key without GPT stops', async () => {
  const home = tmpHome();
  await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: CODEX_KEY } });
  const r = await runCli(['setup', 'codex', '--yes', '--no-install', '--no-test', '--model', 'gpt-5.5'], { home });
  assert.equal(r.code, 0, r.all);
  assert.match(fs.readFileSync(codexProfile(home), 'utf8'), /^model = "gpt-5\.5"$/m);
  assert.ok(fs.readFileSync(codexProfile(home), 'utf8').includes(CODEX_KEY), 'the key came from the Claude Code settings');

  const claudeModel = await runCli(['setup', 'codex', '--yes', '--no-install', '--model', 'claude-sonnet-5'], { home });
  assert.equal(claudeModel.code, 2, claudeModel.all);
  assert.match(claudeModel.all, /This key cannot use model claude-sonnet-5 in Codex/);
  const cased = await runCli(['setup', 'codex', '--yes', '--no-install', '--model', 'GPT-6-SOL'], { home });
  assert.equal(cased.code, 2, cased.all);
  assert.match(cased.all, /did you mean gpt-6-sol\?/);

  const noGpt = tmpHome();
  const ng = await runCli(['setup', 'codex', '--yes', '--no-install'], { home: noGpt, env: { EVOLINK_API_KEY: OLD_SONNET_KEY } });
  assert.equal(ng.code, 2, ng.all);
  assert.match(ng.all, /no GPT models/);
  assert.ok(!fs.existsSync(codexProfile(noGpt)));
});

test('setup codex --dry-run writes nothing and does not install Codex', { skip: WIN }, async () => {
  const home = tmpHome();
  const bin = path.join(home, 'fakebin');
  const mark = path.join(home, 'npm-called');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$@" >> "${mark}"\nexit 1\n`, { mode: 0o755 });
  const env = { EVOLINK_API_KEY: CODEX_KEY, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
  const r = await runCli(['setup', 'codex', '--yes', '--dry-run', '--registry', gw.url], { home, env });
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /would install Codex from/);
  assert.match(r.stdout, /npm install -g @openai\/codex/);
  assert.match(r.stdout, /Preview only/);
  assert.ok(!fs.existsSync(mark), 'npm must not run in a dry run');
  assert.ok(!fs.existsSync(codexDir(home)));
  assert.ok(!fs.existsSync(path.join(home, '.evolink')));
});

test('reset codex puts back a profile that existed before setup, and leaves a replaced one alone', async () => {
  const home = tmpHome();
  fs.mkdirSync(codexDir(home));
  const mine = '# written by hand\nmodel = "o3"\n';
  fs.writeFileSync(codexProfile(home), mine);
  const r = await runCli(['setup', 'codex', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: CODEX_KEY } });
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /replaced; the old file is backed up first/);
  // A second setup must not mistake its own file for the user's original.
  await runCli(['setup', 'codex', '--yes', '--no-install', '--no-test', '--model', 'gpt-5.5'], { home, env: { EVOLINK_API_KEY: CODEX_KEY } });
  const rr = await runCli(['reset', 'codex', '--yes'], { home });
  assert.equal(rr.code, 0, rr.all);
  assert.match(rr.stdout, /restored to what it was before setup/);
  assert.equal(fs.readFileSync(codexProfile(home), 'utf8'), mine);

  // A file the user has since replaced with something else is not setup's to delete.
  const home2 = tmpHome();
  await runCli(['setup', 'codex', '--yes', '--no-install', '--no-test'], { home: home2, env: { EVOLINK_API_KEY: CODEX_KEY } });
  fs.writeFileSync(codexProfile(home2), 'model = "o3"\nmodel_provider = "mine"\n\n[model_providers.mine]\nname = "Mine"\n');
  const rr2 = await runCli(['reset', 'codex', '--yes'], { home: home2 });
  assert.equal(rr2.code, 0, rr2.all);
  assert.match(rr2.stdout, /No longer the file setup wrote, left as is/);
  assert.ok(fs.existsSync(codexProfile(home2)));
});

test('reset without a target undoes Claude Code and Codex together (one JSON document)', async () => {
  const home = tmpHome();
  await runCli(['setup', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: CODEX_KEY } });
  await runCli(['setup', 'codex', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: CODEX_KEY } });
  const j = await runCli(['reset', '--yes', '--json'], { home });
  assert.equal(j.code, 0, j.all);
  const out = JSON.parse(j.stdout);
  assert.equal(out.command, 'reset');
  assert.equal(out.ok, true);
  assert.ok(out.claudeCode && out.codex, 'both parts reported');
  assert.ok(!fs.existsSync(codexProfile(home)));
  assert.equal(settingsOf(home).env?.ANTHROPIC_AUTH_TOKEN, undefined);
  // Only Codex set up: a plain reset undoes it without complaining about Claude Code.
  const home2 = tmpHome();
  await runCli(['setup', 'codex', '--yes', '--no-install', '--no-test'], { home: home2, env: { EVOLINK_API_KEY: CODEX_KEY } });
  const r2 = await runCli(['reset', '--yes'], { home: home2 });
  assert.equal(r2.code, 0, r2.all);
  assert.doesNotMatch(r2.stdout, /No changes recorded by evolink setup;/);
  assert.ok(!fs.existsSync(codexProfile(home2)));
});

test('doctor codex: a healthy profile passes; an unset env_key or a missing profile is a problem', { skip: WIN }, async () => {
  const home = tmpHome();
  const PATHV = fakeCodex(home);
  const s = await runCli(['setup', 'codex', '--yes', '--no-test', '--registry', gw.url], { home, env: { EVOLINK_API_KEY: CODEX_KEY, PATH: PATHV } });
  assert.equal(s.code, 0, s.all);
  assert.match(s.stdout, /Codex 0\.159\.2/);
  const d = await runCli(['doctor', 'codex', '--test', '--registry', gw.url], { home, env: { PATH: PATHV } });
  assert.equal(d.code, 0, d.all);
  noFullKey(d, CODEX_KEY);
  assert.match(d.stdout, /key = sk-Cx7G…p6Td/);
  assert.match(d.stdout, /Test request passed: gpt-6\.1-sol/);
  assert.match(d.stdout, /evolink-doctor [\d.]+ codex \| .* \| codex 0\.159\.2 \(latest 0\.159\.2\)$/m);
  assert.match(d.stdout, /^profile: yes provider=evolink-cli base=http:\/\/127\.0\.0\.1:\d+\/v1 key=sk-Cx7G…p6Td model=gpt-6\.1-sol wire=responses web_search=disabled/m);
  assert.match(d.stdout, /^config\.toml: no /m);
  assert.match(d.stdout, /^api: models=7 gpt=4 /m);

  const prof = fs.readFileSync(codexProfile(home), 'utf8');
  fs.writeFileSync(codexProfile(home), prof.replace(/^experimental_bearer_token = .*$/m, 'env_key = "EVOLINK_API_KEY"'));
  const d2 = await runCli(['doctor', 'codex', '--registry', gw.url], { home, env: { PATH: PATHV } });
  assert.equal(d2.code, 1, d2.all);
  assert.match(d2.stdout, /The key comes from EVOLINK_API_KEY, which is not set/);

  const d3 = await runCli(['doctor', 'codex', '--registry', gw.url], { home: tmpHome(), env: { PATH: PATHV } });
  assert.equal(d3.code, 1, d3.all);
  assert.match(d3.stdout, /evolink\.config\.toml does not exist; run .*setup codex/);
});

test('setup codex and config.toml: an old evolink provider is left alone, blockers are named, auto review is turned off', async () => {
  const home = tmpHome();
  fs.mkdirSync(codexDir(home));
  // What our docs used to teach, plus two settings that break or hurt `codex -p evolink`.
  const mainToml = `approvals_reviewer = "auto_review"
model_provider = "evolink"

[model_providers.evolink]
name = "EvoLink"
base_url = "https://direct.evolink.ai/v1"
env_key = "OPENAI_API_KEY"

[profiles.evolink]
model = "gpt-5.2"
`;
  fs.writeFileSync(path.join(codexDir(home), 'config.toml'), mainToml);
  const r = await runCli(['setup', 'codex', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: CODEX_KEY } });
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /older \[model_providers\.evolink\] setup \(key from OPENAI_API_KEY\): plain codex still uses it/);
  assert.match(r.stdout, /has a \[profiles\.evolink\] table: current Codex refuses to start codex -p evolink/);
  assert.match(r.stdout, /approvals_reviewer → user/);
  const prof = fs.readFileSync(codexProfile(home), 'utf8');
  assert.match(prof, /^approvals_reviewer = "user"$/m);
  assert.match(prof, /^\[model_providers\.evolink-cli\]$/m, 'a provider id of its own, so the old env_key cannot merge in');
  assert.equal(fs.readFileSync(path.join(codexDir(home), 'config.toml'), 'utf8'), mainToml, 'config.toml untouched');
  const d = await runCli(['doctor', 'codex'], { home });
  assert.equal(d.code, 1, d.all);
  assert.match(d.stdout, /refuses to start codex -p evolink/);
  assert.match(d.stdout, /^config\.toml: yes profiles_table=yes legacy_profile=no auto_review=yes old_evolink_provider=yes$/m);
});

test('trust entries Codex writes into the profile survive a re-run and do not block reset', async () => {
  const home = tmpHome();
  await runCli(['setup', 'codex', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: CODEX_KEY } });
  // What Codex 0.159.2 appends in a `codex -p evolink` session: [tui] on the first launch, then trusted folders.
  fs.appendFileSync(codexProfile(home), '\n[tui]\nscreen_reader_detection_done = true\n\n[projects."/work/app"]\ntrust_level = "trusted"\n');
  const r = await runCli(['setup', 'codex', '--yes', '--no-install', '--no-test'], { home, env: { EVOLINK_API_KEY: CODEX_KEY } });
  assert.match(r.stdout, /Already up to date/);
  const r2 = await runCli(['setup', 'codex', '--yes', '--no-install', '--no-test', '--model', 'gpt-6-luna'], { home, env: { EVOLINK_API_KEY: CODEX_KEY } });
  assert.equal(r2.code, 0, r2.all);
  const prof = fs.readFileSync(codexProfile(home), 'utf8');
  assert.match(prof, /^model = "gpt-6-luna"$/m);
  assert.match(prof, /\[projects\."\/work\/app"\]\ntrust_level = "trusted"/, 'the trust entry is kept');
  assert.match(prof, /\[tui\]\nscreen_reader_detection_done = true/);
  const rr = await runCli(['reset', 'codex', '--yes'], { home });
  assert.equal(rr.code, 0, rr.all);
  assert.match(rr.stdout, /settings added to it later \(such as trusted folders\) go too/);
  assert.ok(!fs.existsSync(codexProfile(home)));
});


// Codex in VS Code (setup codex --vscode): config.toml itself

const codexConfig = (home) => path.join(codexDir(home), 'config.toml');
// A fake editor CLI on PATH that records its calls and "installs" into ~/.vscode/extensions.
function fakeEditorCli(home) {
  const bin = path.join(home, 'fakebin');
  const calls = path.join(home, 'code-calls');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'code'),
    `#!/bin/sh
echo "$@" >> "${calls}"
if [ "$1" = "--list-extensions" ]; then ls "$HOME/.vscode/extensions" 2>/dev/null | sed 's/-[0-9.]*$//'; exit 0; fi
if [ "$1" = "--install-extension" ]; then mkdir -p "$HOME/.vscode/extensions/$2-9.9.9"; echo "Extension '$2' v9.9.9 was successfully installed."; exit 0; fi
exit 1
`,
    { mode: 0o755 },
  );
  return { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, calls };
}

const USER_CODEX_CONFIG = `# my Codex settings
model = "gpt-5.5-codex"   # an OpenAI model this key does not have
approvals_reviewer = "auto_review"

[mcp_servers.docs]
command = "npx"
args = [
  "-y", "docs-mcp", # [not a table]
]

[projects."/work/app"]
trust_level = "trusted"
`;

test('setup codex --vscode: EvoLink goes into config.toml, the rest stays, the extension is installed, and reset puts it all back', { skip: WIN }, async () => {
  const home = tmpHome();
  fs.mkdirSync(codexDir(home));
  fs.writeFileSync(codexConfig(home), USER_CODEX_CONFIG, { mode: 0o644 });
  const editor = fakeEditorCli(home);
  const before = gw.requests.length;
  const r = await runCli(['setup', 'codex', '--vscode', '--yes'], { home, env: { EVOLINK_API_KEY: CODEX_KEY, PATH: editor.PATH } });
  assert.equal(r.code, 0, r.all);
  noFullKey(r, CODEX_KEY);
  assert.match(r.stdout, /The Codex CLI is not installed; the VS Code extension brings its own Codex/);
  assert.match(r.stdout, /The configured model gpt-5\.5-codex is not available for this key; switching to gpt-6\.1-sol/);
  assert.match(r.stdout, /model_provider\s+evolink-cli/);
  assert.match(r.stdout, /approvals_reviewer\s+auto_review → user/);
  const cfg = fs.readFileSync(codexConfig(home), 'utf8');
  assert.match(cfg, /^model = "gpt-6\.1-sol" {3}# an OpenAI model this key does not have$/m, 'replaced in place, comment kept');
  assert.match(cfg, /^approvals_reviewer = "user"$/m);
  assert.match(cfg, /^model_provider = "evolink-cli"$/m);
  assert.match(cfg, /^web_search = "disabled"$/m);
  assert.ok(cfg.indexOf('model_provider = ') < cfg.indexOf('[mcp_servers.docs]'), 'top-level keys stay above the first table');
  assert.match(cfg, /\n\n# EvoLink, added by `evolink setup codex --vscode` \(undo: evolink reset codex\)\n\[model_providers\.evolink-cli\]\nname = "EvoLink"\nbase_url = "http:\/\/127\.0\.0\.1:\d+\/v1"\nwire_api = "responses"\n/);
  assert.ok(cfg.includes(`experimental_bearer_token = "${CODEX_KEY}"`));
  assert.ok(cfg.includes('args = [\n  "-y", "docs-mcp", # [not a table]\n]\n'), 'the multi-line array is untouched');
  assert.ok(cfg.includes('[projects."/work/app"]\ntrust_level = "trusted"\n'));
  assert.equal(fs.statSync(codexConfig(home)).mode & 0o777, 0o600, 'config.toml now holds the key: owner-only');
  assert.ok(!fs.existsSync(codexProfile(home)), 'no profile in this mode');
  assert.match(fs.readFileSync(editor.calls, 'utf8'), /--install-extension openai\.chatgpt/);
  assert.match(r.stdout, /VS Code: openai\.chatgpt installed/);
  assert.match(r.stdout, /Developer: Reload Window/);
  assert.match(r.stdout, /no ChatGPT sign-in is needed/);
  const resp = gw.requests.slice(before).filter((q) => q.path === '/v1/responses');
  assert.equal(resp.length, 1);
  assert.equal(resp[0].body.model, 'gpt-6.1-sol');

  const again = await runCli(['setup', 'codex', '--vscode', '--yes', '--no-test'], { home, env: { PATH: editor.PATH } });
  assert.equal(again.code, 0, again.all);
  assert.match(again.stdout, /Codex extension: VS Code/);
  assert.match(again.stdout, /Keeping model: gpt-6\.1-sol/);
  assert.match(again.stdout, /Already up to date/);
  assert.match(again.stdout, /VS Code already has openai\.chatgpt/);

  // The extension trusts another folder after setup (Codex appends to config.toml): reset keeps that.
  fs.appendFileSync(codexConfig(home), '\n[projects."/work/other"]\ntrust_level = "trusted"\n');
  const rr = await runCli(['reset', 'codex', '--yes'], { home });
  assert.equal(rr.code, 0, rr.all);
  assert.match(rr.stdout, /put back as it was before setup/);
  assert.equal(fs.readFileSync(codexConfig(home), 'utf8'), `${USER_CODEX_CONFIG}\n[projects."/work/other"]\ntrust_level = "trusted"\n`);
  assert.equal(fs.statSync(codexConfig(home)).mode & 0o777, 0o644, 'the old permissions come back with the key gone');
  const rr2 = await runCli(['reset', 'codex', '--yes'], { home });
  assert.match(rr2.stdout, /No changes recorded by evolink setup codex/);
});

test('setup codex --vscode: dry run and --no-install-extension; a broken or conflicting config.toml stops before writing; Enter means No', { skip: WIN }, async () => {
  const home = tmpHome();
  const editor = fakeEditorCli(home);
  const dry = await runCli(['setup', 'codex', '--vscode', '--yes', '--dry-run'], { home, env: { EVOLINK_API_KEY: CODEX_KEY, PATH: editor.PATH } });
  assert.equal(dry.code, 0, dry.all);
  assert.match(dry.stdout, /\.codex\/config\.toml {2}\(new file\)/);
  assert.match(dry.stdout, /would run .*code --install-extension openai\.chatgpt/);
  assert.match(dry.stdout, /Preview only/);
  assert.ok(!fs.existsSync(codexDir(home)));
  assert.ok(!fs.existsSync(path.join(home, '.evolink')));
  assert.doesNotMatch(fs.readFileSync(editor.calls, 'utf8'), /--install-extension/);

  const noExt = await runCli(['setup', 'codex', '--vscode', '--yes', '--no-test', '--no-install-extension'], { home, env: { EVOLINK_API_KEY: CODEX_KEY, PATH: editor.PATH } });
  assert.equal(noExt.code, 0, noExt.all);
  assert.doesNotMatch(fs.readFileSync(editor.calls, 'utf8'), /--install-extension/);
  assert.match(noExt.stdout, /Install the Codex extension: open vscode:extension\/openai\.chatgpt/);
  assert.equal(readJson(path.join(home, '.evolink', 'state.json')).codex.config.existed, false);
  // Only the extension is set up and there is no Codex CLI: that is fine, the extension brings its own.
  const doc = await runCli(['doctor', 'codex', '--test'], { home, env: { PATH: editor.PATH } });
  assert.equal(doc.code, 0, doc.all);
  assert.match(doc.stdout, /The Codex CLI is not installed; the VS Code extension brings its own Codex/);
  assert.match(doc.stdout, /\| codex missing$/m);
  assert.match(doc.stdout, /Test request passed: gpt-6\.1-sol/);
  // Created by setup: reset deletes the file again.
  const rr = await runCli(['reset', 'codex', '--yes'], { home });
  assert.equal(rr.code, 0, rr.all);
  assert.match(rr.stdout, /deleted \(created by setup\)/);
  assert.ok(!fs.existsSync(codexConfig(home)));

  for (const [bad, why] of [
    ['model_providers.evolink-cli.base_url = "https://example.com/v1"\n', /already defines model_providers\.evolink-cli another way \(line 1\)/],
    ['[model_providers]\nevolink-cli = { name = "x" }\n', /another way \(line 2\)/],
    ['model = "unterminated\n', /is not valid TOML, so it cannot be edited safely \(config\.toml line 1: unterminated string\)/],
  ]) {
    fs.writeFileSync(codexConfig(home), bad);
    const r = await runCli(['setup', 'codex', '--vscode', '--yes', '--no-test', '--no-install-extension'], { home, env: { EVOLINK_API_KEY: CODEX_KEY, PATH: editor.PATH } });
    assert.equal(r.code, 4, r.all);
    assert.match(r.all, why);
    assert.equal(fs.readFileSync(codexConfig(home), 'utf8'), bad, 'left untouched');
  }

  // Interactive: Enter at the model picker, then Enter at the confirmation, whose default is No.
  fs.writeFileSync(codexConfig(home), USER_CODEX_CONFIG);
  const ask = await runCli(['setup', 'codex', '--vscode', '--no-test', '--no-install-extension'], { home, env: { EVOLINK_API_KEY: CODEX_KEY, PATH: editor.PATH }, input: '\n\n' });
  assert.equal(ask.code, 130, ask.all);
  assert.match(ask.stdout, /a plain `codex` in the terminal will all use EvoLink/);
  assert.match(ask.stdout, /Change config\.toml\? \[y\/N\]/);
  assert.equal(fs.readFileSync(codexConfig(home), 'utf8'), USER_CODEX_CONFIG);
});

test('doctor codex in VS Code mode; reset undoes the profile and config.toml together and leaves later edits alone', { skip: WIN }, async () => {
  const home = tmpHome();
  const PATHV = fakeCodex(home);
  await runCli(['setup', 'codex', '--yes', '--no-test', '--registry', gw.url], { home, env: { EVOLINK_API_KEY: CODEX_KEY, PATH: PATHV } });
  const s = await runCli(['setup', 'codex', '--vscode', '--yes', '--no-test', '--no-install-extension', '--registry', gw.url], { home, env: { PATH: PATHV } });
  assert.equal(s.code, 0, s.all);
  assert.ok(fs.readFileSync(codexConfig(home), 'utf8').includes(CODEX_KEY), 'the key came from the profile');
  const d = await runCli(['doctor', 'codex', '--test', '--registry', gw.url], { home, env: { PATH: PATHV } });
  assert.equal(d.code, 0, d.all);
  noFullKey(d, CODEX_KEY);
  assert.match(d.stdout, /config\.toml \(VS Code mode: the extension and a plain codex use it\)/);
  assert.match(d.stdout, /^vscode: yes provider=evolink-cli base=http:\/\/127\.0\.0\.1:\d+\/v1 key=sk-Cx7G…p6Td model=gpt-6\.1-sol web_search=disabled reviewer=-$/m);
  assert.match(d.stdout, /^extension: none$/m);
  assert.match(d.stdout, /Test request passed: gpt-6\.1-sol/);

  fs.chmodSync(codexConfig(home), 0o644);
  const loose = await runCli(['doctor', 'codex'], { home, env: { PATH: PATHV } });
  assert.match(loose.stdout, /holds the key but others can read it \(mode 644\)/);
  fs.chmodSync(codexConfig(home), 0o600);

  // Later edits: the model is switched by hand and the key in the table is replaced. Reset leaves both.
  const edited = fs.readFileSync(codexConfig(home), 'utf8').replace('model = "gpt-6.1-sol"', 'model = "gpt-6-luna"').replace(CODEX_KEY, KEY);
  fs.writeFileSync(codexConfig(home), edited);
  const rr = await runCli(['reset', 'codex', '--yes'], { home });
  assert.equal(rr.code, 0, rr.all);
  assert.match(rr.stdout, /Changed in config\.toml since setup, left as is: model, \[model_providers\.evolink-cli\]/);
  assert.ok(!fs.existsSync(codexProfile(home)), 'the profile is undone too');
  const left = fs.readFileSync(codexConfig(home), 'utf8');
  assert.doesNotMatch(left, /^model_provider = /m);
  assert.doesNotMatch(left, /^web_search = /m);
  assert.match(left, /^model = "gpt-6-luna"$/m);
  assert.match(left, /\[model_providers\.evolink-cli\]/);

  // model_provider pointing elsewhere while our table is still there: doctor says the table is not in use.
  const d2 = await runCli(['doctor', 'codex'], { home, env: { PATH: PATHV } });
  assert.equal(d2.code, 1, d2.all);
  assert.match(d2.stdout, /model_provider = \(unset\): \[model_providers\.evolink-cli\] is not in use/);
});

test('setup codex --vscode on a CRLF config.toml (as Notepad writes it): written in CRLF, undone byte for byte', async () => {
  const home = tmpHome();
  fs.mkdirSync(codexDir(home));
  const crlf = '\uFEFF# edited in Notepad\r\nmodel = "gpt-5.5"\r\n\r\n[projects."C:\\\\work\\\\app"]\r\ntrust_level = "trusted"\r\n';
  fs.writeFileSync(codexConfig(home), crlf);
  const r = await runCli(['setup', 'codex', '--vscode', '--yes', '--no-test', '--no-install-extension'], { home, env: { EVOLINK_API_KEY: CODEX_KEY } });
  assert.equal(r.code, 0, r.all);
  const cfg = fs.readFileSync(codexConfig(home), 'utf8');
  assert.ok(cfg.startsWith('\uFEFF# edited in Notepad\r\nmodel = "gpt-5.5"\r\nmodel_provider = "evolink-cli"\r\nweb_search = "disabled"\r\n'), JSON.stringify(cfg.slice(0, 120)));
  assert.doesNotMatch(cfg.replace(/\r\n/g, ''), /\n/, 'every line ends in CRLF');
  assert.match(cfg, /\[model_providers\.evolink-cli\]\r\n/);
  const rr = await runCli(['reset', 'codex', '--yes'], { home });
  assert.equal(rr.code, 0, rr.all);
  assert.equal(fs.readFileSync(codexConfig(home), 'utf8'), crlf);
});


// VS Code Chat (setup copilot): chatLanguageModels.json in the VS Code user folder

function vscodeUserDir(home) {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  if (WIN) return path.join(home, 'AppData', 'Roaming', 'Code', 'User');
  return path.join(home, '.config', 'Code', 'User');
}
const chatModelsFile = (home) => path.join(vscodeUserDir(home), 'chatLanguageModels.json');

test('setup copilot: an EvoLink group in chatLanguageModels.json, one test per API type, the key reference kept, reset', async () => {
  const home = tmpHome();
  fs.mkdirSync(vscodeUserDir(home), { recursive: true });
  const before = gw.requests.length;
  const r = await runCli(['setup', 'copilot', '--yes'], { home, env: { EVOLINK_API_KEY: CHAT_KEY } });
  assert.equal(r.code, 0, r.all);
  noFullKey(r, CHAT_KEY);
  assert.match(r.stdout, /Key is valid \(sk-Ch4T…m0Dl\) · 6 models, 4 usable in Chat/, 'Gemini held back, the image model is not a chat model');
  assert.match(r.stdout, /Gemini \(1\) is left out for now/);
  const text = fs.readFileSync(chatModelsFile(home), 'utf8');
  assert.ok(!text.includes(CHAT_KEY.slice(3)), 'the key is never written into the file');
  const groups = JSON.parse(text);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'EvoLink');
  assert.equal(groups[0].vendor, 'customendpoint');
  assert.equal(groups[0].apiKey, undefined);
  const byId = Object.fromEntries(groups[0].models.map((m) => [m.id, m]));
  assert.deepEqual(Object.keys(byId), ['claude-haiku-4-5-20251001', 'gpt-6-luna', 'deepseek-v4-flash', 'kimi-k3']);
  assert.equal(byId['claude-haiku-4-5-20251001'].url, `${gw.url}/v1/messages`);
  assert.equal(byId['gpt-6-luna'].apiType, 'responses');
  assert.equal(byId['deepseek-v4-flash'].url, `${gw.url}/v1/chat/completions`);
  assert.equal(byId['deepseek-v4-flash'].contextWindow, 1000000, 'from the price list');
  assert.equal(byId['kimi-k3'].contextWindow, 128000, 'not in the price list: the default');
  const reqs = gw.requests.slice(before).filter((q) => q.method === 'POST');
  assert.deepEqual(reqs.map((q) => `${q.path} ${q.body.model}`).sort(), ['/v1/chat/completions deepseek-v4-flash', '/v1/messages claude-haiku-4-5-20251001', '/v1/responses gpt-6-luna']);
  assert.ok(reqs.every((q) => q.keyUsed === CHAT_KEY.slice(3)));
  assert.match(r.stdout, /Right-click the "EvoLink" group → "Update API Key"/);

  const again = await runCli(['setup', 'copilot', '--yes', '--no-test'], { home, env: { EVOLINK_API_KEY: CHAT_KEY } });
  assert.match(again.stdout, /Already up to date/);

  // VS Code stored the key (it writes a reference), and the user has another provider: both survive a re-run.
  const mine = { name: 'Mine', vendor: 'openai', apiKey: '${input:chat.lm.secret.0001}', models: [{ id: 'x', name: 'X' }] };
  groups[0].apiKey = '${input:chat.lm.secret.ab12}';
  fs.writeFileSync(chatModelsFile(home), JSON.stringify([mine, groups[0]], null, '\t'));
  const all = await runCli(['setup', 'copilot', '--yes', '--no-test', '--all-models'], { home, env: { EVOLINK_API_KEY: CHAT_KEY } });
  assert.equal(all.code, 0, all.all);
  assert.match(all.stdout, /A key is already set in VS Code/);
  const after = JSON.parse(fs.readFileSync(chatModelsFile(home), 'utf8'));
  assert.deepEqual(after[0], mine);
  assert.equal(after[1].apiKey, '${input:chat.lm.secret.ab12}');
  assert.deepEqual(after[1].models.map((m) => m.id), ['claude-haiku-4-5-20251001', 'deepseek-v4-flash', 'gpt-6-luna', 'kimi-k3']);

  const d = await runCli(['doctor', 'copilot'], { home });
  assert.equal(d.code, 0, d.all);
  assert.match(d.stdout, /VS Code: a key is set in VS Code/);
  assert.match(d.stdout, /^VS Code: group=yes models=4 key=set non_evolink=0 gemini=0$/m);

  const rr = await runCli(['reset', 'copilot', '--yes'], { home });
  assert.equal(rr.code, 0, rr.all);
  assert.match(rr.stdout, /The key VS Code saved in its keychain stays there/);
  assert.deepEqual(JSON.parse(fs.readFileSync(chatModelsFile(home), 'utf8')), [mine], 'only our group goes');
});

test('setup copilot: no desktop VS Code, the Remote-SSH hint, dry run, doctor without a key or with a plain key, plain reset', async () => {
  const none = tmpHome();
  const n = await runCli(['setup', 'copilot', '--yes'], { home: none, env: { EVOLINK_API_KEY: CHAT_KEY } });
  assert.equal(n.code, 3, n.all);
  assert.match(n.all, /No desktop VS Code user folder found/);
  fs.mkdirSync(path.join(none, '.vscode-server'));
  const remote = await runCli(['setup', 'copilot', '--yes'], { home: none, env: { EVOLINK_API_KEY: CHAT_KEY } });
  assert.match(remote.all, /run this there, not on the Remote-SSH side/);

  const home = tmpHome();
  fs.mkdirSync(vscodeUserDir(home), { recursive: true });
  const dry = await runCli(['setup', 'copilot', '--yes', '--dry-run'], { home, env: { EVOLINK_API_KEY: CHAT_KEY } });
  assert.equal(dry.code, 0, dry.all);
  assert.match(dry.stdout, /Preview only/);
  assert.ok(!fs.existsSync(chatModelsFile(home)));

  await runCli(['setup', 'copilot', '--yes', '--no-test'], { home, env: { EVOLINK_API_KEY: CHAT_KEY } });
  const d = await runCli(['doctor', 'copilot'], { home });
  assert.equal(d.code, 1, d.all);
  assert.match(d.stdout, /no key pasted in VS Code yet/);
  assert.match(d.stdout, /^VS Code: group=yes models=4 key=missing/m);
  const g = JSON.parse(fs.readFileSync(chatModelsFile(home), 'utf8'));
  g[0].apiKey = 'sk-plain-key-in-the-file';
  fs.writeFileSync(chatModelsFile(home), JSON.stringify(g));
  const d2 = await runCli(['doctor', 'copilot'], { home });
  assert.match(d2.stdout, /the file holds a plain key, which VS Code ignores/);

  // Created by setup and holding nothing else: a plain reset deletes the file.
  g[0].apiKey = undefined;
  fs.writeFileSync(chatModelsFile(home), JSON.stringify(g));
  const rr = await runCli(['reset', '--yes', '--json'], { home });
  assert.equal(rr.code, 0, rr.all);
  assert.ok(JSON.parse(rr.stdout).ok);
  assert.ok(!fs.existsSync(chatModelsFile(home)));
});
