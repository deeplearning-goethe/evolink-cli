// Local stand-in for the EvoLink gateway, mirroring the response shapes of the real
// /v1/models, /v1/credits and /v1/messages. Used by the tests and for trying Claude Code
// against a fake key.

import http from 'node:http';

const rid = () => `2026${Math.random().toString(36).slice(2, 14)}`;
const authError = (message) => ({ error: { code: 'unauthorized', message: `${message} (request id: ${rid()})`, param: null, type: 'authentication_error' } });

export const DEFAULT_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'claude-fable-5-1',
  'claude-opus-4-5-20251101',
  'gpt-6-luna',
  'gemini-3.8-flash',
  'seedance-2.0',
];

export async function startMockGateway({
  keys = {},
  models = DEFAULT_MODELS,
  balance = { user: 1234.5, token: 100, unlimited: true },
  claudeLatest = '2.1.283',
  port = 0,
  log = false,
} = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      let json = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {}
      // Like the gateway, a non-empty x-api-key wins over Authorization on /v1/messages and /v1/models.
      const xKey = req.headers['x-api-key'];
      const bearer = String(req.headers.authorization || '').replace(/^bearer\s+/i, '');
      const key = (xKey && (url.pathname.includes('/v1/messages') || url.pathname.includes('/v1/models')) ? xKey : bearer).replace(/^sk-/, '');
      requests.push({ method: req.method, path: url.pathname, query: url.search, headers: { ...req.headers }, body: json, keyUsed: key });
      if (log) process.stderr.write(`[mock] ${req.method} ${url.pathname}${url.search} key=${key ? `${key.slice(0, 4)}…` : '-'}\n`);
      const send = (status, payload, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      // Doubles as an npm registry (--registry) for the "newer Claude Code" check.
      if (url.pathname === '/@anthropic-ai/claude-code/latest') return send(200, { name: '@anthropic-ai/claude-code', version: claudeLatest });
      const known = ['/v1/models', '/v1/credits', '/v1/messages', '/v1/messages/count_tokens'];
      if (!known.includes(url.pathname)) return send(404, { error: { message: `Invalid URL (${req.method} ${url.pathname})`, type: 'invalid_request_error' } });
      if (!key) return send(401, authError('API key is required'));
      const k = keys[key];
      if (!k) return send(401, authError('Invalid API key'));
      if (k.status === 'expired') return send(401, authError('This API key has expired'));
      if (k.status === 'disabled') return send(401, authError('This API key has been disabled'));
      const allowed = k.models || models;
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        return send(200, {
          success: true,
          data: allowed.map((id) => ({ id, object: 'model', created: 1626777600, owned_by: id.split('-')[0], supported_endpoint_types: id.startsWith('claude') ? ['anthropic', 'openai'] : ['openai'] })),
        });
      }
      if (url.pathname === '/v1/credits' && req.method === 'GET') {
        const b = k.balance || balance;
        return send(200, {
          success: true,
          message: '',
          data: { user: { remaining_credits: b.user, used_credits: 12.3 }, token: { remaining_credits: b.token, used_credits: 1.2, unlimited_credits: b.unlimited } },
        });
      }
      if (url.pathname === '/v1/messages/count_tokens') return send(200, { input_tokens: 10 });
      if (url.pathname === '/v1/messages' && req.method === 'POST') {
        const model = json?.model;
        if (!allowed.includes(model)) {
          return send(404, { error: { code: 'model_not_found', message: `Model '${model}' is not available for this API key`, type: 'invalid_request_error' } });
        }
        const b = k.balance || balance;
        if (b.user < 1) {
          return send(403, { error: { code: 'unknown_error', message: '余额不足: 可用 ¥0.100000, 本次预估需要 ¥0.700000; insufficient credits', type: 'new_api_error' } });
        }
        const msg = { id: `msg_${rid()}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } };
        if (!json?.stream) return send(200, msg);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        ev('message_start', { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 0 } } });
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } });
        ev('content_block_stop', { index: 0 });
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
        ev('message_stop', {});
        return res.end();
      }
      return send(404, { error: { message: 'Invalid URL', type: 'invalid_request_error' } });
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: actual } = server.address();
  return { url: `http://127.0.0.1:${actual}`, requests, close: () => new Promise((r) => server.close(r)) };
}

// `node test/mock-server.mjs <port> <key>` runs a standalone gateway for manual trials.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const port = Number(process.argv[2] || 18080);
  const key = (process.argv[3] || 'sk-' + 'a'.repeat(48)).replace(/^sk-/, '');
  const gw = await startMockGateway({ port, keys: { [key]: {} }, log: true });
  process.stderr.write(`mock gateway on ${gw.url} (key sk-${key.slice(0, 4)}…)\n`);
}
