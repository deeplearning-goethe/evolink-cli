// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { getPricingRules } from './pricing-rules-client.js';
import { QuoteError, prepareQuoteParameters, quoteRequestHash } from './pricing-quote-client.js';
function fail(code, message) { throw new QuoteError(code, message); }
function gcd(a, b) { while (b)
    [a, b] = [b, a % b]; return a < 0n ? -a : a; }
function rat(n, d = 1n) {
    if (!d)
        fail('invalid_pricing_expression', 'The pricing rule divides by zero.');
    if (n.toString().length > 4096 || d.toString().length > 4096)
        fail('invalid_pricing_expression', 'The pricing calculation exceeds its size limit.');
    if (d < 0n) {
        n = -n;
        d = -d;
    }
    const g = gcd(n, d);
    return { n: n / g, d: d / g };
}
function decimal(value) {
    const text = String(value);
    if (text.length > 128 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text))
        fail('invalid_pricing_expression', 'The pricing rule requires a finite decimal.');
    const [whole, part = ''] = text.split('.');
    return rat(BigInt(whole + part), 10n ** BigInt(part.length));
}
function numeric(value) {
    if (typeof value === 'object')
        return value;
    if (typeof value === 'string')
        return decimal(value);
    return fail('invalid_pricing_expression', 'The pricing rule requires a number.');
}
function boolean(value) {
    if (typeof value !== 'boolean')
        fail('invalid_pricing_expression', 'The pricing rule requires a boolean condition.');
    return value;
}
const cmp = (a, b) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
const mul = (a, b) => rat(a.n * b.n, a.d * b.d);
const div = (a, b) => rat(a.n * b.d, a.d * b.n);
const add = (a, b) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
function rounded(a, mode) {
    const trunc = a.n / a.d, remainder = a.n % a.d;
    if (mode === 'floor')
        return rat(trunc - (remainder < 0n ? 1n : 0n));
    if (mode === 'ceil')
        return rat(trunc + (remainder > 0n ? 1n : 0n));
    if (mode === 'half_up')
        return rat(trunc + ((remainder < 0n ? -remainder : remainder) * 2n >= a.d ? (a.n < 0n ? -1n : 1n) : 0n));
    return fail('invalid_pricing_expression', 'The pricing rule uses an unsupported rounding mode.');
}
function exact(a) { return a.d === 1n ? String(a.n) : `${a.n}/${a.d}`; }
function display(a, places) {
    const scale = 10n ** BigInt(places), n = rounded(mul(a, rat(scale)), 'half_up').n;
    const text = n.toString().padStart(places + 1, '0');
    return places ? `${text.slice(0, -places)}.${text.slice(-places)}`.replace(/\.?0+$/, '') : text;
}
export function amountsForUC(uc) {
    const a = decimal(uc);
    return { uc, credits: display(div(a, rat(10000n)), 4), cny: display(div(a, rat(100000n)), 5), usd: display(div(a, rat(680000n)), 8) };
}
export function rulesBudgetExceeded(uc, budget) {
    // String(number) may use scientific notation for a small, explicit budget.
    const [mantissa, exp = '0'] = String(budget).split('e');
    const power = Number(exp), b = decimal(mantissa);
    const value = power < 0 ? div(b, rat(10n ** BigInt(-power))) : mul(b, rat(10n ** BigInt(power)));
    return cmp(decimal(uc), mul(value, rat(680000n))) > 0;
}
const arity = { constant: [0, 0], variable: [0, 0], lookup: [0, 0],
    add: [2, 32], multiply: [2, 32], subtract: [2, 2], divide: [2, 2], min: [2, 32], max: [2, 32], clamp: [3, 3],
    ceil: [1, 1], floor: [1, 1], if: [3, 3], eq: [2, 2], neq: [2, 2], lt: [2, 2], lte: [2, 2], gt: [2, 2], gte: [2, 2],
    and: [2, 32], or: [2, 32], not: [1, 1] };
function checkExpression(node, declared, depth = 0, budget = { nodes: 0 }) {
    const bounds = arity[node.op], size = node.args?.length ?? 0;
    if (depth > 32 || ++budget.nodes > 10_000 || !bounds || size < bounds[0] || size > bounds[1]) {
        fail('invalid_pricing_expression', 'The pricing rule has an unsupported or malformed expression.');
    }
    if (node.op === 'constant' && node.value === undefined || node.op === 'variable' && (!node.name || !declared.has(node.name))) {
        fail('invalid_pricing_expression', 'The pricing rule references an undeclared value.');
    }
    if (node.op === 'lookup') {
        if (!node.key || !node.values)
            fail('invalid_pricing_expression', 'The pricing lookup is incomplete.');
        checkExpression(node.key, declared, depth + 1, budget);
    }
    for (const child of node.args ?? [])
        checkExpression(child, declared, depth + 1, budget);
}
function evaluate(node, params) {
    const nodes = node.args ?? [], at = (i) => evaluate(nodes[i], params), number = (i) => numeric(at(i));
    switch (node.op) {
        case 'constant': return node.value === 'true' ? true : node.value === 'false' ? false : node.value;
        case 'variable': {
            if (!Object.hasOwn(params, node.name))
                throw new QuoteError('quote_usage_required', `Provide measured or expected usage for ${node.name} in pricing_parameters.`, node.name);
            return typeof params[node.name] === 'number' ? decimal(params[node.name]) : params[node.name];
        }
        case 'lookup': {
            const key = evaluate(node.key, params), text = typeof key === 'object' ? exact(key) : String(key);
            if (!Object.hasOwn(node.values, text))
                fail('invalid_pricing_expression', 'No published pricing rule matches the selected parameter.');
            return decimal(node.values[text]);
        }
        case 'if': return boolean(at(0)) ? at(1) : at(2);
        case 'and': return nodes.every((_n, i) => boolean(at(i)));
        case 'or': return nodes.some((_n, i) => boolean(at(i)));
        case 'not': return !boolean(at(0));
        case 'eq':
        case 'neq': {
            const a = at(0), b = at(1);
            const equal = typeof a === 'boolean' || typeof b === 'boolean' ? a === b
                : typeof a === 'object' || typeof b === 'object' || /^-?\d+(?:\.\d+)?$/.test(String(a)) && /^-?\d+(?:\.\d+)?$/.test(String(b))
                    ? cmp(numeric(a), numeric(b)) === 0 : a === b;
            return node.op === 'eq' ? equal : !equal;
        }
        case 'lt': return cmp(number(0), number(1)) < 0;
        case 'lte': return cmp(number(0), number(1)) <= 0;
        case 'gt': return cmp(number(0), number(1)) > 0;
        case 'gte': return cmp(number(0), number(1)) >= 0;
        case 'add': return nodes.reduce((sum, _n, i) => add(sum, number(i)), rat(0n));
        case 'multiply': return nodes.reduce((product, _n, i) => mul(product, number(i)), rat(1n));
        case 'subtract': {
            const b = number(1);
            return add(number(0), rat(-b.n, b.d));
        }
        case 'divide': return div(number(0), number(1));
        case 'ceil':
        case 'floor': return rounded(number(0), node.op);
        case 'min':
        case 'max': return nodes.map((_n, i) => number(i)).reduce((a, b) => (cmp(a, b) < 0) === (node.op === 'min') ? a : b);
        case 'clamp': {
            const a = number(0), low = number(1), high = number(2);
            if (cmp(low, high) > 0)
                fail('invalid_pricing_expression', 'The pricing rule has invalid clamp bounds.');
            return cmp(a, low) < 0 ? low : cmp(a, high) > 0 ? high : a;
        }
        default: return fail('invalid_pricing_expression', 'The pricing rule uses an unsupported operation.');
    }
}
export const ApprovedRulesEstimate = z.object({ source: z.literal('pricing_rules'), price_scope: z.literal('public_default'),
    model_id: z.string().min(1).max(100), request_hash: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/), total_uc: z.string().max(32).regex(/^\d+$/),
    expires_at: z.string().datetime({ offset: true }) }).strict();
function economicRules(rule) {
    // Freshness and configuration timestamps do not change the approved price.
    return { ...rule, components: rule.components.map(({ effective_at, official_rate, ...c }) => ({ ...c,
            tiers: c.tiers.map(({ effective_at, official_rate, ...t }) => t) })) };
}
export function calculateRulesEstimate(body, entry, input, options = {}) {
    const rule = 'model' in body ? body.model : body.models.find(model => model.model_id === entry.id);
    if (!rule || rule.model_id !== entry.id.toLowerCase() || rule.modality !== entry.kind || rule.policy_source !== 'published' || rule.pricing_status !== 'available') {
        fail('pricing_rules_unavailable', 'This model has no available published media pricing policy.');
    }
    const params = prepareQuoteParameters(rule, entry, input, options.pricingParameters, options.mediaSeconds, true);
    const declared = new Set((rule.parameters ?? []).map(p => p.name)), ids = new Set();
    const components = [];
    let total = 0n;
    const missing = new Set();
    for (const c of rule.components) {
        if (ids.has(c.id) || !c.quantity_rule || !c.rounding)
            fail('invalid_pricing_expression', 'The pricing rule is incomplete or has duplicate components.');
        ids.add(c.id);
        for (const expr of [c.condition, c.quantity_rule, ...c.tiers.map(t => t.when)])
            if (expr)
                checkExpression(expr, declared);
        if (!['per_quantity', 'per_tier', 'per_component_subtotal'].includes(c.rounding.point)
            || !['half_up', 'ceil', 'floor'].includes(c.rounding.mode))
            fail('invalid_pricing_expression', 'The pricing rule has unsupported rounding.');
        try {
            if (c.condition && !boolean(evaluate(c.condition, params)))
                continue;
            const matches = c.tiers.filter(t => t.when && boolean(evaluate(t.when, params)));
            if (matches.length > 1)
                fail('invalid_pricing_expression', 'Multiple pricing tiers match the request.');
            const selected = matches[0] ?? c;
            if (selected.pricing_status !== 'available')
                fail('pricing_rules_unavailable', 'A required pricing component is unavailable.');
            const q = numeric(evaluate(c.quantity_rule, params)), m = decimal(matches[0]?.multiplier ?? '1'), rate = decimal(selected.rate.uc);
            if (q.n < 0n)
                fail('invalid_pricing_expression', 'The pricing rule produces a negative quantity.');
            // Catalog tier.rate already includes its multiplier. Applying it twice overcharges.
            const billed = mul(q, m);
            const subtotal = c.rounding.point === 'per_quantity' ? mul(rounded(billed, c.rounding.mode), div(rate, m))
                : c.rounding.point === 'per_tier' ? mul(q, rounded(rate, c.rounding.mode))
                    : rounded(mul(q, rate), c.rounding.mode);
            const minimum = decimal(selected.minimum_charge.uc);
            const charge = cmp(subtotal, minimum) < 0 ? minimum : subtotal;
            if (charge.d !== 1n || charge.n < 0n || charge.n > BigInt(Number.MAX_SAFE_INTEGER))
                fail('invalid_pricing_expression', 'The pricing rule does not produce a supported integer UC charge.');
            total += charge.n;
            components.push({ id: c.id, sku_id: selected.sku_id, quantity: exact(q), billed_quantity: exact(billed),
                subtotal_uc: String(charge.n), minimum_charge_applied: cmp(subtotal, minimum) < 0 });
        }
        catch (error) {
            if (error instanceof QuoteError && error.code === 'quote_usage_required' && error.param)
                missing.add(error.param);
            else
                throw error;
        }
    }
    if (total > BigInt(Number.MAX_SAFE_INTEGER))
        fail('invalid_pricing_expression', 'The estimated charge exceeds its supported range.');
    const amounts = amountsForUC(String(total)), requestHash = quoteRequestHash(entry.id, input, options.mediaSeconds, options.pricingParameters);
    const approval = { source: 'pricing_rules', price_scope: 'public_default', model_id: entry.id,
        request_hash: requestHash, total_uc: amounts.uc, expires_at: body.meta.fresh_until,
        fingerprint: quoteRequestHash(entry.id, { rules: economicRules(rule), parameters: params,
            exchange_rate_version: body.meta.exchange_rate_version, components, missing: [...missing].sort(), total_uc: amounts.uc }) };
    const estimate = { status: missing.size ? components.length ? 'partial' : 'needs_input' : 'estimated', min_usd: Number(amounts.usd), max_usd: Number(amounts.usd),
        min_credits: Number(amounts.credits), max_credits: Number(amounts.credits),
        basis: ['Published full pricing rules evaluated for the supplied generation parameters; exact UC rounding and component minimums.'],
        ...(missing.size ? { uncheckable_reason: 'usage' } : {}),
        possible_extras: [...missing].map(name => `Additional charge depends on ${name}; supply expected or measured usage in pricing_parameters.`), notes: ['Public default prices; account discounts are not included.',
            'Confirm the estimated cost before generation. Actual billed usage and final charges may differ.'] };
    return { approval, estimate, amounts, components, parameters: params, rule };
}
export async function createRulesEstimate(entry, input, options = {}) {
    const { body } = await getPricingRules({ model: entry.id.toLowerCase(), view: 'full' }, { fresh: true });
    return calculateRulesEstimate(body, entry, input, options);
}
export function checkRulesApproval(approval, fresh) {
    if (Date.parse(approval.expires_at) <= Date.now())
        fail('quote_expired', 'The approved estimate expired. Estimate again and obtain approval.');
    if (approval.request_hash !== fresh.approval.request_hash || approval.model_id !== fresh.approval.model_id) {
        fail('quote_input_changed', 'The generation input differs from the approved estimate.');
    }
    if (approval.fingerprint !== fresh.approval.fingerprint || approval.total_uc !== fresh.approval.total_uc) {
        fail('price_changed', 'The pricing rules or estimated price changed. Estimate again and obtain approval.');
    }
}
