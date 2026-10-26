// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { currentRequestCredentials } from '../request-context.js';
const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;
const calls = new Map();
let clock = () => Date.now();
/**
 * Price checks (estimate_cost, get_pricing_rules) each signed-in account may make per minute, per tool. The hosted
 * service reaches the platform's per-IP catalog limit from one address for everyone, so one busy assistant must not
 * use it up. A local server serves one user and is not limited here. EVOLINK_MCP_PRICING_CALLS_PER_MINUTE changes
 * the number; 0 turns the limit off.
 */
export function pricingCallsPerMinute() {
    const raw = process.env.EVOLINK_MCP_PRICING_CALLS_PER_MINUTE;
    const value = raw === undefined || raw.trim() === '' ? 30 : Number(raw);
    return Number.isInteger(value) && value >= 0 && value <= 100_000 ? value : 30;
}
/** Counts one call. An account already at its limit is not counted; the result says when its oldest call leaves the window. */
export function pricingCallLimitReached(tool) {
    const owner = currentRequestCredentials()?.uploadOwner, limit = pricingCallsPerMinute();
    if (!owner || limit === 0)
        return undefined;
    const key = `${tool} ${owner}`, now = clock();
    const recent = (calls.get(key) ?? []).filter(at => now - at < WINDOW_MS);
    calls.delete(key);
    if (recent.length >= limit) {
        calls.set(key, recent);
        return { limit, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000)) };
    }
    calls.set(key, [...recent, now]);
    // The least recently used account leaves first once the map is full.
    if (calls.size > MAX_KEYS)
        calls.delete(calls.keys().next().value);
    return undefined;
}
export function resetPricingCallsForTests(now) {
    calls.clear();
    clock = now ?? (() => Date.now());
}
