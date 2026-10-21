// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { gatewayAuthHeaders } from '../config.js';
import { currentRequestCredentials } from '../request-context.js';
import { classifyGatewayError, formatGatewayError } from './error-handler.js';
import { parseBatchTasks, parseTaskReceipt, parseTaskResponse } from './task-response.js';
import { DEFAULT_READ_TIMEOUT_MS, DEFAULT_SUBMIT_TIMEOUT_MS, MAX_RETRY_DELAY_MS, MIN_READ_MS, PaidRequestOutcomeUnknownError, RequestTimeoutError, SubmissionNotStartedError, TaskQueryTimeoutError, evoHeaders, fetchWithTimeout, monotonicNow, newRunId, parseRetryAfter, readJsonBody, remainingMs, requestedRetryAfterMs, responseRequestId, timeoutFromEnv, } from './http-policy.js';
// --- Error class for HTTP-level failures ---
export class ApiHttpError extends Error {
    status;
    retryAfterMs;
    requestId;
    info;
    submissionState;
    /** Retry-After as the server sent it, without the general 30 s cap. */
    requestedRetryAfterMs;
    constructor(status, message, retryAfterMs, requestId, info, submissionState) {
        super(message);
        this.status = status;
        this.retryAfterMs = retryAfterMs;
        this.requestId = requestId;
        this.info = info;
        this.submissionState = submissionState;
        this.name = 'ApiHttpError';
    }
}
// --- Retry logic ---
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503]);
function sleep(ms, extra) {
    const signals = [currentRequestCredentials()?.http?.signal, extra].filter((signal) => !!signal);
    return new Promise(resolve => {
        const timer = setTimeout(done, ms);
        function done() { clearTimeout(timer); for (const signal of signals)
            signal.removeEventListener('abort', done); resolve(); }
        for (const signal of signals)
            signal.addEventListener('abort', done, { once: true });
        if (signals.some(signal => signal.aborted))
            done();
    });
}
function stopped(signal) {
    return !!signal?.aborted || !!currentRequestCredentials()?.http?.signal?.aborted;
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
/** A gateway answer (rate limit, overload) says more than "ran out of time"; network and timeout failures do not. */
function budgetError(error) {
    return error instanceof ApiHttpError || !isRetryable(error) ? error : new TaskQueryTimeoutError(error);
}
export async function withRetry(fn, retries, baseDelayMs, budget = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            if (attempt < retries && isRetryable(error) && !stopped(budget.signal)) {
                if (budget.deadline === undefined) {
                    const retryAfterMs = error instanceof ApiHttpError ? error.retryAfterMs : undefined;
                    await sleep(Math.min(retryAfterMs ?? baseDelayMs * (attempt + 1), MAX_RETRY_DELAY_MS), budget.signal);
                    continue;
                }
                // A task wait never retries before the server's requested pause, and ends instead of running past its window.
                const requested = error instanceof ApiHttpError ? error.requestedRetryAfterMs ?? error.retryAfterMs : undefined;
                const delay = requested ?? baseDelayMs * (attempt + 1);
                // Twice the read minimum leaves room for timer lateness before the retry's own check.
                if (delay > MAX_RETRY_DELAY_MS || remainingMs(budget.deadline) < delay + 2 * MIN_READ_MS)
                    throw budgetError(error);
                await sleep(delay, budget.signal);
                if (stopped(budget.signal))
                    throw error;
                continue;
            }
            if (budget.deadline !== undefined && remainingMs(budget.deadline) < MIN_READ_MS)
                throw budgetError(error);
            throw error;
        }
    }
    throw lastError;
}
// --- Core request (no retry) ---
async function rawRequest(config, options) {
    const isPaid = options.method === 'POST' && !!options.idempotencyKey;
    let headers;
    let body;
    let timeout;
    try {
        headers = { ...gatewayAuthHeaders(), Accept: 'application/json', ...evoHeaders(options.tool ?? 'unknown') };
        if (options.body)
            headers['Content-Type'] = 'application/json';
        if (options.idempotencyKey) {
            headers['Idempotency-Key'] = options.idempotencyKey;
            headers['X-Evo-Run-Id'] = options.idempotencyKey;
        }
        body = options.body ? JSON.stringify(options.body) : undefined;
        timeout = options.timeoutMs ?? timeoutFromEnv(isPaid ? 'EVOLINK_MCP_WRITE_TIMEOUT_MS' : 'EVOLINK_MCP_READ_TIMEOUT_MS', isPaid ? DEFAULT_SUBMIT_TIMEOUT_MS : DEFAULT_READ_TIMEOUT_MS);
        if (!isPaid && options.deadline !== undefined) {
            // A task read shares its wait's remaining time instead of getting a fresh full timeout.
            const left = remainingMs(options.deadline);
            if (left < MIN_READ_MS)
                throw new TaskQueryTimeoutError();
            timeout = Math.min(timeout, Math.floor(left));
        }
    }
    catch (error) {
        if (isPaid)
            throw new SubmissionNotStartedError(error);
        throw error;
    }
    // Reading and verifying the body belong to the submission boundary too.
    try {
        const started = monotonicNow();
        const response = await fetchWithTimeout(`${config.baseUrl}${options.path}`, {
            method: options.method, headers, body, ...(options.signal ? { signal: options.signal } : {}),
        }, timeout);
        const data = await readJsonBody(response, Math.max(1, timeout - (monotonicNow() - started)), options.signal);
        const requestId = responseRequestId(response.headers);
        if (!response.ok) {
            const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
            const info = classifyGatewayError(response.status, data, retryAfterMs, requestId);
            const error = new ApiHttpError(response.status, formatGatewayError(info), retryAfterMs, info.request_id, info, isPaid ? (verifiedPrechargeRejection(response.status, info.code) ? 'rejected' : 'outcome_unknown') : undefined);
            error.requestedRetryAfterMs = requestedRetryAfterMs(response.headers.get('retry-after'));
            throw error;
        }
        if (isPaid && (!data || typeof data !== 'object' || Array.isArray(data)
            || typeof data.id !== 'string'
            || !/^[A-Za-z0-9._:-]{1,128}$/.test(data.id))) {
            throw new PaidRequestOutcomeUnknownError(new Error('Unverified submission response'), options.idempotencyKey);
        }
        return { data: data, requestId, headers: response.headers };
    }
    catch (error) {
        if (isPaid && !(error instanceof ApiHttpError) && !(error instanceof PaidRequestOutcomeUnknownError)) {
            throw new PaidRequestOutcomeUnknownError(error, options.idempotencyKey);
        }
        throw error;
    }
}
/** These codes are emitted by gateway admission checks before dispatch, not inferred from an HTTP status. */
function verifiedPrechargeRejection(status, code) {
    if (status < 400 || !code)
        return false;
    return new Set([
        'insufficient_quota', 'insufficient_user_quota', 'quota_not_enough', 'account_balance_insufficient',
        'insufficient_token_quota', 'key_quota_exhausted', 'token_daily_quota_exceeded', 'key_daily_quota_exhausted',
        'key_disabled', 'key_expired', 'key_model_not_allowed', 'mcp_paused', 'mcp_key_expired',
        'connection_not_found', 'connection_revoked', 'session_inactive', 'session_expired', 'mcp_scope_missing',
        'mcp_service_unauthorized', 'mcp_connection_required', 'mcp_route_not_allowed', 'mcp_token_invalid', 'user_disabled',
        'agent_session_unavailable', 'mcp_connection_create_failed', 'mcp_channel_disabled',
    ]).has(code.toLowerCase());
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
    const receipt = parseTaskReceipt(data, requestId);
    if (headers.get('idempotency-replayed') === 'true')
        receipt.idempotency_replayed = true;
    return receipt;
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
/** Read-only account Quote. It reuses the caller's API key or MCP OAuth token. */
export async function requestAccountQuote(config, body) {
    const result = await rawRequest(config, { method: 'POST', path: '/v1/agent-estimates', body, tool: 'estimate_cost' });
    return result.data;
}
/** @deprecated kept for callers outside the tools; use submitTask. */
export async function apiRequest(config, options) {
    if (options.method !== 'POST' || !options.body) {
        throw new Error('apiRequest only accepts generation POST operations');
    }
    return submitTask(config, { path: options.path, body: options.body, tool: options.tool ?? 'unknown' });
}
/** One task (GET /v1/tasks/{id}). Unfinished tasks sync with the provider on every read, so callers pace themselves. */
export async function queryTask(config, taskId, tool = 'get_task', budget = {}) {
    const { data, requestId } = await withRetry(() => rawRequest(config, { method: 'GET', path: `/v1/tasks/${encodeURIComponent(taskId)}`, tool,
        deadline: budget.deadline, signal: budget.signal }), budget.retries ?? 2, 1500, budget);
    return parseTaskResponse(data, taskId, requestId);
}
/** Up to 50 tasks in one call (POST /v1/tasks/batch); unknown or foreign IDs are simply absent. */
export async function queryTasks(config, taskIds, tool = 'list_tasks') {
    const { data, requestId } = await withRetry(() => rawRequest(config, {
        method: 'POST',
        path: '/v1/tasks/batch',
        body: { task_ids: taskIds },
        tool,
    }), 2, 1500);
    return parseBatchTasks(data, taskIds, requestId);
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
    if (!data || !Array.isArray(data.data) || !Number.isSafeInteger(data.total) || data.total < 0) {
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
