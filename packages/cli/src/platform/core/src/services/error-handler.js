// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { publicIdentifier, publicLabel, publicNumber } from './public-error.js';
import { currentCredentialMode } from '../request-context.js';
import { API_KEYS_URL, MCP_CONSOLE_URL, MCP_KEY_NAME, TOP_UP_URL, siteUrl } from './http-policy.js';
import { trackedLink } from './utm.js';
/** Gateway display rate: 1 USD = 6.8 CNY and 1 CNY = 10 credits. */
export const CREDITS_PER_USD = 68;
const ACCOUNT_CODES = new Set(['insufficient_quota', 'insufficient_user_quota', 'quota_not_enough', 'account_balance_insufficient']);
const KEY_QUOTA_CODES = new Set(['insufficient_token_quota', 'key_quota_exhausted']);
const KEY_DAILY_CODES = new Set(['token_daily_quota_exceeded', 'key_daily_quota_exhausted']);
const CONTENT_CODES = new Set(['content_policy_violation', 'content_filter', 'sensitive_content', 'moderation_blocked', 'input_moderation_failed']);
const UNAVAILABLE_CODES = new Set(['no_available_channel', 'model_unavailable', 'channel_selection_failed']);
/** Hosted service channel (key custody A): the connection itself is gone and needs a new sign-in. */
const CONNECTION_ENDED_CODES = new Set(['connection_not_found', 'connection_revoked', 'session_inactive', 'session_expired', 'mcp_scope_missing']);
/** The hosted service, not the user's connection, was refused or sent a request the channel does not serve. */
const SERVICE_CODES = new Set(['mcp_service_unauthorized', 'mcp_connection_required', 'mcp_route_not_allowed']);
const DETAIL_FIELDS = [
    'key_name',
    'estimated_credits',
    'account_balance_credits',
    'total_limit_credits',
    'used_credits',
    'remaining_credits',
    'daily_limit_credits',
    'daily_used_credits',
    'reset_timezone',
    'allowed_models',
    'expired_at',
];
function envelope(body) {
    if (!body || typeof body !== 'object')
        return {};
    const record = body;
    if (record.error && typeof record.error === 'object')
        return record.error;
    // files-api: { success: false, code, msg }; OAuth-style: { error: "x", error_description: "…" }
    return {
        code: typeof record.error === 'string' ? record.error : record.code,
        message: record.msg ?? record.error_description ?? record.message,
    };
}
function text(value) {
    if (typeof value === 'string' && value.trim())
        return value.trim();
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return undefined;
}
/**
 * @param mcpLimits the key limits are the account's EvoLink MCP limit: a
 *   signed-in connection, or the gateway said so with limit_scope "mcp".
 */
function categorize(status, code, mode, mcpLimits) {
    const lower = code.toLowerCase();
    if (ACCOUNT_CODES.has(lower))
        return 'account_balance_insufficient';
    if (KEY_QUOTA_CODES.has(lower))
        return mcpLimits ? 'mcp_limit_reached' : 'key_quota_exhausted';
    if (KEY_DAILY_CODES.has(lower))
        return mcpLimits ? 'mcp_daily_limit_reached' : 'key_daily_quota_exhausted';
    if (lower === 'mcp_paused')
        return 'mcp_paused';
    if (lower === 'mcp_key_expired')
        return 'mcp_key_expired';
    // EvoLink turned the MCP channel off (the gateway's MCPChannelEnabled switch): a 503, but not a model problem.
    if (lower === 'mcp_channel_disabled')
        return 'mcp_channel_disabled';
    // The account's MCP key is only ever disabled by "pause all" in the console.
    if (lower === 'key_disabled')
        return mode === 'signed_in' ? 'mcp_paused' : 'key_disabled';
    // A signed-in connection spends the account's MCP key, so an expired key is that key's expiry date, not the connection.
    if (lower === 'key_expired')
        return mode === 'signed_in' ? 'mcp_key_expired' : 'key_expired';
    if (lower === 'key_model_not_allowed')
        return 'model_not_allowed';
    if (lower === 'idempotency_conflict')
        return 'idempotency_conflict';
    if (lower === 'paid_outcome_unknown')
        return 'outcome_unknown';
    if (CONTENT_CODES.has(lower))
        return 'content_policy';
    if (lower === 'service_unavailable')
        return 'service_unavailable';
    if (UNAVAILABLE_CODES.has(lower))
        return 'model_unavailable';
    if (CONNECTION_ENDED_CODES.has(lower))
        return 'connection_ended';
    if (lower === 'agent_session_unavailable')
        return 'session_check_unavailable';
    if (lower === 'mcp_connection_create_failed')
        return 'connection_setup_failed';
    if (SERVICE_CODES.has(lower))
        return 'service_misconfigured';
    // The gateway did not take the forwarded sign-in token, most likely because it expired during the call.
    if (lower === 'mcp_token_invalid')
        return 'sign_in_token_rejected';
    if (lower === 'user_disabled')
        return 'account_disabled';
    // Upload tokens for signed-in connections (POST /v1/files/upload-token): a per-minute cap, and Redis being down.
    if (lower === 'upload_token_rate_limited')
        return 'rate_limited';
    if (lower === 'upload_token_unavailable')
        return 'server_error';
    switch (status) {
        case 401: return 'unauthorized';
        case 402: return 'account_balance_insufficient';
        case 403: return 'forbidden';
        case 404: return 'not_found';
        case 413: return 'request_too_large';
        case 429: return 'rate_limited';
        case 503: return 'service_unavailable';
    }
    if (status >= 500)
        return 'server_error';
    return 'invalid_request';
}
const RETRYABLE = new Set([
    'key_daily_quota_exhausted',
    'mcp_daily_limit_reached',
    'rate_limited',
    'model_unavailable',
    'service_unavailable',
    'outcome_unknown',
    'server_error',
    'session_check_unavailable',
    'connection_setup_failed',
    'sign_in_token_rejected',
]);
/** Answers about the account's EvoLink MCP limit; their console link is the MCP settings, not API Keys. */
const MCP_LIMIT_CATEGORIES = new Set(['mcp_limit_reached', 'mcp_daily_limit_reached', 'mcp_paused', 'mcp_key_expired']);
const KEY_CATEGORIES = new Set([
    'key_quota_exhausted', 'key_daily_quota_exhausted', 'key_disabled', 'key_expired', 'model_not_allowed',
]);
function credits(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return undefined;
    return `${formatCredits(value)} credits (≈$${formatUsd(value / CREDITS_PER_USD)})`;
}
export function formatCredits(value) {
    return Number(value.toFixed(4)).toString();
}
export function formatUsd(value) {
    if (value === 0)
        return '0';
    if (Math.abs(value) >= 1)
        return value.toFixed(2);
    if (Math.abs(value) >= 0.01)
        return value.toFixed(3);
    return Number(value.toPrecision(2)).toString();
}
/** Sentences naming which limit stopped the request; the same words in every client. */
function headlineFor(category) {
    switch (category) {
        case 'mcp_limit_reached':
            return 'EvoLink MCP spending limit reached. This is the limit set for MCP, not your account balance.';
        case 'mcp_daily_limit_reached':
            return 'EvoLink MCP daily limit reached. It resets at midnight; this is not your account balance.';
        case 'mcp_paused':
            return 'EvoLink MCP is paused for this account. Resume it in the console; you do not need to reconnect.';
        case 'mcp_key_expired':
            return 'EvoLink MCP key has expired. Extend or clear its expiry date in the console; you do not need to reconnect.';
        case 'account_balance_insufficient':
            return 'Your EvoLink account balance is too low for this request. The balance is shared by API, web and MCP.';
        case 'key_quota_exhausted':
            return 'This API key\'s spending limit is used up. This is the key\'s own limit, not your account balance.';
        case 'key_daily_quota_exhausted':
            return 'This API key\'s daily limit is used up. It resets at midnight; this is not your account balance.';
        case 'connection_ended':
            return 'This EvoLink connection was disconnected. Reconnect EvoLink in this client.';
        // The gateway's own text ("Agent session validation…") is shared with the CLI and names an internal check.
        case 'session_check_unavailable':
            return 'EvoLink could not check this connection\'s sign-in just now. Retry in a minute; you do not need to reconnect.';
        default:
            return undefined;
    }
}
/**
 * Where the EvoLink MCP limit lives: while it is a key in API Keys, name the key
 * so the user finds it; a dedicated MCP page needs no key name.
 */
function mcpLimitPlace(url, details) {
    return /\/dashboard\/keys(?:[?#]|$)/.test(url)
        ? `${url} (the key named "${text(details.key_name) ?? MCP_KEY_NAME}")`
        : url;
}
/** "Limit: …; used: …; left: …." from whatever figures the gateway attached. */
function limitFigures(details, label) {
    const parts = [
        credits(details.total_limit_credits) && `${label}: ${credits(details.total_limit_credits)}`,
        credits(details.used_credits) && `used: ${credits(details.used_credits)}`,
        credits(details.remaining_credits) && `left: ${credits(details.remaining_credits)}`,
    ].filter(Boolean);
    return parts.length ? `${parts.join('; ')}.` : '';
}
function sentences(...parts) {
    return parts.filter(Boolean).join(' ');
}
function nextStep(category, info, mode) {
    const details = info.details ?? {};
    const action = info.action_url;
    const needed = credits(details.estimated_credits);
    const balance = credits(details.account_balance_credits);
    const zone = text(details.reset_timezone);
    switch (category) {
        case 'account_balance_insufficient':
            return sentences(balance && `Balance: ${balance}.`, needed && `This request needs about ${needed}.`, `Ask the user to top up at ${action ?? trackedLink(TOP_UP_URL, 'top_up')}, then retry.`);
        case 'mcp_limit_reached':
            return sentences(limitFigures(details, 'EvoLink MCP limit'), needed && `This request needs about ${needed}.`, balance && `Account balance: ${balance} (not the problem).`, `Ask the user to raise or remove the EvoLink MCP limit at ${mcpLimitPlace(action ?? trackedLink(MCP_CONSOLE_URL, 'api_keys'), details)}; it is shared by every assistant connected to their EvoLink account, including the CLI.`, 'Do not retry until they have changed it.');
        case 'mcp_daily_limit_reached': {
            const used = credits(details.daily_used_credits);
            const limit = credits(details.daily_limit_credits);
            return sentences(used && limit && `Today's EvoLink MCP spending: ${used} of the ${limit} daily limit.`, `It resets automatically at midnight${zone ? ` (${zone})` : ''}.`, balance && `Account balance: ${balance} (not the problem).`, `To continue today, ask the user to raise the EvoLink MCP daily limit at ${mcpLimitPlace(action ?? trackedLink(MCP_CONSOLE_URL, 'api_keys'), details)}; this daily limit is shared by CLI and MCP.`);
        }
        case 'mcp_paused':
            return `Ask the user to resume EvoLink MCP at ${mcpLimitPlace(action ?? trackedLink(MCP_CONSOLE_URL, 'api_keys'), details)} (switch it back on; this resumes the shared CLI and MCP key). Do not ask them to reconnect, and do not retry until it is resumed.`;
        case 'mcp_key_expired': {
            const expiredAt = typeof details.expired_at === 'number' && Number.isFinite(details.expired_at) && details.expired_at > 0
                ? new Date(details.expired_at * 1000).toISOString().slice(0, 10)
                : undefined;
            return sentences(expiredAt && `The EvoLink MCP key expired on ${expiredAt} (UTC).`, `Ask the user to extend or clear the expiry date of the EvoLink MCP key at ${mcpLimitPlace(action ?? trackedLink(MCP_CONSOLE_URL, 'api_keys'), details)}.`, 'Do not ask them to reconnect, and do not retry until it is changed.');
        }
        case 'key_quota_exhausted': {
            const name = text(details.key_name);
            return sentences(limitFigures(details, name ? `Limit of API key "${name}"` : 'API key limit'), needed && `This request needs about ${needed}.`, balance && `Account balance: ${balance} (not the problem).`, `Raise this API key's limit at ${action ?? trackedLink(API_KEYS_URL, 'api_keys')}, or use another key.`);
        }
        case 'key_daily_quota_exhausted':
            return `It resets automatically at midnight${zone ? ` (${zone})` : ''}; to continue today, raise this API key's daily limit at ${action ?? trackedLink(API_KEYS_URL, 'api_keys')}.`;
        case 'key_disabled':
            return `This API key is disabled. Enable it at ${action ?? trackedLink(API_KEYS_URL, 'api_keys')} or use another key.`;
        case 'key_expired':
            return `This API key has expired. Extend it at ${action ?? trackedLink(API_KEYS_URL, 'api_keys')} or use another key.`;
        case 'model_not_allowed': {
            const allowed = Array.isArray(details.allowed_models) ? details.allowed_models.slice(0, 20).join(', ') : '';
            return `This key may not use this model.${allowed ? ` Allowed models: ${allowed}.` : ''} Pick an allowed model, or change the key's model list at ${action ?? trackedLink(API_KEYS_URL, 'api_keys')}.`;
        }
        case 'unauthorized':
            if (mode === 'signed_in')
                return 'The EvoLink connection was rejected. Ask the user to reconnect EvoLink in this client.';
            return mode === 'api_key'
                ? 'The API key was rejected. Ask the user to check the EvoLink API key configured in this client.'
                : 'The API key was rejected. Check EVOLINK_API_KEY or the configured API-key credential helper. The browser CLI uses `evolink auth login` independently.';
        case 'forbidden':
            return 'Access to this resource is denied for this account.';
        case 'rate_limited':
            return `Too many requests. Wait ${info.retry_after_seconds ?? 30} seconds before retrying; do not loop paid submissions.`;
        case 'invalid_request':
            return 'Check the supplied parameters before retrying. get_model lists every parameter with its allowed values.';
        case 'not_found':
            return 'Nothing matches this ID. Check it, or use list_tasks to find recent tasks.';
        case 'content_policy':
            return 'The prompt or input was blocked by content review. Review the applicable content policy and revise the input. Do not bypass content review.';
        case 'service_unavailable':
            return 'EvoLink is temporarily unavailable. Check the original task or request ID before retrying a paid submission.';
        case 'model_unavailable':
            return 'The model is temporarily unavailable. Retry in a minute, or pick another model with search_models.';
        case 'idempotency_conflict':
            return 'This client_request_id was already used for a different request. Recover the original request first. A different generation requires a new estimate and explicit user approval; it is a separately paid task.';
        case 'outcome_unknown':
            return 'The earlier submission with this client_request_id is still being processed or its outcome is unknown. Do not submit it again with a new id: wait a minute and retry with the same client_request_id, or look it up with list_tasks.';
        case 'request_too_large':
            return 'The request is too large. Pass big files as links (a public URL, or one from upload_file where it is available) instead of inline data.';
        case 'server_error':
            return 'EvoLink had a temporary error. Retry in a minute; for paid generations check list_tasks first so the task is not submitted twice.';
        case 'connection_ended':
            return 'This EvoLink connection is no longer active (it was revoked, expired, or signed out). Ask the user to reconnect the existing EvoLink connection in this client instead of adding a new one.';
        case 'session_check_unavailable':
            return 'EvoLink sign-in verification is temporarily unavailable. Retry in a minute; do not reconnect.';
        case 'connection_setup_failed':
            return 'EvoLink could not set up this connection yet. Retry in a minute.';
        case 'service_misconfigured':
            return 'The EvoLink MCP service could not authenticate this request. This is a server-side problem, not the user\'s connection: do not reconnect, and try again later.';
        case 'mcp_channel_disabled':
            return 'EvoLink has temporarily turned off MCP access. Try again later; switching models, retrying right away or reconnecting will not help.';
        case 'sign_in_token_rejected':
            return 'EvoLink did not accept this connection\'s sign-in token; it may have just expired. Retry the call, which carries a refreshed token; if it keeps failing, ask the user to reconnect the existing EvoLink connection in this client.';
        case 'account_disabled':
            return 'This EvoLink account is disabled. Ask the user to contact EvoLink support.';
    }
}
/** Classifies one non-2xx gateway or files-api response. */
export function classifyGatewayError(status, body, retryAfterMs, headerRequestId) {
    const error = envelope(body);
    const rawCode = text(error.code)?.toLowerCase();
    const knownCodes = new Set([...ACCOUNT_CODES, ...KEY_QUOTA_CODES, ...KEY_DAILY_CODES, ...CONTENT_CODES, ...UNAVAILABLE_CODES, ...CONNECTION_ENDED_CODES, ...SERVICE_CODES,
        'mcp_paused', 'mcp_key_expired', 'mcp_channel_disabled', 'key_disabled', 'key_expired', 'key_model_not_allowed', 'idempotency_conflict', 'paid_outcome_unknown', 'agent_session_unavailable', 'mcp_connection_create_failed', 'mcp_token_invalid', 'user_disabled', 'upload_token_rate_limited', 'upload_token_unavailable', 'service_unavailable', 'invalid_token', 'internal_error', 'invalid_parameters', 'invalid_parameter', 'invalid_media_url', 'invalid_request']);
    const code = rawCode && knownCodes.has(rawCode) ? rawCode : undefined;
    const mode = currentCredentialMode();
    const mcpScope = text(error.limit_scope)?.toLowerCase() === 'mcp';
    const category = categorize(status, code ?? '', mode, mcpScope || mode === 'signed_in');
    const requestId = publicIdentifier(error.request_id) ?? publicIdentifier(headerRequestId);
    // Remote prose, stack traces and suggestions are never promoted into assistant instructions.
    let message = headlineFor(category) ?? {
        invalid_request: 'EvoLink rejected the request parameters. Check get_model for the current rules.',
        content_policy: 'The prompt or input was blocked by content review.',
        unauthorized: 'EvoLink could not authenticate this request.',
        forbidden: 'Access to this resource is denied.',
        not_found: 'The requested resource was not found.',
        rate_limited: 'The request rate limit was reached.',
        request_too_large: 'The request exceeds the allowed size.',
        model_unavailable: 'The requested model is temporarily unavailable.',
        service_unavailable: 'EvoLink is temporarily unavailable.',
        idempotency_conflict: 'This request ID is already associated with a different request.',
        outcome_unknown: 'The earlier submission outcome is unknown.',
    }[category] ?? 'EvoLink could not complete this operation.';
    if (status === 415 && category === 'invalid_request')
        message = 'The request uses an unsupported file type or media format.';
    const details = {};
    for (const field of DETAIL_FIELDS) {
        const value = error[field];
        if (field.endsWith('_credits') || field === 'expired_at') {
            const n = publicNumber(value);
            if (n !== undefined && (field !== 'expired_at' || n <= 253402300799))
                details[field] = n;
        }
        else if (field === 'allowed_models' && Array.isArray(value)) {
            details[field] = value.slice(0, 20).map(publicIdentifier).filter(Boolean);
        }
        else {
            const label = publicLabel(value);
            if (label)
                details[field] = label;
        }
    }
    const param = typeof error.param === 'string' && /^[A-Za-z_][A-Za-z0-9_.\[\]]{0,100}$/.test(error.param) ? error.param : undefined;
    if (category === 'invalid_request' && param) {
        message += ` Parameter: ${param}.`;
        for (const field of ['min', 'max']) {
            const n = publicNumber(error[field]);
            if (n !== undefined)
                details[field] = n;
        }
        if (Array.isArray(error.allowed_values))
            details.allowed_values = error.allowed_values.slice(0, 30)
                .filter(value => publicNumber(value) !== undefined || publicLabel(value) !== undefined);
    }
    let actionUrl;
    if (category === 'account_balance_insufficient') {
        actionUrl = trackedLink(siteUrl(text(error.action_url), TOP_UP_URL), 'top_up');
    }
    else if (MCP_LIMIT_CATEGORIES.has(category)) {
        actionUrl = trackedLink(siteUrl(text(error.action_url), MCP_CONSOLE_URL), 'api_keys');
    }
    else if (KEY_CATEGORIES.has(category)) {
        actionUrl = trackedLink(siteUrl(text(error.action_url), API_KEYS_URL), 'api_keys');
    }
    const headline = headlineFor(category);
    const info = {
        status,
        category,
        ...(headline ? { headline } : {}),
        code,
        ...(param ? { param } : {}),
        message,
        next_step: '',
        retryable: RETRYABLE.has(category),
        retry_after_seconds: retryAfterMs !== undefined ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : undefined,
        action_url: actionUrl,
        request_id: requestId,
        details: Object.keys(details).length > 0 ? details : undefined,
    };
    info.next_step = nextStep(category, info, mode);
    return info;
}
/**
 * With a headline the first line says which limit it is; the gateway's own
 * sentence is left out because it speaks of "API key …" even for the MCP key.
 */
export function formatGatewayError(info) {
    const status = `${info.status}${info.code ? ` ${info.code}` : ''}`;
    const lines = info.headline
        ? [info.headline, `Next step: ${info.next_step}`, `Error: HTTP ${status}`]
        : [`[${status}] ${info.message}`, `Next step: ${info.next_step}`];
    if (info.request_id)
        lines.push(`Request ID: ${info.request_id}`);
    return lines.join('\n');
}
export function formatApiError(status, body) {
    return formatGatewayError(classifyGatewayError(status, body));
}
const TASK_ERROR_MAP = {
    content_policy_violation: {
        suggestion: 'Review the applicable content policy and revise the input. Do not bypass content review.',
        retryable: false,
    },
    invalid_parameters: {
        suggestion: 'Check the parameter values (prompt length, image size, duration, resolution) against get_model.',
        retryable: false,
    },
    image_dimension_mismatch: {
        suggestion: 'Check the input dimensions and aspect ratio against this model’s get_model rules.',
        retryable: false,
    },
    image_processing_error: {
        suggestion: 'The input image could not be processed. Check accessibility, format and size against this model’s get_model rules.',
        retryable: false,
    },
    request_cancelled: {
        suggestion: 'The task was cancelled. Check this task’s billing state before deciding whether to request another generation.',
        retryable: false,
    },
    resource_not_found: {
        suggestion: 'The task or an input resource was not found or has expired. Check the IDs and links.',
        retryable: false,
    },
    generation_timeout: {
        suggestion: 'The generation timed out. Check the original task and its billing state before considering another generation.',
        retryable: true,
    },
    quota_exceeded: {
        suggestion: `The generation encountered a quota limit. Check balance and limits before requesting another generation; top up at ${TOP_UP_URL} if the balance is low.`,
        retryable: true,
    },
    resource_exhausted: {
        suggestion: 'Generation capacity was temporarily exhausted. Wait before considering another generation.',
        retryable: true,
    },
    generation_failed_no_content: {
        suggestion: 'The model returned no output. The cause is not established; retain the task ID and contact EvoLink support if needed.',
        retryable: false,
    },
    service_error: {
        suggestion: 'The generation service reported an error. Retain the task ID and check its billing state.',
        retryable: true,
    },
    service_unavailable: {
        suggestion: 'The generation service was temporarily unavailable. Retain the task ID and check its billing state.',
        retryable: true,
    },
    unknown_error: {
        suggestion: 'The cause is unknown. Give the task ID to EvoLink support; do not generate again automatically.',
        retryable: false,
    },
};
export function getTaskErrorInfo(code) {
    const info = TASK_ERROR_MAP[code] ?? TASK_ERROR_MAP.unknown_error;
    // The top-up link is tagged for the caller when the hint is shown, not when the table is built.
    return info.suggestion.includes(TOP_UP_URL)
        ? { ...info, suggestion: info.suggestion.replace(TOP_UP_URL, trackedLink(TOP_UP_URL, 'top_up')) }
        : info;
}
export function publicTaskError(error = {}) {
    const code = Object.prototype.hasOwnProperty.call(TASK_ERROR_MAP, error.code ?? '')
        ? error.code : 'unknown_error';
    const info = getTaskErrorInfo(code);
    return { code, message: code === 'unknown_error' ? 'Generation failed; the cause is unknown.'
            : `Generation did not complete (${code}).`, ...info };
}
export function formatTaskError(error) {
    const info = publicTaskError(error);
    return `Error code: ${info.code}\nMessage: ${info.message}\nSuggestion: ${info.suggestion}`;
}
