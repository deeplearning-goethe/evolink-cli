import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Api } from '../src/api.mjs';
import { Credentials } from '../src/auth.mjs';
import { Media } from '../src/media.mjs';
import { State } from '../src/state.mjs';
import { upload, getUpload } from '../src/files.mjs';
import { serviceURL, SERVER, API, FILES } from '../src/network.mjs';
import { fixture, MemoryVault } from './fixture.mjs';

async function context(t, { token = 'fixture-direct-access' } = {}) {
  const f = await fixture(); t.after(f.close); f.mcpUnavailable = true;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-direct-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const state = new State(home), vault = new MemoryVault();
  const credentials = new Credentials({ state, server: f.server, vault, token });
  const client = new Api(credentials), media = new Media({ mcp: client, state, server: f.server });
  return { f, home, state, vault, credentials, client, media };
}

test('direct Passport login, refresh and revocation do not discover or call MCP', async t => {
  const { f, credentials, vault } = await context(t, { token: undefined });
  // Explicitly turn off stdin mode for this browser-login test.
  credentials.token = undefined;
  await credentials.login({ browser: url => fetch(url), progress: () => {} });
  const binding = vault.value.binding; vault.value.expires_at = 0;
  assert.equal((await credentials.access()).binding, binding); assert.equal(f.refreshCount, 1);
  await credentials.logout();
  assert.equal(f.protectedDiscoveryCalls || 0, 0); assert.equal(f.mcpRequests || 0, 0);
});

test('REST discovery, quote and paid replay remain available while MCP is unavailable', async t => {
  const { f, media, client, state } = await context(t);
  assert.equal((await client.call('check_balance')).account_balance_credits, 1000);
  const q = await media.estimate({ model: 'fixture-image', input: { prompt: 'test' }, max_cost_usd: 0.03 });
  await assert.rejects(media.generate('image', q.quote_id), { code: 'confirmation_required' });
  f.loseRestSubmissions = 2;
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), { code: 'outcome_unknown' });
  assert.equal(f.paid.size, 1); assert.equal((await state.read('quotes', q.quote_id)).state, 'outcome_unknown');
  const task = await media.resume(q.quote_id); assert.equal(f.paid.size, 1); assert.equal(task.replayed, true);
  const paidCalls = f.calls.filter(call => call.name === 'generate_image');
  assert.equal(new Set(paidCalls.map(call => call.args.client_request_id)).size, 1);
  assert.equal(f.mcpRequests || 0, 0);
  for (const call of f.restCalls) {
    assert.match(call.headers['user-agent'], /^EvoLinkCLI\//);
    assert.equal(call.headers['x-evo-client'], 'cli');
    if (call.path.startsWith('/v1/catalog/') || call.path.startsWith('/web/')) assert.equal(call.headers.authorization, undefined);
  }
});

test('fresh platform prices block an already approved quote when the price changes', async t => {
  const { f, media } = await context(t);
  const q = await media.estimate({ model: 'fixture-image', input: { prompt: 'test' }, max_cost_usd: 0.05 });
  f.multiplier = 2;
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), { code: 'price_changed' });
  assert.equal(f.paid.size, 0);
});

test('interrupted direct submit preserves unknown outcome and recovers without another intent', async t => {
  const { f, state, credentials } = await context(t);
  const controller = new AbortController();
  const client = new Api(credentials, { signal: controller.signal });
  const media = new Media({ client, state, server: f.server });
  const q = await media.estimate({ model: 'fixture-image', input: { prompt: 'interrupt' } });
  f.beforeSubmit = () => controller.abort();
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), error => error.code === 'interrupted' && error.details.charged === 'unknown');
  assert.equal(f.paid.size, 1); assert.equal((await state.read('quotes', q.quote_id)).state, 'outcome_unknown');
  f.beforeSubmit = undefined;
  const recovered = new Media({ client: new Api(credentials), state, server: f.server });
  assert.ok((await recovered.resume(q.quote_id)).task_id); assert.equal(f.paid.size, 1);
  assert.equal(new Set(f.calls.filter(call => call.name === 'generate_image').map(call => call.args.client_request_id)).size, 1);
});

test('shared caches remain separated between two platform origins', async t => {
  const a = await context(t), b = await context(t); b.f.multiplier = 2;
  const [qa, qb] = await Promise.all([a.media.estimate({ model: 'fixture-image', input: { prompt: 'a' } }), b.media.estimate({ model: 'fixture-image', input: { prompt: 'b' } })]);
  assert.equal(qa.estimate.max_usd, 0.02); assert.equal(qb.estimate.max_usd, 0.04);
});

test('direct upload streams original bytes with an evup token and saves a credential-free receipt', async t => {
  const { f, home, client, state } = await context(t);
  const file = path.join(home, 'reference.png'); await fs.writeFile(file, f.bytes);
  const result = await upload(file, { mcp: client, state, server: f.server });
  assert.deepEqual(f.uploadedBytes, f.bytes); assert.equal(result.state, 'done');
  assert.equal(f.uploadHeaders[0].authorization, 'Bearer evup_fixture-short-lived');
  assert.equal(f.uploadHeaders[0].cookie, undefined);
  assert.deepEqual(await getUpload(result.upload_id, { client, state, server: f.server }), result);
  const stored = await fs.readFile(state.file('uploads', result.upload_id), 'utf8');
  for (const value of ['fixture-direct-access', 'evup_fixture', 'upload_token', 'upload_url']) assert.equal(stored.includes(value), false);
  assert.equal(f.mcpRequests || 0, 0);
});

test('a lost upload reply stays unknown and a recovery read never uploads again', async t => {
  const { f, home, client, state } = await context(t); f.loseRestUploadReply = true;
  const file = path.join(home, 'reference.png'); await fs.writeFile(file, f.bytes);
  let id;
  await assert.rejects(upload(file, { mcp: client, state, server: f.server }), error => { id = error.details.upload_id; return error.code === 'upload_unknown'; });
  assert.equal((await getUpload(id, { client, state, server: f.server })).result_verified, false);
  assert.equal(f.uploadHeaders.length, 1);
});

test('saved task recovery from a pre-split quote only reads the original task', async t => {
  const { f, media, state } = await context(t);
  const q = await media.estimate({ model: 'fixture-image', input: { prompt: 'test' } });
  const task = await media.generate('image', q.quote_id, { confirmed: true });
  const saved = await state.read('quotes', q.quote_id); delete saved.backend; delete saved.api_origin;
  await state.write('quotes', q.quote_id, saved);
  const before = f.calls.filter(call => call.name === 'generate_image').length;
  assert.equal((await media.resume(q.quote_id)).task_id, task.task_id);
  assert.equal(f.calls.filter(call => call.name === 'generate_image').length, before);
});

test('quotes cannot cross platform origins, and service URLs reject credential forwarding', async t => {
  const { media, state } = await context(t);
  const q = await media.estimate({ model: 'fixture-image', input: { prompt: 'test' } });
  const saved = await state.read('quotes', q.quote_id); saved.api_origin = 'https://other.example'; await state.write('quotes', q.quote_id, saved);
  await assert.rejects(media.generate('image', q.quote_id, { confirmed: true }), { code: 'quote_platform_changed' });
  for (const target of ['https://other.example', 'http://127.0.0.1:80', 'https://api.evolink.ai/?secret=x', 'https://x@api.evolink.ai']) {
    assert.throws(() => serviceURL(target, API, new URL(SERVER)));
  }
  assert.equal(serviceURL(FILES, FILES, new URL(SERVER)).origin, FILES);
});

test('native OAuth rejects a metadata endpoint on another origin before sending credentials', async t => {
  const { credentials, f } = await context(t); credentials.token = undefined;
  credentials.fetchFn = async () => new Response(JSON.stringify({ issuer: f.origin, code_challenge_methods_supported: ['S256'],
    authorization_endpoint: `${f.origin}/oauth/authorize`, registration_endpoint: `${f.origin}/oauth/register`,
    token_endpoint: 'https://other.example/token', revocation_endpoint: `${f.origin}/oauth/revoke` }));
  await assert.rejects(credentials.login({ noBrowser: true }), { code: 'untrusted_auth_server' });
  assert.equal(f.clients.length, 0);
});

test('native OAuth refuses a wrong token scope and cannot reuse an old refresh token for a new grant', async t => {
  const { credentials, f, vault } = await context(t); credentials.token = undefined;
  f.tokenScope = 'catalog:read';
  await assert.rejects(credentials.login({ browser: url => fetch(url) }), { code: 'invalid_token_response' });
  assert.equal(vault.value, undefined);
  f.tokenScope = 'mcp offline_access'; await credentials.login({ browser: url => fetch(url) });
  const original = structuredClone(vault.value); f.omitRefresh = true;
  await assert.rejects(credentials.login({ browser: url => fetch(url) }), { code: 'invalid_token_response' });
  assert.deepEqual(vault.value, original);
});

test('REST fetch rejects foreign origins and OAuth credentials on the file endpoint before dispatch', async t => {
  const { credentials, f } = await context(t);
  let calls = 0;
  const client = new Api(credentials, { fetchFn: async () => { calls++; return new Response('{}'); } });
  await assert.rejects(client.fetchFn('https://other.example/v1/credits'), { code: 'untrusted_api_server' });
  await assert.rejects(client.fetchFn(`${f.origin}/api/v1/files/upload/stream`, { headers: { Authorization: 'Bearer fixture-oauth' } }), { code: 'invalid_upload_credential' });
  assert.equal(calls, 0);
});

test('vendored runtime matches its manifest and contains no MCP client or server imports', async () => {
  const root = new URL('../src/platform/', import.meta.url);
  const manifest = JSON.parse(await fs.readFile(new URL('source.json', root), 'utf8'));
  assert.equal(manifest.repository, 'Evolink-AI/evolink-mcp');
  assert.match(await fs.readFile(new URL('LICENSE', root), 'utf8'), /Apache License/);
  assert.match(await fs.readFile(new URL('NOTICE', root), 'utf8'), /Copyright 2024 EvoLink AI/);
  assert.ok(Object.keys(manifest.artifacts).length > 10);
  for (const [name, digest] of Object.entries(manifest.artifacts)) {
    const source = await fs.readFile(new URL(name, root));
    assert.equal(createHash('sha256').update(source).digest('hex'), digest);
    assert.equal(source.toString().includes("from '@modelcontextprotocol/sdk"), false);
    assert.match(source.toString(), /^\/\/ Copyright 2024 EvoLink AI\. SPDX-License-Identifier: Apache-2\.0/);
  }
});

test('seeded parameter and budget combinations refuse invalid input before any generation POST', async t => {
  const { f, media } = await context(t);
  let seed = 20261009;
  for (let i = 0; i < 64; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const n = (seed % 10) + 1, cap = (seed % 3) === 0 ? 0.01 : 1;
    const invalid = i % 4 === 0;
    const args = { model: 'fixture-image', input: { prompt: invalid ? 123 : 'test', n }, max_cost_usd: cap };
    if (invalid || cap < n * 0.02) await assert.rejects(media.estimate(args));
    else assert.equal((await media.estimate(args)).input_valid, true);
  }
  assert.equal(f.paid.size, 0); assert.equal(f.restCalls.some(call => call.path.endsWith('/generations')), false);
});
