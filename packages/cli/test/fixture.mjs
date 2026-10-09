import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { CliError } from '../src/errors.mjs';
import { restFixture } from './fixture-rest.mjs';

export class MemoryVault {
  async read() { return this.value; }
  async write(value) { this.value = structuredClone(value); }
  async remove() { this.value = undefined; }
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6uHoAAAAASUVORK5CYII=', 'base64');

// Small transport fixtures; downloads inspect headers, not full codec validity.
export const mediaSamples = {
  image: { bytes: png, type: 'image/png' },
  video: { bytes: Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex'), type: 'video/mp4' },
  audio: { bytes: Buffer.from('524946462600000057415645666d74201000000001000100401f0000803e00000200100064617461020000000000', 'hex'), type: 'audio/wav' },
};

export async function fixture() {
  const state = { calls: [], clients: [], codes: new Map(), refreshes: new Map(), paid: new Map(), tasks: new Map(), uploads: new Map(),
    multiplier: 1, loseSubmission: false, loseUploadReply: false, chunkedDownload: false, revokeFails: false, immediate: true, bytes: png, contentType: 'image/png', downloads: [], uploadHeaders: [], refreshCount: 0, beforeSubmit: undefined };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, state.origin);
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        state.protectedDiscoveryCalls = (state.protectedDiscoveryCalls || 0) + 1;
        send(200, { resource: `${state.origin}/mcp`, authorization_servers: [state.origin], scopes_supported: ['mcp'] }); return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        send(200, { issuer: state.origin, authorization_endpoint: `${state.origin}/oauth/authorize`, token_endpoint: `${state.origin}/oauth/token`,
          registration_endpoint: `${state.origin}/oauth/register`, revocation_endpoint: `${state.origin}/oauth/revoke`,
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true }); return;
      }
      if (url.pathname === '/oauth/authorize') {
        const p = url.searchParams;
        if (p.get('resource') !== `${state.origin}/mcp` || p.get('scope') !== 'mcp offline_access' || p.get('code_challenge_method') !== 'S256') {
          send(400, { error: 'invalid_request' }); return;
        }
        const code = randomUUID(); state.codes.set(code, Object.fromEntries(p));
        const redirect = new URL(p.get('redirect_uri'));
        redirect.searchParams.set('state', p.get('state')); redirect.searchParams.set('iss', state.origin); redirect.searchParams.set('code', code);
        res.writeHead(302, { Location: redirect.href }); res.end(); return;
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (await restFixture(state, req, res, url, body, send)) return;
      if (url.pathname === '/oauth/register') {
        const data = JSON.parse(body);
        if (data.token_endpoint_auth_method !== 'none' || data.application_type !== 'native') { send(400, { error: 'invalid_client_metadata' }); return; }
        state.clients.push(data);
        send(201, { ...data, client_id: `dcr_${randomUUID()}` }); return;
      }
      if (url.pathname === '/oauth/token') {
        const data = new URLSearchParams(body.toString());
        if (data.get('grant_type') === 'authorization_code') {
          const code = state.codes.get(data.get('code'));
          const challenge = createHash('sha256').update(data.get('code_verifier') || '').digest('base64url');
          if (!code || challenge !== code.code_challenge || data.get('resource') !== code.resource || data.get('redirect_uri') !== code.redirect_uri) {
            send(400, { error: 'invalid_grant' }); return;
          }
          state.codes.delete(data.get('code'));
        } else {
          if (!state.refreshes.has(data.get('refresh_token'))) { send(400, { error: 'invalid_grant' }); return; }
          state.refreshes.delete(data.get('refresh_token')); state.refreshCount++;
        }
        const refresh_token = `fixture-refresh-${randomUUID()}`; state.refreshes.set(refresh_token, true);
        send(200, { access_token: `fixture-access-${randomUUID()}`, ...(state.omitRefresh ? {} : { refresh_token }), token_type: 'Bearer', expires_in: 3600, scope: state.tokenScope || 'mcp offline_access' }); return;
      }
      if (url.pathname === '/oauth/revoke') { send(state.revokeFails ? 503 : 200, {}); return; }
      if (url.pathname.startsWith('/uploads/')) {
        state.uploadHeaders.push(req.headers);
        const id = url.pathname.split('/').at(-1);
        if (url.searchParams.get('token') !== 'one-time-fixture-token' || !state.uploads.has(id)) { send(403, {}); return; }
        state.uploads.set(id, { state: 'done', file_url: `${state.origin}/assets/reference.png`, size_bytes: body.length });
        if (state.loseUploadReply) { state.loseUploadReply = false; req.socket.destroy(); return; }
        send(200, { file_url: `${state.origin}/assets/reference.png` }); return;
      }
      if (url.pathname.startsWith('/assets/')) {
        state.downloads.push(req.headers);
        if (!req.headers['user-agent']?.startsWith('EvoLinkCLI/')) { send(403, { error: 'user_agent_required' }); return; }
        res.writeHead(200, { ...(state.contentType ? { 'Content-Type': state.contentType } : {}), ...(state.chunkedDownload ? {} : { 'Content-Length': state.bytes.length }) });
        res.write(state.bytes.subarray(0, 4)); res.end(state.bytes.subarray(4)); return;
      }
      if (url.pathname !== '/mcp') { send(404, {}); return; }
      state.mcpRequests = (state.mcpRequests || 0) + 1;
      if (state.mcpUnavailable) { send(503, {}); return; }
      if (req.method !== 'POST') { send(405, {}); return; }
      if (!req.headers.authorization?.startsWith('Bearer ')) { send(401, {}); return; }
      const message = JSON.parse(body);
      if (!('id' in message)) { res.writeHead(202); res.end(); return; }
      const rpc = result => send(200, { jsonrpc: '2.0', id: message.id, result });
      if (message.method === 'initialize') {
        rpc({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'evolink-cli-fixture', version: '1.0.0' } }); return;
      }
      if (message.method === 'tools/list') { rpc({ tools: [] }); return; }
      if (message.method !== 'tools/call') { send(400, {}); return; }
      const { name, arguments: args } = message.params; state.calls.push({ name, args });
      let data;
      if (name === 'check_balance') data = state.balanceFailure ? { error: { category: 'connection_failed', message: 'Fixture balance unavailable.' } } : { balance_credits: 1000 };
      if (name === 'search_models') data = { models: [{ id: 'fixture-image', type: 'image', starting_price_usd: 0.02 }] };
      if (name === 'get_model') data = { model: args.model, type: args.model.includes('video') ? 'video' : args.model.includes('audio') ? 'audio' : 'image', params: ['prompt', 'n', 'quality'] };
      if (name === 'estimate_cost') {
        const input = args.input || {};
        const type = args.model.includes('video') ? 'video' : args.model.includes('audio') ? 'audio' : 'image';
        const cost = Math.round((input.n || 1) * (input.quality === 'high' ? 0.04 : 0.02) * state.multiplier * 1e6) / 1e6;
        const status = args.model.includes('token') ? 'token_billed' : args.model.includes('partial') ? 'partial' : 'estimated';
        data = { model: args.model, type, input_valid: !input.invalid, problems: input.invalid ? [{ param: 'invalid' }] : [], warnings: [], enough_balance: input.insufficient ? false : true,
          estimate: { status, ...(status !== 'token_billed' ? { min_usd: cost, max_usd: cost } : {}), basis: ['fixture rate'], notes: [] } };
        if (state.estimateFailure) data = { error: { category: 'estimate_unavailable', message: 'Fixture pricing unavailable.' } };
      }
      if (name.startsWith('generate_')) {
        await state.beforeSubmit?.(args);
        if (!state.paid.has(args.client_request_id)) {
          const id = randomUUID(); state.paid.set(args.client_request_id, id);
          state.tasks.set(id, { task_id: id, status: state.immediate ? 'completed' : 'processing', model: args.model, type: name.slice(9), progress: state.immediate ? 100 : 5,
            results: state.immediate ? [{ url: `${state.origin}/assets/one.png`, kind: name.slice(9) }] : [], charged_usd: 0.02, charged_credits: 1.36 });
        }
        data = { ...state.tasks.get(state.paid.get(args.client_request_id)), client_request_id: args.client_request_id };
        if (state.loseSubmission) { state.loseSubmission = false; req.socket.destroy(); return; }
      }
      if (name === 'get_task') data = state.tasks.get(args.task_id) || { error: { category: 'not_found', message: 'Task not found.' } };
      if (name === 'list_tasks') data = { tasks: [...state.tasks.values()] };
      if (name === 'prepare_upload') {
        const id = `up-${randomUUID()}`; state.uploads.set(id, { state: 'waiting' });
        data = { upload_id: id, upload_url: `${state.origin}/uploads/${id}?token=one-time-fixture-token`, max_bytes: 95 * 1024 * 1024 };
      }
      if (name === 'get_upload') data = { ...state.uploads.get(args.upload_id), upload_id: args.upload_id,
        ...(state.uploads.get(args.upload_id)?.state === 'waiting' ? { upload_url: `${state.origin}/uploads/${args.upload_id}?token=one-time-fixture-token` } : {}) };
      data = { ok: !data?.error, ...data };
      rpc({ isError: !data.ok, structuredContent: data, content: [{ type: 'text', text: data.ok ? data.upload_url || 'Fixture result.' : data.error.message }, { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] });
    } catch { res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  state.origin = `http://127.0.0.1:${server.address().port}`;
  state.server = new URL(`${state.origin}/mcp`);
  state.close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  return state;
}

export const fakeMcp = (state, binding = 'fixture-session') => ({
  credentials: { access: async () => ({ binding }) },
  call: async (name, args) => {
    state.calls.push({ name, args });
    if (name === 'estimate_cost') return { ok: true, model: args.model, type: 'image', input_valid: true, warnings: [], _binding: binding,
      estimate: { status: state.status || 'estimated', min_usd: state.cost ?? 0.02, max_usd: state.cost ?? 0.02 } };
    if (name === 'generate_image') {
      if (state.failure) throw new CliError('connection_failed', 'lost connection');
      return { ok: true, task_id: 'fixture-task', status: 'processing' };
    }
    return { ok: true, task_id: 'fixture-task', status: 'completed' };
  },
});
