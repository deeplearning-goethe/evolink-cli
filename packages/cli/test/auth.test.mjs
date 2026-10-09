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
