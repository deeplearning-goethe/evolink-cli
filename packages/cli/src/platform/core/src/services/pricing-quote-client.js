// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requestAccountQuote } from './api-client.js';
import { getPricingRules, PricingMoney } from './pricing-rules-client.js';
const decimal = z.string().max(64).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const rational = z.string().max(128).regex(/^(?:0|[1-9]\d*)(?:\.\d+|\/[1-9]\d*)?$/);
export const QuoteParameters = z.record(z.string().min(1).max(100), z.union([z.string().max(128), z.number().finite(), z.boolean()]))
    .refine(value => Object.keys(value).length <= 100, 'At most 100 pricing parameters are allowed.');
const Component = z.object({ id: identifier, role: identifier, dimension: identifier, sku_id: identifier,
    quantity: rational, billed_quantity: rational, unit: identifier, unit_price: decimal, subtotal: decimal,
    unit_price_amounts: PricingMoney, subtotal_amounts: PricingMoney, minimum_charge_amounts: PricingMoney,
    tier_multiplier: decimal.refine(value => compareDecimal(value, '0') > 0), minimum_charge_applied: z.boolean(), billing_rule: identifier,
    applied_rules: z.array(z.string().max(128)).max(100) });
export const AccountQuoteSchema = z.object({ estimate_id: identifier, catalog_version: identifier,
    pricing_version: identifier, exchange_rate_version: z.literal('pricing-fx/v1:USD-CNY=6.8'),
    price_scope: z.literal('account'), policy_version: z.number().int().positive(),
    policy_checksum: z.string().regex(/^[a-f0-9]{64}$/), model_id: identifier, product_id: identifier,
    operation: identifier, settlement_basis: z.enum(['request_only', 'actual_usage', 'request_then_actual']),
    currency: z.literal('USD'), amount: decimal, amounts: PricingMoney,
    components: z.array(Component).min(1).max(200), assumptions: z.array(z.string().max(2000)).max(100),
    expires_at: z.string().datetime({ offset: true }) });
export const ApprovedAccountQuote = z.object({ quote: AccountQuoteSchema,
    request_hash: z.string().regex(/^[a-f0-9]{64}$/), parameters: QuoteParameters }).strict();
export class QuoteError extends Error {
    code;
    param;
    constructor(code, message, param) {
        super(message);
        this.code = code;
        this.param = param;
    }
}
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
            .filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    return JSON.stringify(value);
}
export function quoteRequestHash(model, input, mediaSeconds, pricingParameters = {}) {
    return createHash('sha256').update(canonical({ model: model.toLowerCase(), input, media_seconds: mediaSeconds,
        pricing_parameters: pricingParameters })).digest('hex');
}
function fail(code, message, param) { throw new QuoteError(code, message, param); }
const aliases = { duration_seconds: ['duration'], output_seconds: ['duration'], image_count: ['n', 'count'],
    video_count: ['n', 'count'], resolution: ['quality'], quality: ['resolution'] };
const measured = /(?:tokens|input_seconds|output_seconds|source_output_seconds|first_input_video_seconds|search_count)$/;
/** Map only declared billing parameters. Prompts and asset URLs stay in generation input. */
export function prepareQuoteParameters(rule, entry, input, pricingParameters = {}, mediaSeconds) {
    const declared = new Map((rule.parameters ?? []).map(p => [p.name, p]));
    for (const name of Object.keys(pricingParameters))
        if (!declared.has(name)) {
            fail('unsupported_quote_parameter', `The pricing policy does not declare parameter ${name}.`, name);
        }
    const parameters = {};
    for (const [name, p] of declared) {
        const generationNames = [name, ...(aliases[name] ?? [])];
        const supplied = generationNames.filter(key => input[key] !== undefined).map(key => input[key]);
        if (supplied.some(value => String(value) !== String(supplied[0]))) {
            fail('conflicting_quote_parameter', `Conflicting generation values for ${name}.`, name);
        }
        let value = supplied[0];
        if (pricingParameters[name] !== undefined) {
            if (value !== undefined && String(value) !== String(pricingParameters[name])) {
                fail('conflicting_quote_parameter', `Pricing parameter ${name} differs from the generation input.`, name);
            }
            value = pricingParameters[name];
        }
        if (name === 'input_seconds' && value !== undefined && mediaSeconds !== undefined
            && String(value) !== String(mediaSeconds)) {
            fail('conflicting_quote_parameter', 'input_seconds differs from media_seconds.', name);
        }
        if (value === undefined && name === 'input_images') {
            const images = input.image_urls;
            if (Array.isArray(images))
                value = images.length;
            else if (typeof input.image_url === 'string')
                value = 1;
        }
        // media_seconds describes measured input length, never an unknown generated output.
        if (value === undefined && name === 'input_seconds' && mediaSeconds !== undefined)
            value = mediaSeconds;
        if (value === undefined && !measured.test(name)) {
            const defaults = generationNames.map(key => entry.spec?.params[key]?.default).filter(v => v !== undefined);
            value = defaults[0];
        }
        const references = input.video_urls !== undefined || input.video_url !== undefined || input.source_task_id !== undefined;
        if (value === undefined && measured.test(name) && (p.required || references || /tokens$/.test(name) || (name === 'search_count' && input.web_search === true) || p.default === undefined)) {
            fail('quote_usage_required', `Provide measured or expected usage for ${name} in pricing_parameters.`, name);
        }
        if (value === undefined)
            value = p.default;
        if (value === undefined) {
            if (p.required)
                fail('quote_parameter_required', `Pricing parameter ${name} is required.`, name);
            continue;
        }
        if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
            fail('invalid_quote_parameter', `Pricing parameter ${name} must be a finite scalar.`, name);
        }
        if (typeof value === 'string' && value.length > 128)
            fail('invalid_quote_parameter', `Pricing parameter ${name} is too long.`, name);
        if (p.type === 'integer' || p.type === 'decimal') {
            if (typeof value === 'boolean' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value))
                || (p.type === 'integer' && !/^-?(?:0|[1-9]\d*)$/.test(String(value)))) {
                fail('invalid_quote_parameter', `Pricing parameter ${name} must be ${p.type}.`, name);
            }
            if ((p.minimum !== undefined && compareDecimal(String(value), p.minimum) < 0)
                || (p.maximum !== undefined && compareDecimal(String(value), p.maximum) > 0)) {
                fail('invalid_quote_parameter', `Pricing parameter ${name} is outside the published range.`, name);
            }
        }
        else if (p.type === 'boolean' && typeof value !== 'boolean') {
            fail('invalid_quote_parameter', `Pricing parameter ${name} must be boolean.`, name);
        }
        const allowed = p.values ?? p.enum;
        if (allowed && !allowed.some(candidate => candidate === value))
            fail('invalid_quote_parameter', `Pricing parameter ${name} is not an allowed value.`, name);
        parameters[name] = value;
    }
    return parameters;
}
function decimalFraction(value) {
    const negative = value.startsWith('-');
    const [mantissa, exponent = '0'] = (negative ? value.slice(1) : value).toLowerCase().split('e');
    const [whole, part = ''] = mantissa.split('.');
    const scale = part.length - Number(exponent);
    const numerator = (negative ? -1n : 1n) * BigInt(whole + part);
    return scale >= 0 ? [numerator, 10n ** BigInt(scale)] : [numerator * 10n ** BigInt(-scale), 1n];
}
export function compareDecimal(left, right) {
    const [l, ld] = decimalFraction(left), [r, rd] = decimalFraction(right);
    return l * rd < r * ld ? -1 : l * rd > r * ld ? 1 : 0;
}
export function validateAccountQuote(raw, request, now = Date.now()) {
    const parsed = AccountQuoteSchema.safeParse(raw);
    if (!parsed.success)
        fail('invalid_account_quote', 'The account quote response is incomplete or invalid.');
    const quote = parsed.data;
    if (quote.model_id !== request.model_id || quote.operation !== request.operation)
        fail('mismatched_account_quote', 'The account quote belongs to a different model or operation.');
    if (Date.parse(quote.expires_at) <= now)
        fail('expired_account_quote', 'The account quote has expired. Request a fresh quote.');
    if (!/^\d+$/.test(quote.amounts.uc) || !Number.isSafeInteger(Number(quote.amounts.uc))
        || compareDecimal(quote.amount, quote.amounts.usd) !== 0)
        fail('invalid_account_quote', 'The account quote has inconsistent amounts.');
    let total = 0n;
    const ids = new Set();
    for (const item of quote.components) {
        if (ids.has(item.id) || !/^\d+$/.test(item.subtotal_amounts.uc)
            || compareDecimal(item.subtotal, item.subtotal_amounts.usd) !== 0
            || compareDecimal(item.unit_price, item.unit_price_amounts.usd) !== 0) {
            fail('invalid_account_quote', 'The account quote component amounts are inconsistent.');
        }
        ids.add(item.id);
        total += BigInt(item.subtotal_amounts.uc);
    }
    if (total !== BigInt(quote.amounts.uc))
        fail('invalid_account_quote', 'The account quote components do not sum to its total.');
    return quote;
}
export async function createAccountQuote(config, entry, input, options = {}) {
    const { body } = await getPricingRules({ model: entry.id.toLowerCase(), view: 'full' }, { fresh: true });
    const rule = 'model' in body ? body.model : body.models[0];
    if (!rule || rule.modality !== entry.kind || rule.policy_source !== 'published' || rule.pricing_status !== 'available') {
        fail('account_quote_unavailable', 'This model has no available published media pricing policy.');
    }
    const parameters = prepareQuoteParameters(rule, entry, input, options.pricingParameters, options.mediaSeconds);
    const request = { model_id: rule.model_id, operation: rule.operation, parameters, expected_usage: {} };
    const quote = validateAccountQuote(await requestAccountQuote(config, request), request);
    if (quote.policy_version !== rule.policy_version || quote.policy_checksum !== rule.policy_checksum
        || quote.product_id !== rule.product_id || quote.settlement_basis !== rule.settlement_basis) {
        fail('quote_policy_changed', 'The published policy changed while quoting. Request another quote.');
    }
    for (const component of quote.components) {
        const policyComponent = rule.components.find(item => item.id === component.id);
        if (!policyComponent || policyComponent.role !== component.role || policyComponent.unit !== component.unit
            || ![policyComponent.sku_id, ...policyComponent.tiers.map(item => item.sku_id)].includes(component.sku_id)) {
            fail('mismatched_account_quote', 'The account quote components do not match the published policy.');
        }
    }
    const approval = { quote, parameters,
        request_hash: quoteRequestHash(entry.id, input, options.mediaSeconds, options.pricingParameters) };
    return { quote, approval, estimate: accountCostEstimate(quote) };
}
export function accountCostEstimate(quote) {
    return { status: 'estimated', min_usd: Number(quote.amount), max_usd: Number(quote.amount),
        min_credits: Number(quote.amounts.credits), max_credits: Number(quote.amounts.credits),
        basis: ['Authenticated account Quote using the published policy.'], possible_extras: [],
        notes: [quote.settlement_basis === 'request_only'
                ? 'Estimated for the requested settings; the task reports the final charge when it finishes.'
                : 'Final cost depends on actual billed usage and may differ from this estimate.'] };
}
export function checkApprovedAccountQuote(approval, model, input, mediaSeconds, pricingParameters, cap) {
    const quote = validateAccountQuote(approval.quote, { model_id: model.toLowerCase(), operation: approval.quote.operation });
    if (approval.request_hash !== quoteRequestHash(model, input, mediaSeconds, pricingParameters)) {
        fail('quote_input_changed', 'The generation input differs from the approved account quote. Request a new quote.');
    }
    if (cap !== undefined && compareDecimal(quote.amount, String(cap)) > 0)
        fail('cost_exceeds_cap', 'The account estimate exceeds max_cost_usd.');
    return quote;
}
