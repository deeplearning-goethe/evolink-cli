// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { currentLinkContext } from '../request-context.js';
/** Official clients sign in with a fixed client ID metadata document: its host and path name the client. */
const CLIENT_ID_SOURCES = {
    'claude.ai/oauth/claude-code-client-metadata': 'claude_code',
    'claude.ai/oauth/mcp-oauth-client-metadata': 'claude',
    'chatgpt.com/oauth/codex/client.json': 'codex',
    'chatgpt.com/oauth/client.json': 'chatgpt',
};
/** Otherwise the client's own name, case-insensitive, first match wins ("claude code" before "claude"). */
const NAME_SOURCES = [
    [/claude[ -]code/i, 'claude_code'],
    [/claude/i, 'claude'],
    [/codex/i, 'codex'],
    [/chatgpt|openai/i, 'chatgpt'],
    [/cursor/i, 'cursor'],
    [/openclaw/i, 'openclaw'],
    [/hermes/i, 'hermes'],
];
function clientIdSource(clientId) {
    if (!clientId)
        return undefined;
    try {
        const url = new URL(clientId);
        return url.protocol === 'https:' ? CLIENT_ID_SOURCES[`${url.hostname}${url.pathname}`] : undefined;
    }
    catch {
        return undefined;
    }
}
/** Which assistant this is, from a verified OAuth client_id first and then the client's name. */
export function utmSource(client) {
    const name = client.clientName ?? '';
    return clientIdSource(client.clientId) ?? NAME_SOURCES.find(([pattern]) => pattern.test(name))?.[1] ?? 'mcp_other';
}
/**
 * Adds UTM tags to an https://evolink.ai link, before any #fragment and after any
 * query it already has. Other hosts, and links that already carry utm_ tags, come
 * back unchanged.
 */
export function withUtm(link, tags) {
    let url;
    try {
        url = new URL(link);
    }
    catch {
        return link;
    }
    if (url.protocol !== 'https:' || url.hostname !== 'evolink.ai')
        return link;
    if ([...url.searchParams.keys()].some((key) => key.toLowerCase().startsWith('utm_')))
        return link;
    const hashAt = link.indexOf('#');
    const base = hashAt === -1 ? link : link.slice(0, hashAt);
    const fragment = hashAt === -1 ? '' : link.slice(hashAt);
    const separator = !base.includes('?') ? '?' : /[?&]$/.test(base) ? '' : '&';
    const query = `utm_source=${tags.source}&utm_medium=mcp&utm_campaign=${tags.campaign}&utm_content=${tags.content}`;
    return `${base}${separator}${query}${fragment}`;
}
/** A link for the assistant to show, tagged with the calling client and this server's edition. */
export function trackedLink(link, content) {
    const context = currentLinkContext();
    return withUtm(link, { source: utmSource(context), campaign: context.campaign, content });
}
