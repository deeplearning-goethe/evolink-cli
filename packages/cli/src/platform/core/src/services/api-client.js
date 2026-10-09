// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { gatewayAuthHeaders } from '../config.js';
import { currentRequestCredentials } from '../request-context.js';
import { classifyGatewayError, formatGatewayError } from './error-handler.js';
import { DEFAULT_READ_TIMEOUT_MS, DEFAULT_SUBMIT_TIMEOUT_MS, MAX_RETRY_DELAY_MS, PaidRequestOutcomeUnknownError, RequestTimeoutError, evoHeaders, fetchWithTimeout, newRunId, parseRetryAfter, readJsonBody, responseRequestId, timeoutFromEnv, } from './http-policy.js';
// --- Error class for HTTP-level failures ---
export class ApiHttpError extends Error {
    status;
    retryAfterMs;
    requestId;
    info;
    constructor(status, message, retryAfterMs, requestId, info) {
        super(message);
        this.status = status;
        this.retryAfterMs = retryAfterMs;
        this.requestId = requestId;
        this.info = info;
        this.name = 'ApiHttpError';
    }
}
// --- Retry logic ---
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503]);
function sleep(ms) {
    const signal = currentRequestCredentials()?.http?.signal;
    return new Promise(resolve => {
        const timer = setTimeout(done, ms);
        function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
        signal?.addEventListener('abort', done, { once: true });
        if (signal?.aborted)
            done();
    });
}
function isRetryable(error) {
    // Key and balance rejections are always HTTP 402, so they are never retried here.
    if (error instanceof ApiHttpError)
        return RETRYABLE_STATUS_CODES.has(error.status);
    if (error instanceof PaidRequestOutcomeUnknownError)
        return true;
    if (error instanceof RequestTimeoutError)
        return true;
    if (error instanceof TypeError)
        return true; // network errors (DNS, reset, …)
    return false;
}
export async function withRetry(fn, retries, baseDelayMs) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            if (attempt < retries && isRetryable(error) && !currentRequestCredentials()?.http?.signal?.aborted) {
                const retryAfterMs = error instanceof ApiHttpError ? error.retryAfterMs : undefined;
                await sleep(Math.min(retryAfterMs ?? baseDelayMs * (attempt + 1), MAX_RETRY_DELAY_MS));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}
// --- Core request (no retry) ---
async function rawRequest(config, options) {
    const url = `${config.baseUrl}${options.path}`;
    const headers = {
        ...gatewayAuthHeaders(),
        'Accept': 'application/json',
        ...evoHeaders(options.tool ?? 'unknown'),
    };
    if (options.body)
        headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) {
        headers['Idempotency-Key'] = options.idempotencyKey;
        headers['X-Evo-Run-Id'] = options.idempotencyKey;
    }
    const isRead = options.method === 'GET' || !options.idempotencyKey;
    let response;
    try {
        response = await fetchWithTimeout(url, {
            method: options.method,
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
        }, options.timeoutMs ?? timeoutFromEnv(isRead ? 'EVOLINK_MCP_READ_TIMEOUT_MS' : 'EVOLINK_MCP_WRITE_TIMEOUT_MS', isRead ? DEFAULT_READ_TIMEOUT_MS : DEFAULT_SUBMIT_TIMEOUT_MS));
    }
    catch (error) {
        if (!isRead)
            throw new PaidRequestOutcomeUnknownError(error, options.idempotencyKey);
        throw error;
    }
    const data = await readJsonBody(response);
    const requestId = responseRequestId(response.headers);
    if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        const info = classifyGatewayError(response.status, data, retryAfterMs, requestId);
        throw new ApiHttpError(response.status, formatGatewayError(info), retryAfterMs, info.request_id, info);
    }
    return { data: data, requestId, headers: response.headers };
}
/**
 * Submit one paid intent. At most one transport retry, always with the same
 * idempotency key, so the gateway ledger (Idempotency-Key) can return the
 * original task instead of creating a second one.
 */
export async function submitTask(config, options) {
    const idempotencyKey = options.idempotencyKey ?? newRunId();
    const { data, requestId, headers } = await withRetry(() => rawRequest(config, {
        method: 'POST',
        path: options.path,
        body: options.body,
        tool: options.tool,
        idempotencyKey,
    }), 1, 500);
    if (!data.request_id && requestId)
        data.request_id = requestId;
    if (headers.get('idempotency-replayed') === 'true')
        data.idempotency_replayed = true;
    return data;
}
/** Read-only, credential-specific availability; never cached across accounts. */
export async function getAvailableModelIds(config) {
    const { data } = await withRetry(() => rawRequest(config, {
        method: 'GET', path: '/v1/models', tool: 'model_catalog',
    }), 2, 1500);
    if (!Array.isArray(data.data) || data.data.some(model => typeof model.id !== 'string')) {
        throw new Error('The available-model list could not be verified. Try again before generating.');
    }
    return data.data.map(model => model.id);
}
/** @deprecated kept for callers outside the tools; use submitTask. */
export async function apiRequest(config, options) {
    if (options.method !== 'POST' || !options.body) {
        throw new Error('apiRequest only accepts generation POST operations');
    }
    return submitTask(config, { path: options.path, body: options.body, tool: options.tool ?? 'unknown' });
}
/** One task (GET /v1/tasks/{id}). Unfinished tasks sync with the provider on every read, so callers pace themselves. */
export async function queryTask(config, taskId, tool = 'get_task') {
    const { data, requestId } = await withRetry(() => rawRequest(config, { method: 'GET', path: `/v1/tasks/${encodeURIComponent(taskId)}`, tool }), 2, 1500);
    if (!data.request_id && requestId)
        data.request_id = requestId;
    return data;
}
/** Up to 50 tasks in one call (POST /v1/tasks/batch); unknown or foreign IDs are simply absent. */
export async function queryTasks(config, taskIds, tool = 'list_tasks') {
    const { data } = await withRetry(() => rawRequest(config, {
        method: 'POST',
        path: '/v1/tasks/batch',
        body: { task_ids: taskIds },
        tool,
    }), 2, 1500);
    return Array.isArray(data.data) ? data.data : [];
}
/** The account's recent tasks, newest first (GET /v1/tasks). Items carry no result links. */
export async function listTasks(config, query, tool = 'list_tasks', options = {}) {
    const params = new URLSearchParams();
    if (query.status)
        params.set('status', query.status);
    if (query.type)
        params.set('type', query.type);
    if (query.model)
        params.set('model', query.model);
    params.set('page', String(query.page ?? 1));
    params.set('page_size', String(query.pageSize ?? 20));
    const { data } = await withRetry(() => rawRequest(config, { method: 'GET', path: `/v1/tasks?${params}`, tool, timeoutMs: options.timeoutMs }), options.retries ?? 2, 1500);
    if (!Array.isArray(data.data) || !Number.isSafeInteger(data.total) || data.total < 0) {
        throw new ApiHttpError(502, 'The task list could not be verified. Retry this read; do not infer zero usage or submit another task.');
    }
    if ((data.page !== undefined && data.page !== (query.page ?? 1))
        || (data.page_size !== undefined && data.page_size !== (query.pageSize ?? 20))) {
        throw new ApiHttpError(502, 'The task page did not match the requested pagination. Retry this read; no usage total can be verified.');
    }
    return {
        data: data.data,
        total: data.total,
        page: typeof data.page === 'number' ? data.page : query.page ?? 1,
        page_size: typeof data.page_size === 'number' ? data.page_size : query.pageSize ?? 20,
    };
}
/**
 * A short-lived upload token for a signed-in hosted connection (POST
 * /v1/files/upload-token). The connection has no API key of its own, so
 * files-api takes this token instead. Free; the gateway allows 30 a minute per
 * account.
 */
export async function requestUploadToken(config, tool) {
    const { data, requestId } = await withRetry(() => rawRequest(config, { method: 'POST', path: '/v1/files/upload-token', tool }), 1, 500);
    const token = typeof data.upload_token === 'string' ? data.upload_token : '';
    const expiresAt = typeof data.expires_at === 'number' ? data.expires_at : 0;
    if (!token.startsWith('evup_') || expiresAt <= 0) {
        const info = classifyGatewayError(500, { error: { message: 'EvoLink returned no upload token.' } }, undefined, requestId);
        throw new ApiHttpError(500, formatGatewayError(info), undefined, requestId, info);
    }
    return { token, expiresAt };
}
/** Account balance and this key's usage (GET /v1/credits). */
export async function getCredits(config, tool = 'check_balance') {
    const { data, requestId } = await withRetry(() => rawRequest(config, { method: 'GET', path: '/v1/credits', tool }), 2, 1000);
    if (data.success === false || !data.data?.user || !data.data?.token) {
        const info = classifyGatewayError(500, { error: { message: data.message || 'The balance could not be read.' } }, undefined, requestId);
        throw new ApiHttpError(500, formatGatewayError(info), undefined, requestId, info);
    }
    return data.data;
}
