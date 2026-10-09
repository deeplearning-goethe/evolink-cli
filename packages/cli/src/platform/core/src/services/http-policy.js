// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { randomUUID } from 'node:crypto';
import { currentRequestCredentials, currentClientName } from '../request-context.js';
import { MCP_VERSION } from '../version.js';
export const DEFAULT_READ_TIMEOUT_MS = 15_000;
export const DEFAULT_WRITE_TIMEOUT_MS = 120_000;
/** A generation submit only queues a task; keep it well inside the ~60 s tool-call limit of Codex and Cursor. */
export const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000;
export const MAX_RETRY_DELAY_MS = 30_000;
/** Public site for console links in errors and results. */
export const EVOLINK_SITE = 'https://evolink.ai';
export const TOP_UP_URL = `${EVOLINK_SITE}/dashboard/credits`;
export const API_KEYS_URL = `${EVOLINK_SITE}/dashboard/keys`;
/**
 * Where a signed-in user manages the EvoLink MCP limit and pause. Until the
 * console has an MCP section, the account's internal MCP key is listed under
 * API Keys (as MCP_KEY_NAME) and its limit and on/off switch are set there.
 * The gateway's action_url, when it sends one, takes precedence.
 */
export const MCP_CONSOLE_URL = API_KEYS_URL;
/** Name of the account's internal MCP key in the API Keys list (set by the gateway). */
export const MCP_KEY_NAME = 'EvoLink MCP (OAuth)';
/** The gateway accepts Idempotency-Key values of 16–96 characters from this set. */
export const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{16,96}$/;
export class RequestTimeoutError extends Error {
    timeoutMs;
    constructor(timeoutMs) {
        super(`request timed out after ${timeoutMs}ms`);
        this.timeoutMs = timeoutMs;
        this.name = 'RequestTimeoutError';
    }
}
export class PaidRequestOutcomeUnknownError extends Error {
    cause;
    idempotencyKey;
    constructor(cause, idempotencyKey) {
        super('paid request outcome is unknown after the bounded idempotent retry; do not create a new paid intent');
        this.cause = cause;
        this.idempotencyKey = idempotencyKey;
        this.name = 'PaidRequestOutcomeUnknownError';
    }
}
export function newRunId() {
    return `run_${randomUUID().replaceAll('-', '')}`;
}
/** Headers that tell the gateway this call came from the MCP server, which tool and which assistant. */
export function evoHeaders(tool) {
    const headers = {
        'X-Evo-Client': currentRequestCredentials()?.http?.client ?? 'mcp',
        'X-Evo-Client-Version': currentRequestCredentials()?.http?.version ?? MCP_VERSION,
        'X-Evo-Tool': tool,
    };
    const clientName = currentClientName();
    if (clientName)
        headers['X-Evo-Client-Name'] = clientName;
    return headers;
}
/** Turns a console path such as /dashboard/credits into a full link; full https links pass through. */
export function siteUrl(pathOrUrl, fallback) {
    const value = (pathOrUrl ?? '').trim();
    if (value.startsWith('https://'))
        return value;
    if (value.startsWith('/') && !value.startsWith('//'))
        return `${EVOLINK_SITE}${value}`;
    return fallback;
}
export function timeoutFromEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 600_000) {
        throw new Error(`${name} must be an integer between 1000 and 600000 milliseconds`);
    }
    return parsed;
}
export function parseRetryAfter(value, nowMs = Date.now()) {
    if (!value)
        return undefined;
    const seconds = Number(value.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_DELAY_MS);
    }
    const dateMs = Date.parse(value);
    if (!Number.isFinite(dateMs))
        return undefined;
    return Math.min(Math.max(0, dateMs - nowMs), MAX_RETRY_DELAY_MS);
}
export function responseRequestId(headers) {
    return headers.get('x-request-id')?.trim()
        || headers.get('x-oneapi-request-id')?.trim()
        || undefined;
}
export async function fetchWithTimeout(url, init, timeoutMs, fetchImpl) {
    const controller = new AbortController();
    const context = currentRequestCredentials()?.http;
    const signals = [init.signal, context?.signal].filter((signal) => !!signal);
    const abort = () => controller.abort();
    for (const signal of signals) {
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            abort();
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
        const headers = new Headers(init.headers);
        if (context?.userAgent)
            headers.set('User-Agent', context.userAgent);
        return await (fetchImpl ?? context?.fetch ?? fetch)(url, { ...init, headers,
            ...(context ? { redirect: 'error' } : {}), signal: controller.signal });
    }
    catch (error) {
        if (timedOut) {
            throw new RequestTimeoutError(timeoutMs);
        }
        throw error;
    }
    finally {
        clearTimeout(timer);
        for (const signal of signals)
            signal.removeEventListener('abort', abort);
    }
}
export async function readJsonBody(response) {
    const text = await response.text();
    if (!text)
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        return { message: text.slice(0, 2_000) };
    }
}
