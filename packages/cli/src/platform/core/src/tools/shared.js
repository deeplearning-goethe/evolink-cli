// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { processCredentialsAllowed } from '../request-context.js';
import { ApiHttpError } from '../services/api-client.js';
import { CREDITS_PER_USD, formatCredits, formatUsd } from '../services/error-handler.js';
import { API_KEYS_URL, PaidRequestOutcomeUnknownError, RequestTimeoutError } from '../services/http-policy.js';
import { trackedLink } from '../services/utm.js';
/** Free lookups: clients can run them without asking. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Spends the user's balance and cannot be undone: clients ask before running it. */
export const PAID = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
/** Changes stored state without spending money (uploads). */
export const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** The media_seconds argument of estimate_cost and the generate tools. */
export const MEDIA_SECONDS_MAX = 3_600;
export const MEDIA_SECONDS_DESCRIPTION = 'Only for models billed per second that have no duration parameter (get_model explains which length is billed): usually the input video or audio length; for generated audio with unknown duration, only an expected output length for an illustrative estimate. It is not sent to the model, and EvoLink charges by the measured duration. It cannot establish max_cost_usd for unknown output duration or for per-second video requests with video_urls, video_url or source_task_id, whose billing is not fully covered by published prices.';
/** Text and structured content carry the same facts: some clients show the model only one of them. */
export function ok(text, structured, resources = []) {
    return { content: [{ type: 'text', text }, ...resources], structuredContent: { ok: true, ...structured } };
}
export function failure(text, structured) {
    return { content: [{ type: 'text', text }], structuredContent: { ok: false, ...structured }, isError: true };
}
export function money(credits) {
    if (typeof credits !== 'number' || !Number.isFinite(credits))
        return undefined;
    return `${formatCredits(credits)} credits (≈$${formatUsd(credits / CREDITS_PER_USD)})`;
}
/** The calling key's daily limit, when the gateway reports one (none means no daily limit is set). */
export function dailyLimitOf(token) {
    const limit = token.daily_limit_credits;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0)
        return undefined;
    const raw = token.daily_used_credits;
    const used = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, raw) : 0;
    const zone = typeof token.reset_timezone === 'string' && token.reset_timezone.trim() ? token.reset_timezone.trim() : undefined;
    return { used, limit, left: Math.max(0, limit - used), zone };
}
export function usdOf(credits) {
    if (typeof credits !== 'number' || !Number.isFinite(credits))
        return undefined;
    return Number((credits / CREDITS_PER_USD).toFixed(6));
}
function infoFor(error) {
    if (error instanceof ApiHttpError && error.info)
        return error.info;
    if (error instanceof ApiHttpError) {
        return { status: error.status, category: 'server_error', message: error.message, next_step: 'Retry in a minute.', retryable: true, request_id: error.requestId };
    }
    if (error instanceof PaidRequestOutcomeUnknownError) {
        return {
            status: 0,
            category: 'outcome_unknown',
            message: 'The submission timed out or the connection dropped, so it is unknown whether a task was created.',
            next_step: 'Do not submit again with a new client_request_id. Look for the task with list_tasks (status processing), or retry with the same client_request_id.',
            retryable: true,
        };
    }
    if (error instanceof RequestTimeoutError || error instanceof TypeError) {
        return { status: 0, category: 'server_error', message: 'EvoLink did not respond in time.', next_step: 'Retry in a minute.', retryable: true };
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    // Credential problems surface as plain errors from getApiKey(): no key in this scope, or a
    // signed-in connection that cannot use the hosted service channel.
    return {
        status: 0,
        category: 'unauthorized',
        message,
        next_step: processCredentialsAllowed()
            ? `Set EVOLINK_API_KEY (create a key at ${trackedLink(API_KEYS_URL, 'api_keys')}), or run \`evolink login\`.`
            : 'Ask the user to reconnect EvoLink in this client. If it keeps failing, retry in a few minutes.',
        retryable: false,
    };
}
/** Converts a thrown error into a tool error with a category and a concrete next step. */
export function errorResult(error, context = {}) {
    const info = infoFor(error);
    const label = `${info.category}${info.code ? `, ${info.code}` : ''}${info.status ? `, HTTP ${info.status}` : ''}`;
    // A headline names the limit in plain words first, so every client shows the user which one stopped the call.
    const lines = info.headline ? [info.headline] : [`Error (${label}): ${info.message}`];
    lines.push(`Next step: ${info.next_step}`);
    let charged;
    if (context.paid) {
        if (info.category === 'outcome_unknown' || info.category === 'server_error') {
            charged = 'unknown';
            lines.push(context.clientRequestId
                ? `It is unclear whether a task was created. To retry this exact request safely, pass client_request_id "${context.clientRequestId}".`
                : 'It is unclear whether a task was created; check list_tasks before submitting again.');
        }
        else {
            charged = 'no';
            lines.push('Nothing was submitted or charged.');
        }
    }
    // No HTTP status: the request timed out or the connection dropped, so the upload's outcome is unknown.
    if (context.upload && info.category === 'server_error' && !info.status) {
        lines.push('The upload may not have finished. Calling upload_file again is safe.');
    }
    if (info.headline)
        lines.push(`Error: ${label}`);
    if (info.request_id)
        lines.push(`Request ID: ${info.request_id}`);
    return failure(lines.join('\n'), {
        error: info,
        ...(charged ? { charged } : {}),
        ...(context.clientRequestId && charged === 'unknown' ? { client_request_id: context.clientRequestId } : {}),
    });
}
/** Sends a progress notification when the client asked for them; failures are ignored. */
export function progressReporter(extra, totalSeconds) {
    const token = extra?._meta?.progressToken;
    let last = -1;
    return async (elapsedSeconds, message) => {
        if (token === undefined || !extra)
            return;
        const progress = Math.max(last + 1, Math.round(elapsedSeconds));
        last = progress;
        await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken: token, progress, total: Math.max(totalSeconds, progress), message },
        }).catch(() => undefined);
    };
}
export function sleep(ms, signal) {
    return new Promise(resolve => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
    });
}
