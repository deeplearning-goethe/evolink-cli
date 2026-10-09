// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { execFileSync } from 'node:child_process';
import { currentRequestCredentials, processCredentialsAllowed } from './request-context.js';
import { API_KEYS_URL } from './services/http-policy.js';
import { trackedLink } from './services/utm.js';
import { MCP_VERSION } from './version.js';
const BASE_URLS = {
    official: 'https://api.evolink.ai',
    beta: 'https://beta-api.evolink.ai',
};
/**
 * EVOLINK_BASE_URL overrides the channel default so the same build can point
 * at canary/staging gateways (e.g. https://t-api.evolink.ai) without patching
 * dist. HTTPS is required except for loopback development hosts.
 */
function resolveBaseUrl(channel) {
    const override = (process.env.EVOLINK_BASE_URL ?? '').trim().replace(/\/+$/, '');
    if (!override)
        return BASE_URLS[channel];
    let parsed;
    try {
        parsed = new URL(override);
    }
    catch {
        throw new Error(`EVOLINK_BASE_URL is not a valid URL: ${override}`);
    }
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
        throw new Error('EVOLINK_BASE_URL must use HTTPS (or HTTP on localhost).');
    }
    return override;
}
export function createConfig(channel) {
    return {
        channel,
        baseUrl: resolveBaseUrl(channel),
    };
}
/**
 * The User-Agent of the hosted service's gateway calls. EvoLink's own services
 * use "<service>/<version>"; the gateway records whether a signed-in call came
 * through this service (mcp_via_service) and never authenticates by it.
 */
export const MCP_SERVICE_USER_AGENT = `evolink-mcp-service/${MCP_VERSION}`;
/**
 * Authentication headers for one gateway call. A signed-in hosted connection
 * forwards its own Passport access token (key custody A) with the service
 * User-Agent; everything else sends the caller's API key.
 */
export function gatewayAuthHeaders() {
    const channel = currentRequestCredentials()?.serviceChannel;
    if (!channel)
        return { 'Authorization': `Bearer ${getApiKey()}` };
    return {
        'User-Agent': currentRequestCredentials()?.http?.userAgent ?? MCP_SERVICE_USER_AGENT,
        'Authorization': `Bearer ${channel.accessToken}`,
    };
}
export function getApiKey() {
    const scoped = currentRequestCredentials();
    if (scoped) {
        if (scoped.apiKey)
            return scoped.apiKey;
        throw new Error(scoped.unavailableReason ?? 'No EvoLink credential is available for this request.');
    }
    if (!processCredentialsAllowed()) {
        throw new Error('No EvoLink credential is available for this request.');
    }
    const configured = process.env.EVOLINK_API_KEY?.trim();
    if (configured)
        return configured;
    const helper = process.env.EVOLINK_CREDENTIAL_HELPER?.trim() || 'evolink';
    if (helper.includes('\0'))
        throw new Error('EVOLINK_CREDENTIAL_HELPER is invalid');
    try {
        const key = execFileSync(helper, ['credential', 'get'], {
            encoding: 'utf8',
            timeout: 5_000,
            maxBuffer: 64 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (key)
            return key;
    }
    catch {
        // Return one stable recovery message without echoing helper stderr or key material.
    }
    throw new Error(`No EvoLink API key is available. Set EVOLINK_API_KEY to a key from ${trackedLink(API_KEYS_URL, 'api_keys')}, ` +
        'or set EVOLINK_CREDENTIAL_HELPER to an API-key helper that implements `credential get`. ' +
        'The browser-login @evolinkai/cli does not export API keys; use its own `evolink auth login` workflow or hosted MCP for OAuth.');
}
