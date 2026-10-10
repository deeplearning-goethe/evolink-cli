// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
/** Only bounded public primitives may cross an error boundary. Result URLs use a separate delivery contract. */
export function publicIdentifier(value) {
    return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
        && !/^(sk-|evup_|eyJ)/i.test(value) ? value : undefined;
}
export function publicText(value) {
    const ids = [];
    const protectedText = value.slice(0, 2000).replace(/client_request_id "([A-Za-z0-9._-]{16,96})"/g, (match, id) => {
        if (!publicIdentifier(id))
            return match;
        ids.push(id);
        return `client_request_id "PUBLICCORRELATION${ids.length - 1}"`;
    });
    return protectedText
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\b(?:sk-|evup_)[a-zA-Z0-9_-]+/g, '[redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
        .replace(/https?:\/\/[^\s"'<>]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?(?![A-Za-z0-9_.-])/gi, value => {
        if (/^(input|params|parameters|task|usage|billing|quote|estimate)\.[A-Za-z_][A-Za-z0-9_.]*$/.test(value))
            return value;
        const suffix = /[.,;:!?)]+$/.exec(value)?.[0] ?? '';
        const candidate = suffix ? value.slice(0, -suffix.length) : value;
        try {
            const url = new URL(candidate);
            if (url.origin === 'https://evolink.ai' && !url.username && !url.password && !url.hash
                && ['/dashboard/credits', '/dashboard/keys', '/dashboard/mcp'].includes(url.pathname)
                && [...url.searchParams].every(([key, v]) => key.startsWith('utm_') && /^[a-z0-9_-]{1,80}$/i.test(v) || key === 'tab' && v === 'mcp'))
                return value;
        }
        catch { }
        return '[service address]';
    })
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
        .replace(/PUBLICCORRELATION(\d+)/g, (match, n) => ids[Number(n)] ?? match);
}
export function publicNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : undefined;
}
/** Reject prose in identifiers/names rather than letting remote text become an instruction. */
export function publicLabel(value) {
    if (typeof value !== 'string' || !/^[\p{L}\p{N} _()/-]{1,80}$/u.test(value))
        return undefined;
    return publicText(value) === value ? value : undefined;
}
export function publicErrorDetails(value, depth = 0, seen = new WeakSet(), key = '') {
    if (depth > 8)
        return '[truncated]';
    if (typeof value === 'string')
        return ['client_request_id', 'task_id', 'quote_id', 'request_id'].includes(key) ? publicIdentifier(value) : publicText(value);
    if (value && typeof value === 'object') {
        if (seen.has(value))
            return '[truncated]';
        seen.add(value);
        if (Array.isArray(value))
            return value.slice(0, 100).map(v => publicErrorDetails(v, depth + 1, seen, key));
        return Object.fromEntries(Object.entries(value).slice(0, 100)
            .filter(([key]) => !/^(authorization|access_token|refresh_token|api_key|secret|password|client_secret)$/i.test(key))
            .map(([key, nested]) => [publicText(key), publicErrorDetails(nested, depth + 1, seen, key)]));
    }
    return typeof value === 'number' && !Number.isFinite(value) ? undefined : value;
}
