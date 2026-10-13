import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Credentials, callbackListener } from '../src/auth.mjs';
import { State } from '../src/state.mjs';
import { authFetch, serverURL } from '../src/network.mjs';
import { fixture, MemoryVault } from './fixture.mjs';
import { CliError, errorView } from '../src/errors.mjs';

test('SDK OAuth registration, PKCE callback, refresh and revocation round trip', async t => {
  const f = await fixture(); t.after(f.close);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-auth-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const vault = new MemoryVault(); const state = new State(home);
  const credentials = new Credentials({ server: f.server, state, vault });
  const result = await credentials.login({ progress: () => {}, browser: async url => { await fetch(url); } });
  assert.equal(result.authenticated, true); assert.equal(f.clients.length, 1);
  assert.equal(f.clients[0].token_endpoint_auth_method, 'none'); assert.equal(f.clients[0].scope, 'mcp offline_access');
  assert.equal(vault.value.tokens.issuer, f.origin);
  const old = structuredClone(vault.value); vault.value.expires_at = 0;
  const renewed = await credentials.access();
  assert.equal(renewed.binding, old.binding); assert.notEqual(renewed.access_token, old.tokens.access_token); assert.equal(f.refreshCount, 1);
  const contents = await fs.readFile(state.file('clients', (await import('../src/state.mjs')).hash(f.server.href)), 'utf8');
  assert.ok(!contents.includes('fixture-access')); assert.ok(!contents.includes('fixture-refresh')); assert.ok(!contents.includes('code_verifier'));
  f.revokeFails = true;
  await assert.rejects(credentials.logout(), { code: 'logout_failed' }); assert.ok(vault.value.tokens);
  f.revokeFails = false;
  await credentials.logout(); assert.equal(vault.value, undefined);
});

test('callback rejects wrong state, wrong issuer and wrong methods', async () => {
  const listener = await callbackListener({ state: 'expected', issuer: 'https://passport.evolink.ai', timeout: 1000 });
  try {
    const url = new URL(listener.redirectUrl);
    url.searchParams.set('code', 'one-code'); url.searchParams.set('iss', 'https://passport.evolink.ai'); url.searchParams.set('state', 'wrong');
    assert.equal((await fetch(url)).status, 400);
    url.searchParams.set('state', 'expected'); url.searchParams.set('iss', 'https://attacker.example');
    assert.equal((await fetch(url)).status, 400);
    url.searchParams.set('iss', 'https://passport.evolink.ai');
    assert.equal((await fetch(url, { method: 'POST' })).status, 400);
    assert.equal((await fetch(url)).status, 200); assert.equal(await listener.code, 'one-code');
  } finally { await listener.close(); }
});

test('auth origin policy prevents credential forwarding and unsafe server URLs', async () => {
  let called = false;
  const fn = authFetch(serverURL(), async () => { called = true; });
  await assert.rejects(fn('https://attacker.example/oauth/token', { method: 'POST', body: 'refresh_token=private' }), { code: 'untrusted_auth_server' });
  assert.equal(called, false);
  for (const url of ['http://mcp.evolink.ai/mcp', 'https://mcp.evolink.ai/mcp?token=abc', 'file:///tmp/a', 'http://localhost:1/mcp', 'https://other.example/mcp']) assert.throws(() => serverURL(url));
  assert.equal(serverURL('http://127.0.0.1:9999/mcp').hostname, '127.0.0.1');
});

test('error envelopes preserve recovery information and remove credential material', () => {
  const result = errorView(new CliError('fixture_error', 'Authorization: Bearer test-secret', {
    quote_id: 'quote-id', nested: { access_token: 'private-access', refresh_token: 'private-refresh', upload_url: 'https://example.com/?token=private-upload',
      message: 'Bearer test-secret', _binding: 'private-binding' }, recovery: 'tasks resume' }));
  const serialized = JSON.stringify(result);
  for (const secret of ['test-secret', 'private-access', 'private-refresh', 'private-upload', 'private-binding']) assert.ok(!serialized.includes(secret));
  assert.equal(result.details.quote_id, 'quote-id'); assert.equal(result.details.recovery, 'tasks resume');
});

test('auth status is an offline view: an elapsed access token renews itself and is not an expired login', async t => {
  const f = await fixture(); t.after(f.close);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-status-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const vault = new MemoryVault(); const state = new State(home);
  const credentials = new Credentials({ server: f.server, state, vault });
  const before = await credentials.status();
  assert.equal(before.authenticated, false); assert.match(before.text, /auth login/); assert.equal('access_token_expires_at' in before, false);
  const progress = [];
  const update = async () => ({ status: 'available', update_available: true, current_version: '0.9.2', latest_version: '0.9.3', command: 'npm install -g @evolinkai/cli@latest' });
  const login = await credentials.login({ progress: message => progress.push(message), browser: async url => { await fetch(url); }, update });
  assert.equal(login.authenticated, true); assert.equal(login.update.latest_version, '0.9.3');
  assert.ok(progress.some(message => message.includes('0.9.3') && message.includes('npm install -g @evolinkai/cli@latest') && message.includes('skills install')));
  const signedIn = await credentials.status();
  assert.equal(signedIn.authenticated, true); assert.equal('expires_at' in signedIn, false);
  assert.ok(Date.parse(signedIn.access_token_expires_at) > Date.now()); assert.ok(Date.parse(signedIn.logged_in_at) <= Date.now());
  assert.equal(signedIn.access_token_renewal, 'automatic'); assert.equal(signedIn.login_check, 'evolink balance --json');
  assert.match(signedIn.note, /does not mean the login expired/); assert.match(signedIn.text, /balance --json/);
  // The access token lapsed (for example overnight): status still reports the saved login and the next command renews.
  vault.value.expires_at = 0;
  const elapsed = await credentials.status();
  assert.equal(elapsed.authenticated, true); assert.equal(elapsed.access_token_expires_at, new Date(0).toISOString());
  assert.equal(elapsed.logged_in_at, signedIn.logged_in_at);
  assert.ok((await credentials.access()).access_token); assert.equal(f.refreshCount, 1);
  const renewed = await credentials.status();
  assert.ok(Date.parse(renewed.access_token_expires_at) > Date.now()); assert.equal(renewed.logged_in_at, signedIn.logged_in_at);
  const quiet = await credentials.login({ progress: message => progress.push(message), browser: async url => { await fetch(url); },
    update: async () => ({ status: 'current', update_available: false, current_version: '0.9.2', latest_version: '0.9.2', command: 'npm install -g @evolinkai/cli@latest' }) });
  assert.equal(quiet.update.update_available, false);
  assert.equal(progress.filter(message => message.includes('npm install')).length, 1);
  assert.equal('update' in await credentials.login({ progress: () => {}, browser: async url => { await fetch(url); } }), false);
  // A failed registry check never turns a completed login into an error.
  const unchecked = await credentials.login({ progress: () => {}, browser: async url => { await fetch(url); }, update: async () => { throw new Error('registry down'); } });
  assert.equal(unchecked.authenticated, true); assert.equal('update' in unchecked, false);
});

test('a failed login still names an available update; an interrupted login does not', { timeout: 30_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-login-update-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const credentials = new Credentials({ server: f.server, state: new State(home), vault: new MemoryVault() });
  const update = async () => ({ status: 'available', update_available: true, current_version: '0.9.2', latest_version: '0.9.3', command: 'npm install -g @evolinkai/cli@latest' });
  // The browser returns a code the login service never issued, so the token exchange fails after approval.
  const browser = async url => {
    const approval = await fetch(url, { redirect: 'manual' });
    const callback = new URL(approval.headers.get('location'));
    callback.searchParams.set('code', 'never-issued');
    await fetch(callback);
  };
  const progress = [];
  await assert.rejects(credentials.login({ progress: message => progress.push(message), browser, update }));
  assert.ok(progress.some(message => message.includes('0.9.3') && message.includes('npm install -g @evolinkai/cli@latest')));
  const controller = new AbortController(), interrupted = [];
  await assert.rejects(credentials.login({ progress: message => interrupted.push(message), browser: async () => controller.abort(), signal: controller.signal, update }),
    { code: 'interrupted' });
  assert.equal(interrupted.some(message => message.includes('npm install')), false);
});
