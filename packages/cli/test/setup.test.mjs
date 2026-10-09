import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setup } from '../src/setup.mjs';
import { doctor } from '../src/doctor.mjs';
import { skillStatus, installSkill } from '../src/skills.mjs';
import { State } from '../src/state.mjs';
import { Credentials, callbackListener } from '../src/auth.mjs';
import { Mcp } from '../src/mcp.mjs';
import { CliError } from '../src/errors.mjs';
import { fixture, MemoryVault } from './fixture.mjs';
import { validateCommand } from '../src/cli.mjs';

const agents = ['codex', 'claude-code', 'cursor', 'gemini', 'opencode', 'copilot', 'openclaw', 'hermes'];
async function temporary(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-setup-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}
async function context(t) {
  const f = await fixture(); t.after(f.close);
  const home = await temporary(t), vault = new MemoryVault(), state = new State(path.join(home, 'state'));
  const credentials = new Credentials({ server: f.server, state, vault });
  const mcp = new Mcp(credentials);
  const login = credentials.login.bind(credentials);
  const progress = [];
  credentials.login = options => login({ ...options, browser: async url => { await fetch(url); } });
  return { f, home, vault, state, credentials, mcp,
    options: { state, server: f.server, credentials, mcp, skillHome: home, agent: 'codex', progress: text => progress.push(text) }, progress };
}

test('SDK OAuth and MCP setup reuses a verified login and concurrent setup creates no paid tasks', async t => {
  const { f, home, options, progress, vault } = await context(t);
  const results = await Promise.all([setup(options), setup(options)]);
  assert.ok(results.every(r => r.ok && r.setup_complete && r.connection_verified && r.model_discovery_verified));
  assert.equal(results[0].steps.find(s => s.name === 'login').reused, false);
  assert.equal(results[1].steps.find(s => s.name === 'login').reused, true);
  assert.equal(f.clients.length, 1); assert.equal(f.paid.size, 0);
  assert.equal(results[0].assistant_discovery, 'not_checked');
  assert.equal((await skillStatus({ home, agent: 'codex' })).current, true);
  assert.ok(progress.some(s => s.includes('waiting for browser approval')));
  assert.ok(progress.some(s => s.includes('browser approval received')));
  vault.value.expires_at = 0;
  const renewed = await setup(options);
  assert.equal(renewed.ok, true); assert.equal(f.refreshCount, 1); assert.equal(f.clients.length, 1);
  assert.equal(renewed.skills.updated, false);
});

test('setup cross-combinations keep failures in their stage and stop before paid submission (seed 20261009)', async t => {
  let seed = 20261009;
  const random = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const combinations = agents.flatMap(agent => [false, true].flatMap(authenticated => ['healthy', 'network', 'models', 'empty'].map(failure => ({ agent, authenticated, failure }))));
  for (let i = combinations.length - 1; i > 0; i--) { const j = random() % (i + 1); [combinations[i], combinations[j]] = [combinations[j], combinations[i]]; }
  for (const { agent, authenticated, failure } of combinations) {
    const home = await temporary(t), calls = [];
    let loggedIn = authenticated, logins = 0;
    const credentials = { status: async () => ({ authenticated: loggedIn }), login: async () => { loggedIn = true; logins++; } };
    const mcp = { call: async name => {
      calls.push(name);
      assert.ok(['check_balance', 'search_models'].includes(name));
      if (name === 'check_balance' && failure === 'network') throw new CliError('connection_failed', 'Temporarily unavailable.');
      if (name === 'search_models' && failure === 'models') throw new CliError('tool_failed', 'Catalog unavailable.');
      return name === 'search_models' ? { ok: true, models: failure === 'empty' ? [] : [{ id: 'fixture-image' }] } : { ok: true };
    } };
    const result = await setup({ state: new State(path.join(home, 'state')), server: new URL('https://mcp.evolink.ai/mcp'), credentials, mcp, skillHome: home, agent });
    assert.equal(result.ok, failure === 'healthy');
    assert.equal(logins, authenticated ? 0 : 1);
    assert.equal(result.connection_verified, failure !== 'network');
    assert.equal(result.model_discovery_verified, failure === 'healthy');
    if (!result.ok) assert.equal(result.phase, failure === 'network' ? 'connection' : 'models');
    assert.equal(result.assistant_discovery, 'not_checked');
  }
});

test('revoked refresh credentials require a fresh browser approval and recover through setup', async t => {
  const { f, options, credentials, vault } = await context(t);
  assert.equal((await setup(options)).ok, true);
  vault.value.expires_at = 0;
  const originalFetch = credentials.fetchFn;
  let refused = false;
  credentials.fetchFn = async (url, init) => {
    if (!refused && new URL(url).pathname === '/oauth/token' && new URLSearchParams(init?.body).get('grant_type') === 'refresh_token') {
      refused = true;
      return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Fixture refresh grant revoked.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, init);
  };
  const result = await setup(options);
  assert.equal(refused, true); assert.equal(result.ok, true);
  assert.equal(result.steps.find(s => s.name === 'login').reused, false);
  assert.equal(f.paid.size, 0);
});

test('setup handles missing credentials, login timeout, denied approval, conflicts and recovery without repeating completed steps', async t => {
  const { f, home, options, credentials } = await context(t);
  const unavailable = { ...options, credentials: { status: async () => { throw new CliError('credential_store_unavailable', 'Unlock secure storage.'); } } };
  assert.equal((await setup(unavailable)).phase, 'preflight'); assert.equal(f.clients.length, 0);
  for (const code of ['login_timeout', 'login_denied', 'interrupted']) {
    const result = await setup({ ...options, credentials: { status: async () => ({ authenticated: false }), login: async () => { throw new CliError(code, 'Login did not finish.'); } } });
    assert.equal(result.phase, 'login'); assert.equal(result.error.code, code);
    assert.equal(result.skills.updated, code === 'login_timeout');
    assert.match(result.recovery, /setup --agent codex/);
    assert.equal(result.setup_complete, false);
  }
  const installed = await installSkill({ home, agent: 'codex' });
  await fs.appendFile(installed.path, '\nUser-specific instruction.\n');
  const conflict = await setup(options);
  assert.equal(conflict.phase, 'skills'); assert.equal(conflict.error.code, 'skill_modified');
  assert.equal(f.clients.length, 0); assert.equal(f.paid.size, 0);
  await installSkill({ home, agent: 'codex', replaceModified: true });
  assert.equal((await setup(options)).ok, true);
  let loginCount = 0;
  const actualLogin = credentials.login;
  credentials.login = async opts => { loginCount++; return actualLogin(opts); };
  const actualCall = options.mcp.call.bind(options.mcp);
  let expired = true;
  const recovered = await setup({ ...options, mcp: { call: async (name, args) => {
    if (expired) { expired = false; throw new CliError('login_required', 'Expired session.'); }
    return actualCall(name, args);
  } } });
  assert.equal(recovered.ok, true); assert.equal(loginCount, 1);
});

test('doctor verifies the model catalog and selected skill files but leaves assistant discovery unverified', async t => {
  const { home, options } = await context(t);
  assert.equal((await setup(options)).ok, true);
  const healthy = await doctor({ ...options, agent: 'codex' });
  assert.equal(healthy.ok, true); assert.equal(healthy.checks.length, 7);
  assert.equal(healthy.assistant_discovery, 'not_checked');
  const installed = (await skillStatus({ home, agent: 'codex' })).installations[0];
  await fs.appendFile(installed.path, '\nLocal change.');
  const modified = await doctor({ ...options, agent: 'codex' });
  assert.equal(modified.ok, false); assert.equal(modified.connection_verified, true);
  assert.equal(modified.checks.find(c => c.name === 'skills').installations[0].status, 'modified');
});

test('callbacks reject repeat use, timeouts and cancellation without echoing authorization codes', async () => {
  const accepted = await callbackListener({ state: 'fixture-state', issuer: 'https://passport.evolink.ai' });
  try {
    const url = new URL(accepted.redirectUrl);
    url.searchParams.set('state', 'fixture-state'); url.searchParams.set('iss', 'https://passport.evolink.ai'); url.searchParams.set('code', 'fixture-private-code');
    const response = await fetch(url), html = await response.text();
    assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /nonce-/);
    assert.ok(html.includes('history.replaceState')); assert.ok(!html.includes('fixture-private-code'));
    assert.equal(await accepted.code, 'fixture-private-code');
    assert.equal((await fetch(url)).status, 410);
  } finally { await accepted.close(); }
  const timeout = await callbackListener({ state: 'fixture', issuer: 'https://passport.evolink.ai', timeout: 10 });
  try { await assert.rejects(timeout.code, { code: 'login_timeout' }); } finally { await timeout.close(); }
  const controller = new AbortController();
  const aborted = await callbackListener({ state: 'fixture', issuer: 'https://passport.evolink.ai', signal: controller.signal });
  try { controller.abort(); await assert.rejects(aborted.code, { code: 'interrupted' }); } finally { await aborted.close(); }
});

test('new CLI arguments reject invalid agents and timeouts before credential access (one JSON envelope)', async () => {
  const bin = fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
  for (const [args, expected] of [
    [['setup', '--agent', 'unknown'], 'invalid_agent'], [['setup', '--timeout', '29'], 'invalid_option'],
    [['auth', 'login', '--timeout', '901'], 'invalid_option'], [['setup', '--token-stdin'], 'invalid_option'],
    [['doctor', '--replace-modified'], 'invalid_option'], [['tasks', 'list', '--status', 'pending'], 'invalid_status'],
  ]) {
    const child = spawn(process.execPath, [bin, ...args, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', b => stdout += b);
    const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    assert.equal(code, 1); assert.equal(stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(stdout).error.code, expected);
  }
});

test('setup and login timeout/agent/browser argument combinations preserve boundaries (seed 20261009)', () => {
  let seed = 20261009;
  const random = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const values = ['29', '30', '180', '900', '901', '0', 'NaN', '', '30.5', ' 30 '];
  const cases = agents.flatMap(agent => values.flatMap(timeout => [false, true].map(noBrowser => ({ agent, timeout, noBrowser, command: ['setup'] }))));
  cases.push(...values.flatMap(timeout => [false, true].map(noBrowser => ({ timeout, noBrowser, command: ['auth', 'login'] }))));
  for (let i = cases.length - 1; i > 0; i--) { const j = random() % (i + 1); [cases[i], cases[j]] = [cases[j], cases[i]]; }
  assert.equal(cases.length, 180);
  for (const { agent, timeout, noBrowser, command } of cases) {
    const options = { timeout, 'no-browser': noBrowser, json: true, ...(agent ? { agent } : {}) };
    const valid = timeout.trim() !== '' && Number.isInteger(Number(timeout)) && Number(timeout) >= 30 && Number(timeout) <= 900;
    if (valid) assert.doesNotThrow(() => validateCommand(command, options));
    else assert.throws(() => validateCommand(command, options), { code: 'invalid_option' });
  }
});
