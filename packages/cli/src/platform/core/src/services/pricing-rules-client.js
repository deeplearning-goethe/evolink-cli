// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { currentRequestCredentials } from '../request-context.js';
import { controlBaseURL } from './pricing-client.js';
import { DEFAULT_READ_TIMEOUT_MS, evoHeaders, fetchWithTimeout, timeoutFromEnv } from './http-policy.js';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;
const CACHE_TTL_MS = 60_000;
const decimal = z.string().max(64).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const identifier = (max) => z.string().trim().max(max).regex(/^[a-z0-9][a-z0-9._:-]*$/);
const optionalFilter = (schema) => z.preprocess(value => typeof value === 'string' && value.trim() === '' ? undefined : value, schema.optional());
export const PricingRulesQuery = z.object({
    model: optionalFilter(identifier(100)), product_id: optionalFilter(identifier(100)),
    operation: optionalFilter(z.string().trim().toLowerCase().pipe(identifier(50))),
    modality: optionalFilter(z.string().trim().toLowerCase().pipe(z.enum(['text', 'image', 'video', 'audio']))),
    lifecycle: optionalFilter(z.string().trim().toLowerCase().pipe(z.enum(['active', 'preview', 'deprecated']))),
    view: z.preprocess(value => typeof value === 'string' && value.trim() === '' ? undefined : value, z.string().trim().toLowerCase().pipe(z.enum(['summary', 'full'])).default('full')),
}).strict();
// Preserve decimal strings. Do not sum display USD floats or infer a bill.
function fraction(value) {
    const [whole, part = ''] = value.split('.');
    return [BigInt(whole + part), 10n ** BigInt(part.length)];
}
const Money = z.object({ uc: decimal, credits: decimal, cny: decimal, usd: decimal })
    .refine(value => {
    // Live configuration rates can contain fractional UC (e.g. 1102.5),
    // although the initial HTML describes UC as an integer. Settlement
    // rounding belongs to the server; never truncate configuration amounts.
    if (!Object.values(value).every(part => typeof part === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(part)))
        return false;
    const [uc, udc] = fraction(value.uc), [credits, cd] = fraction(value.credits), [cny, yd] = fraction(value.cny), [usd, ud] = fraction(value.usd);
    const delta = usd * 680000n * udc - uc * ud;
    return credits * 10000n * udc === uc * cd && cny * 100000n * udc === uc * yd
        && (delta < 0n ? -delta : delta) * 100000000n <= 680000n * ud * udc;
}, 'Currency fields must represent the same UC amount.');
const ExpressionSchema = z.lazy(() => z.object({
    op: z.string().min(1).max(40), name: z.string().max(100).optional(), value: z.string().max(128).optional(),
    args: z.array(ExpressionSchema).max(32).optional(),
}));
const Rounding = z.object({ point: z.string().max(80), mode: z.string().max(40) });
const rateFields = {
    sku_id: z.string().min(1).max(100), rate: Money, official_rate: Money.optional(), minimum_charge: Money,
    billing_rule: z.string().min(1).max(60), pricing_status: z.enum(['available', 'unavailable']),
    effective_at: z.string().datetime({ offset: true }),
};
const Tier = z.object({ ...rateFields, multiplier: decimal.refine(value => /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
        && fraction(value)[0] > 0n), when: ExpressionSchema.optional() });
const Component = z.object({ ...rateFields, id: z.string().min(1).max(100), role: z.string().min(1).max(100),
    dimension: z.string().min(1).max(100), unit: z.string().min(1).max(100),
    billing_unit_size: z.number().int().positive().max(1_000_000_000), display_unit_size: z.number().int().positive().max(1_000_000_000),
    condition: ExpressionSchema.optional(), quantity_rule: ExpressionSchema.optional(), rounding: Rounding.optional(),
    tiers: z.array(Tier).max(100),
});
const Parameter = z.object({ name: z.string().min(1).max(100), type: z.string().min(1).max(60),
    required: z.boolean().optional(), default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    enum: z.array(z.union([z.string(), z.number(), z.boolean()])).max(100).optional(),
    description: z.string().max(2000).optional(), minimum: decimal.optional(), maximum: decimal.optional(),
});
const Model = z.object({
    model_id: identifier(100), product_id: identifier(100), operation: identifier(50),
    modality: z.enum(['text', 'image', 'video', 'audio']), lifecycle: z.enum(['active', 'preview', 'deprecated']),
    pricing_status: z.enum(['available', 'unavailable']), settlement_basis: z.string().min(1).max(100),
    policy_version: z.number().int().nonnegative(), policy_checksum: z.string().regex(/^[a-f0-9]{64}$/),
    policy_source: z.enum(['published', 'legacy_text_adapter']), parameters: z.array(Parameter).max(100).optional(),
    components: z.array(Component).min(1).max(200),
});
const Meta = z.object({ schema_version: z.literal('2'), catalog_version: z.string().min(1).max(128),
    pricing_version: z.string().min(1).max(128), price_scope: z.literal('public_default'), currency: z.literal('USD'),
    price_selection: z.enum(['configured_minimum', 'route_priority']).optional(),
    exchange_rate_version: z.literal('pricing-fx/v1:USD-CNY=6.8'),
    updated_at: z.string().datetime({ offset: true }), fresh_until: z.string().datetime({ offset: true }),
});
const List = z.object({ meta: Meta, models: z.array(Model).max(1000) });
const Single = z.object({ meta: Meta, model: Model });
const cache = new Map();
const pending = new Map();
export class PricingRulesError extends Error {
    code;
    status;
    retryAfter;
    constructor(code, status = 0, retryAfter) {
        super('Public pricing rules are unavailable or invalid. No quote or spending limit was established.');
        this.code = code;
        this.status = status;
        this.retryAfter = retryAfter;
    }
}
function bounded(value, depth = 0, budget = { nodes: 0 }) {
    if (depth > 24 || ++budget.nodes > 100_000)
        return false;
    if (Array.isArray(value))
        return value.every(item => bounded(item, depth + 1, budget));
    if (value && typeof value === 'object')
        return Object.values(value).every(item => bounded(item, depth + 1, budget));
    return true;
}
export function validatePricingRules(body, single) {
    if (!bounded(body))
        throw new PricingRulesError('invalid_pricing_rules');
    const parsed = (single ? Single : List).safeParse(body);
    if (!parsed.success)
        throw new PricingRulesError('invalid_pricing_rules');
    if (Date.parse(parsed.data.meta.fresh_until) <= Date.now())
        throw new PricingRulesError('expired_pricing_rules');
    return parsed.data;
}
async function readBody(response) {
    if (!response.body)
        throw new PricingRulesError('invalid_pricing_rules');
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    let rejectRead;
    const stopped = new Promise((_resolve, reject) => { rejectRead = reject; });
    const stop = (code) => { rejectRead(new PricingRulesError(code)); void reader.cancel().catch(() => { }); };
    const timer = setTimeout(() => stop('pricing_rules_timeout'), timeoutFromEnv('EVOLINK_MCP_READ_TIMEOUT_MS', DEFAULT_READ_TIMEOUT_MS));
    const signal = currentRequestCredentials()?.http?.signal;
    const abort = () => stop('interrupted');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted)
        abort();
    try {
        while (true) {
            const { done, value } = await Promise.race([reader.read(), stopped]);
            if (done)
                break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES)
                throw new PricingRulesError('pricing_rules_too_large');
            chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch (error) {
        await reader.cancel().catch(() => { });
        if (error instanceof PricingRulesError)
            throw error;
        throw new PricingRulesError('invalid_pricing_rules');
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reader.releaseLock();
    }
}
export async function getPricingRules(input) {
    const query = PricingRulesQuery.parse(input), base = controlBaseURL();
    const url = new URL(query.model ? `${base}/v1/catalog/models/${encodeURIComponent(query.model)}/pricing-rules`
        : `${base}/v1/catalog/pricing-rules`);
    for (const key of ['product_id', 'operation', 'modality', 'lifecycle', 'view']) {
        if (query[key] !== undefined)
            url.searchParams.set(key, query[key]);
    }
    const key = url.href, old = cache.get(key);
    if (old && old.expires > Date.now())
        return { body: old.body, source: 'cache' };
    const existing = pending.get(key);
    if (existing)
        return existing;
    const task = (async () => {
        let conditional = Boolean(old?.etag);
        for (let attempt = 0; attempt < 2; attempt++) {
            const response = await fetchWithTimeout(key, { method: 'GET', redirect: 'error',
                headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', ...evoHeaders('get_pricing_rules'),
                    ...(conditional ? { 'If-None-Match': old.etag } : {}) },
            }, timeoutFromEnv('EVOLINK_MCP_READ_TIMEOUT_MS', DEFAULT_READ_TIMEOUT_MS));
            if (response.status === 304) {
                if (!conditional || !old)
                    throw new PricingRulesError('invalid_pricing_rules', 304);
                if (Date.parse(old.body.meta.fresh_until) <= Date.now()) {
                    conditional = false;
                    continue;
                }
                old.expires = Math.min(Date.now() + CACHE_TTL_MS, Date.parse(old.body.meta.fresh_until));
                return { body: old.body, source: 'revalidated' };
            }
            if (!response.ok) {
                const status = response.status;
                await response.body?.cancel();
                throw new PricingRulesError(status === 404 ? 'not_found' : status === 429 ? 'rate_limit_exceeded'
                    : status === 503 ? 'pricing_rules_unavailable' : 'pricing_rules_http_error', status, status === 429 ? retryAfterSeconds(response.headers.get('Retry-After')) : undefined);
            }
            const body = validatePricingRules(await readBody(response), Boolean(query.model));
            const models = 'model' in body ? [body.model] : body.models;
            if (models.some(model => (query.model && model.model_id !== query.model)
                || (query.product_id && model.product_id !== query.product_id) || (query.operation && model.operation !== query.operation)
                || (query.modality && model.modality !== query.modality) || (query.lifecycle && model.lifecycle !== query.lifecycle))) {
                throw new PricingRulesError('mismatched_pricing_rules');
            }
            if (query.view === 'full' && models.some(model => model.components.some(component => !component.quantity_rule || !component.rounding
                || component.tiers.some(tier => !tier.when))))
                throw new PricingRulesError('incomplete_pricing_rules');
            if (cache.size >= MAX_CACHE_ENTRIES)
                cache.delete(cache.keys().next().value);
            cache.set(key, { body, etag: response.headers.get('ETag') ?? undefined,
                expires: Math.min(Date.now() + CACHE_TTL_MS, Date.parse(body.meta.fresh_until)) });
            return { body, source: 'live' };
        }
        throw new PricingRulesError('expired_pricing_rules');
    })().finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
}
export function resetPricingRulesCacheForTests() { cache.clear(); pending.clear(); }
function retryAfterSeconds(value) {
    if (!value)
        return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.ceil(seconds);
    const until = Date.parse(value);
    return Number.isFinite(until) ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : undefined;
}
