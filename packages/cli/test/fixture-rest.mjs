import { randomUUID } from 'node:crypto';

const models = ['fixture-image', 'fixture-video', 'fixture-audio', 'fixture-token-image', 'fixture-partial-image', 'fixture-partial-video'];
const kind = id => id.includes('video') ? 'video' : id.includes('audio') ? 'audio' : 'image';
const aliases = { image: 'gpt-image-2', video: 'seedance-2.0-text-to-video', audio: 'suno-v6-beta' };

export async function restFixture(state, req, res, url, body, send) {
  if (!url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/api/v1/') && url.pathname !== '/web/api/models/pricing') return false;
  state.restCalls ??= []; state.restCalls.push({ path: url.pathname, method: req.method, headers: req.headers });
  const raw = task => ({ id: task.task_id, model: task.model || 'fixture-image', type: task.type || 'image',
    created: Math.floor(Date.now() / 1000), progress: task.progress ?? 5, status: task.status,
    results: task.results?.map(result => result.url), usage: { credits_used: task.charged_credits ?? 1.36 } });
  if (url.pathname === '/v1/catalog/models') {
    send(200, { models: models.map(id => ({ model_id: id, display_name: id, aliases: [id === 'fixture-partial-video' ? 'seedance-2.0-reference-to-video' : aliases[kind(id)]],
      capabilities: [kind(id)], protocols: [{ image: 'openai-images', video: 'evolink-video-generations', audio: 'openai-audio' }[kind(id)]], lifecycle: 'active' })) }); return true;
  }
  if (url.pathname === '/v1/catalog/health') { send(200, { models: models.map(model_id => ({ model_id, status: 'available' })) }); return true; }
  if (url.pathname === '/web/api/models/pricing') {
    if (state.estimateFailure) { send(503, {}); return true; }
    const data = models.flatMap(id => [{ sku_id: id, sku_name: 'output', model_name: id, model_type: kind(id),
      billing_rule: id.includes('token') ? 'per_1k_tokens' : id === 'fixture-partial-video' ? 'per_second' : kind(id) === 'image' ? 'per_image' : 'per_request',
      price_range: { min_usd: 0.02 * state.multiplier, max_usd: 0.02 * state.multiplier } },
      ...(id.includes('partial') ? [{ sku_id: `${id}-input`, sku_name: 'input image', model_name: id, model_type: kind(id), billing_rule: 'per_image',
        price_range: { min_usd: 0.01, max_usd: 0.01 } }] : [])]);
    send(200, { success: true, data }); return true;
  }
  if (!req.headers.authorization?.startsWith('Bearer ')) { send(401, {}); return true; }
  if (url.pathname === '/v1/credits') {
    state.calls.push({ name: 'check_balance', args: {} });
    if (state.balanceFailure) { send(503, { error: { message: 'Fixture balance unavailable.' } }); return true; }
    send(200, { success: true, data: { user: { remaining_credits: state.balanceCredits ?? 1000, used_credits: 0 }, token: { unlimited_credits: true, remaining_credits: 1000, used_credits: 0 } } }); return true;
  }
  if (/^\/v1\/(images|videos|audios)\/generations$/.test(url.pathname)) {
    const data = JSON.parse(body); const idempotency = req.headers['idempotency-key'];
    const type = { images: 'image', videos: 'video', audios: 'audio' }[url.pathname.split('/')[2]];
    const args = { model: data.model, input: Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'model')), client_request_id: idempotency };
    state.calls.push({ name: `generate_${type}`, args }); await state.beforeSubmit?.(args);
    const replayed = state.paid.has(idempotency);
    if (!replayed) {
      const id = randomUUID(); state.paid.set(idempotency, id);
      state.tasks.set(id, { task_id: id, model: data.model, type, status: state.immediate ? 'completed' : 'processing', progress: state.immediate ? 100 : 5,
        results: state.immediate ? [{ url: `${state.origin}/assets/result`, kind: type }] : [] });
    }
    if (state.loseRestSubmissions > 0) { state.loseRestSubmissions--; req.socket.destroy(); return true; }
    if (replayed) res.setHeader('idempotency-replayed', 'true');
    send(200, raw(state.tasks.get(state.paid.get(idempotency)))); return true;
  }
  if (url.pathname === '/v1/tasks') {
    const page = Number(url.searchParams.get('page') || 1), page_size = Number(url.searchParams.get('page_size') || 20);
    const filters = Object.fromEntries(['status', 'type', 'model'].filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)]));
    state.calls.push({ name: 'list_tasks', args: { ...filters, page, limit: page_size } });
    const rows = [...state.tasks.values()].map(task => ({ ...raw(task), created_at: task.created_at ?? Math.floor(Date.now() / 1000), has_results: !!task.results?.length, credits_used: task.charged_credits ?? 1.36 }))
      .filter(task => Object.entries(filters).every(([key, value]) => key === 'status' && value === 'processing' ? ['pending', 'processing'].includes(task.status) : task[key] === value));
    send(200, { data: rows.slice((page - 1) * page_size, page * page_size), total: rows.length, page, page_size }); return true;
  }
  if (url.pathname === '/v1/tasks/batch') { send(200, { data: JSON.parse(body).task_ids.flatMap(id => state.tasks.has(id) ? [raw(state.tasks.get(id))] : []) }); return true; }
  if (url.pathname.startsWith('/v1/tasks/')) {
    const id = decodeURIComponent(url.pathname.slice('/v1/tasks/'.length));
    if (!state.tasks.has(id)) send(404, { error: { code: 'task_not_found', message: 'Task not found.' } });
    else send(200, raw(state.tasks.get(id))); return true;
  }
  if (url.pathname === '/v1/files/upload-token') { send(200, { upload_token: 'evup_fixture-short-lived', expires_at: Math.floor(Date.now() / 1000) + 60 }); return true; }
  if (url.pathname === '/api/v1/files/upload/stream') {
    if (req.headers.authorization !== 'Bearer evup_fixture-short-lived') { send(403, {}); return true; }
    state.uploadHeaders.push(req.headers);
    const boundary = req.headers['content-type'].split('boundary=')[1];
    const start = body.indexOf(Buffer.from('\r\n\r\n')) + 4;
    const end = body.indexOf(Buffer.from(`\r\n--${boundary}`), start);
    state.uploadedBytes = body.subarray(start, end);
    if (state.loseRestUploadReply) { req.socket.destroy(); return true; }
    send(200, { success: true, data: { file_id: 'fixture-file', file_name: 'reference.png', file_size: state.uploadedBytes.length,
      mime_type: 'image/png', file_url: `${state.origin}/assets/reference.png`, expires_at: new Date(Date.now() + 86400000).toISOString() } }); return true;
  }
  send(404, {}); return true;
}
