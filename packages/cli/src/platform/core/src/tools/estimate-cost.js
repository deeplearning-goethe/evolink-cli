// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { getCredits } from '../services/api-client.js';
import { MAX_BATCH_ITEMS, batchTotal } from '../services/batch-generation.js';
import { resolveModel, suggestModels } from '../services/model-catalog.js';
import { formatIssues, validateInput } from '../services/param-validator.js';
import { formatEstimateRange } from '../services/pricing-client.js';
import { PricingRulesError, reusablePricingRules } from '../services/pricing-rules-client.js';
import { QuoteError, QuoteParameters } from '../services/pricing-quote-client.js';
import { calculateRulesEstimate, createRulesEstimate, readPricingRulesFor, recentRulesNote } from '../services/pricing-rules-estimate.js';
import { prepareSeedanceInput } from '../services/seedance-input.js';
import { API_KEYS_URL, MCP_CONSOLE_URL, MCP_KEY_NAME, TOP_UP_URL } from '../services/http-policy.js';
import { trackedLink } from '../services/utm.js';
import { currentCredentialMode } from '../request-context.js';
import { MEDIA_SECONDS_DESCRIPTION, MEDIA_SECONDS_MAX, READ_ONLY, dailyLimitOf, errorResult, failure, money, ok, retryText } from './shared.js';
import { pricingCallLimitReached } from '../services/pricing-call-limit.js';
export function registerEstimateCost(server, config) {
    server.registerTool('estimate_cost', {
        title: 'Estimate cost',
        description: [
            'Check a generation input and estimate what it will cost, without submitting anything. Free.',
            'Returns whether the input is valid, the expected price range in USD and credits, what it is based on, and whether the account balance and any spending limit (the EvoLink MCP limit, or this API key\'s) cover it.',
            'Call it before a paid generate_* call, then use the generation confirmation template in the server instructions.',
            `For several tasks of one model, pass inputs (up to ${MAX_BATCH_ITEMS}): one total and one pricing_quote approve the whole batch.`,
        ].join(' '),
        inputSchema: {
            model: z.string().min(1).max(128).describe('Model ID, e.g. "seedance-2.0-text-to-video".'),
            input: z.record(z.string(), z.unknown()).optional()
                .describe('The input you plan to pass to the generate tool, e.g. {"prompt":"…","duration":5,"quality":"1080p"}.'),
            // The leading max() lets zod stop at an oversized array instead of checking every element.
            inputs: z.array(z.record(z.string(), z.unknown())).max(MAX_BATCH_ITEMS).min(1).optional()
                .describe(`Several inputs for this model (1–${MAX_BATCH_ITEMS}), each as you will pass it in the generate tool's inputs, in the same order. Returns each input's estimate, the total and one pricing_quote that approves the whole batch. media_seconds and pricing_parameters apply to every input. Pass input or inputs, not both.`),
            pricing_source: z.enum(['pricing_rules', 'account', 'public_reference']).default('pricing_rules').describe('Use published full pricing rules for public default estimates. The old account/public_reference values are compatibility aliases; neither requests a backend account quote.'),
            pricing_parameters: QuoteParameters.optional().describe('Measured or explicitly expected usage declared by the pricing policy, such as input_seconds or search_count. Missing enabled-search counts produce a zero-search partial subtotal and per-search rates. GPT Image token models do not use token counts here: their reference price comes from the input. Do not invent counts, include user_group/prices/prompts, or treat expected counts as execution limits.'),
            media_seconds: z.number().positive().max(MEDIA_SECONDS_MAX).optional().describe(MEDIA_SECONDS_DESCRIPTION),
        },
        annotations: { title: 'Estimate cost', ...READ_ONLY },
    }, async ({ model, input, inputs, media_seconds: mediaSeconds, pricing_source: pricingSource, pricing_parameters: pricingParameters }) => {
        try {
            if (inputs !== undefined && input !== undefined)
                return failure('Pass input for one generation or inputs for a batch, not both. No estimate was created.', {
                    error: { category: 'invalid_request', param: 'inputs' }, charged: 'no', batch: { items: inputs.length }
                });
            const { catalog, entry } = await resolveModel(model, config, { fresh: true, allowStale: false, skipPricing: true });
            if (!entry) {
                const suggestions = suggestModels(catalog, model);
                return failure(`Unknown model "${model}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''} Use search_models to find model IDs.`, { error: { category: 'not_found', param: 'model' }, suggestions });
            }
            if (inputs !== undefined)
                return await estimateBatch(config, entry, inputs, { mediaSeconds, pricingParameters, pricingSource });
            const prepared = prepareSeedanceInput(entry, input ?? {});
            const values = prepared.input;
            const validation = entry.spec ? validateInput(entry.spec, values) : undefined;
            validation?.errors.push(...prepared.errors);
            validation?.warnings.push(...prepared.warnings);
            if (validation?.errors.length)
                return failure('The generation input is invalid; no estimate was created.', { input_valid: false, problems: validation.errors, error: { category: 'invalid_request' }, charged: 'no' });
            const over = estimateLimitReached(config, entry);
            if (over)
                return limitFailure(over, pricingSource);
            const rulesEstimate = await createRulesEstimate(entry, values, { mediaSeconds, pricingParameters, reuseRules: config.reusePricingRules === true });
            const estimate = rulesEstimate.estimate;
            const lines = [`Estimate for ${entry.id} (${entry.kind}); nothing was submitted or charged.`];
            if (!validation) {
                lines.push('Input not checked: this model\'s parameters are not documented here.');
            }
            else if (validation.errors.length > 0) {
                lines.push(`Input problems (generate_${entry.kind} would refuse this input):`, ...formatIssues(validation.errors));
            }
            else {
                lines.push('Input looks valid.');
            }
            if (validation?.warnings.length)
                lines.push('Warnings:', ...formatIssues(validation.warnings));
            for (const applied of prepared.defaults)
                lines.push(`Applied default: ${applied.param}=${applied.value} (${applied.reason}); this effective value is used for pricing and submission.`);
            const range = formatEstimateRange(estimate);
            if (estimate.status === 'estimated' && range)
                lines.push(`Estimated cost: ${range}`);
            else if (estimate.status === 'partial' && range)
                lines.push(`Partial estimate at published rates: ${range} (not a total or an upper bound).`);
            else if (estimate.status === 'token_billed' && range)
                lines.push(`Reference price: ${range}. Billed by actual token usage and settled when the task finishes, so the final charge may be lower or slightly higher.`);
            else if (estimate.status === 'token_billed')
                lines.push('Cost: billed by tokens used; it is only known after the task runs.');
            else if (estimate.status === 'needs_input')
                lines.push('Cost: cannot estimate yet. The total depends on usage this request does not give:', ...(estimate.usage_help ?? []).map(line => `- ${line}`));
            else if (estimate.uncheckable_reason === 'output_duration')
                lines.push('Cost: the output duration is unknown, so there is no total or upper bound to quote.');
            else
                lines.push('Cost: pricing data is unavailable in this catalog.');
            if (estimate.basis.length)
                lines.push('Based on:', ...estimate.basis.map(line => `- ${line}`));
            if (estimate.possible_extras.length)
                lines.push('May also charge:', ...estimate.possible_extras.map(line => `- ${line}`));
            for (const note of estimate.notes)
                lines.push(`Note: ${note}`);
            // Without any priced component there is no total to show or approve: no amounts and no approval record.
            const priced = estimate.status !== 'needs_input';
            const structured = {
                model: entry.id,
                type: entry.kind,
                pricing_scope: 'public_default',
                pricing_source: 'pricing_rules',
                ...(priced ? { pricing_quote: rulesEstimate.approval, amounts: rulesEstimate.amounts } : { submission_allowed: false }),
                total_known: estimate.total_known === true,
                ...(estimate.missing_usage ? { missing_usage: estimate.missing_usage } : {}),
                components: rulesEstimate.components,
                pricing_parameters: rulesEstimate.parameters,
                policy_version: rulesEstimate.rule.policy_version,
                policy_checksum: rulesEstimate.rule.policy_checksum,
                settlement_basis: rulesEstimate.rule.settlement_basis,
                ...(priced ? { expires_at: rulesEstimate.approval.expires_at } : {}),
                ...('rules_read_at' in rulesEstimate ? { rules_read_at: rulesEstimate.rules_read_at } : {}),
                final_budget_enforced: false,
                input_valid: validation ? validation.errors.length === 0 : null,
                problems: validation?.errors ?? [],
                warnings: validation?.warnings ?? [],
                estimate,
                ...(estimate.search_charges?.length ? { search_charges: estimate.search_charges,
                    amount_scope: estimate.status === 'partial' ? 'known_components_subtotal' : estimate.status === 'estimated' ? 'expected_usage_estimate' : 'not_established' } : {}),
                ...(prepared.applies ? { effective_input: values, defaults_applied: prepared.defaults,
                    amount_scope: estimate.status === 'partial' ? 'known_components_subtotal' : estimate.status === 'estimated' ? 'expected_usage_estimate' : 'not_established' } : {}),
            };
            await addBalance(config, estimate, lines, structured);
            if (priced)
                lines.push(`Estimate valid until ${rulesEstimate.approval.expires_at}.`, estimate.status === 'token_billed'
                    ? 'Public default reference price; account discounts are not included. Confirm it before generation. The final charge follows actual token usage.'
                    : 'Public default estimate; account discounts are not included. Confirm this estimated cost before generation. Final charges depend on actual usage.');
            else
                lines.push('No total or approval record was issued. Estimate again with the missing usage before asking the user to approve a generation.');
            return ok(lines.join('\n'), structured);
        }
        catch (error) {
            if (error instanceof PricingRulesError)
                return failure(error.code === 'rate_limit_exceeded'
                    ? `The platform is limiting pricing requests right now, so no estimate was created. Try again in ${retryText(error.retryAfter)}. Nothing was submitted or charged.`
                    : 'The model pricing rules could not be verified. No estimate or generation was created.', {
                    error: { category: 'estimate_unavailable', code: error.code, status: error.status, ...(error.retryAfter !== undefined ? { retry_after_seconds: error.retryAfter } : {}) }, pricing_source: pricingSource,
                    submission_allowed: false, final_budget_enforced: false, charged: 'no', ...(inputs ? { batch: { items: inputs.length } } : {})
                });
            if (error instanceof QuoteError)
                return failure(`${error.message} Nothing was submitted or charged.`, {
                    error: { category: 'estimate_unavailable', code: error.code, ...(error.param ? { param: error.param } : {}) },
                    pricing_source: pricingSource, submission_allowed: false, final_budget_enforced: false, charged: 'no', ...(inputs ? { batch: { items: inputs.length } } : {})
                });
            const failed = errorResult(error);
            return { ...failed, structuredContent: { ...failed.structuredContent, pricing_source: pricingSource,
                    submission_allowed: false, final_budget_enforced: false, charged: 'no' } };
        }
    });
}
/** Only an estimate that reads the platform's rules counts; one answered from rules read moments ago does not. */
function estimateLimitReached(config, entry) {
    const reused = config.reusePricingRules === true && reusablePricingRules({ model: entry.id.toLowerCase(), view: 'full' });
    const over = reused ? undefined : pricingCallLimitReached('estimate_cost');
    return over;
}
function limitFailure(over, pricingSource) {
    return failure(`This account already made ${over.limit} estimate_cost calls that read the pricing rules in the last minute, the most allowed. Wait ${retryText(over.retryAfterSeconds)}, then estimate again. Nothing was submitted or charged.`, {
        error: { category: 'rate_limited', code: 'pricing_calls_per_minute', retry_after_seconds: over.retryAfterSeconds },
        pricing_source: pricingSource, submission_allowed: false, final_budget_enforced: false, charged: 'no'
    });
}
/** Whether the balance and the spending limits cover the estimate; a reference price is what the gateway reserves at submission. */
async function addBalance(config, estimate, lines, structured) {
    const checkable = (estimate.status === 'estimated' || estimate.status === 'token_billed') && estimate.max_credits !== undefined;
    try {
        const credits = await getCredits(config, 'estimate_cost');
        const balance = Math.max(0, credits.user.remaining_credits);
        lines.push(`Account balance: ${money(balance)}`);
        structured.balance_credits = balance;
        if (checkable && estimate.max_credits !== undefined) {
            const enough = balance >= estimate.max_credits;
            structured.enough_balance = enough;
            if (!enough)
                lines.push(`The account balance may not cover this; top up at ${trackedLink(TOP_UP_URL, 'top_up')}.`);
        }
        // The key's own limit is checked before the balance: warn now instead of failing on submit.
        if (!credits.token.unlimited_credits) {
            const signedIn = currentCredentialMode() === 'signed_in';
            const left = Math.max(0, credits.token.remaining_credits);
            lines.push(signedIn
                ? `EvoLink MCP limit left: ${money(left)} (shared by all connected assistants).`
                : `This API key's limit left: ${money(left)}.`);
            structured.limit_scope = signedIn ? 'mcp' : 'api_key';
            structured.limit_remaining_credits = left;
            if (checkable && estimate.max_credits !== undefined) {
                const enoughLimit = left >= estimate.max_credits;
                structured.enough_limit = enoughLimit;
                if (!enoughLimit) {
                    lines.push(signedIn
                        ? `The EvoLink MCP limit may not cover this. It is a limit the user set, not the account balance; they can raise it at ${trackedLink(MCP_CONSOLE_URL, 'api_keys')} (the key named "${MCP_KEY_NAME}").`
                        : `This API key's limit may not cover this; raise it at ${trackedLink(API_KEYS_URL, 'api_keys')} or use another key.`);
                }
            }
        }
        const daily = dailyLimitOf(credits.token);
        if (daily && checkable && estimate.max_credits !== undefined) {
            const signedIn = currentCredentialMode() === 'signed_in';
            const enoughToday = daily.left >= estimate.max_credits;
            structured.daily_left_credits = daily.left;
            structured.enough_daily_limit = enoughToday;
            if (!enoughToday) {
                const resets = `it resets at midnight${daily.zone ? ` (${daily.zone})` : ''}`;
                lines.push(signedIn
                    ? `Today's EvoLink MCP limit may not cover this (${money(daily.left)} left today; ${resets}). It is a limit the user set, not the account balance.`
                    : `Today's limit of this API key may not cover this (${money(daily.left)} left today; ${resets}).`);
            }
        }
    }
    catch {
        lines.push('Balance: could not be read right now.');
    }
}
const itemsText = (indexes) => indexes.map(index => `inputs[${index}]`).join(', ');
/** One input's price, for the per-input list of a batch. */
function itemPrice(estimate) {
    const range = formatEstimateRange(estimate);
    if (estimate.status === 'needs_input' || !range)
        return `no total yet (depends on ${(estimate.missing_usage ?? []).join(', ') || 'usage measured when it runs'})`;
    return estimate.status === 'partial' ? `${range} partial` : estimate.status === 'token_billed' ? `${range} reference price` : range;
}
/**
 * Several inputs for one model, estimated from one read of its rules and counted once against the account: each
 * input's price, the total, and one approval record for the whole batch, in input order.
 */
async function estimateBatch(config, entry, inputs, options) {
    const batch = { items: inputs.length };
    const prepared = inputs.map(item => prepareSeedanceInput(entry, item));
    const checks = prepared.map(item => {
        if (!entry.spec)
            return undefined;
        const check = validateInput(entry.spec, item.input);
        check.errors.push(...item.errors);
        check.warnings.push(...item.warnings);
        return check;
    });
    const located = (index, issues) => issues.map(issue => ({ ...issue, param: `inputs[${index}].${issue.param}` }));
    const problems = checks.flatMap((check, index) => located(index, check?.errors ?? []));
    if (problems.length)
        return failure(['Some inputs are invalid; no estimate was created:', ...formatIssues(problems)].join('\n'), {
            input_valid: false, problems, error: { category: 'invalid_request' }, charged: 'no', batch
        });
    const over = estimateLimitReached(config, entry);
    if (over)
        return limitFailure(over, options.pricingSource);
    const reuse = config.reusePricingRules === true;
    const { body, readAt } = await readPricingRulesFor(entry, { reuseRules: reuse });
    const results = prepared.map((item, index) => {
        try {
            return calculateRulesEstimate(body, entry, item.input, { mediaSeconds: options.mediaSeconds, pricingParameters: options.pricingParameters });
        }
        catch (error) {
            throw error instanceof QuoteError ? new QuoteError(error.code, `inputs[${index}]: ${error.message}`, error.param) : error;
        }
    });
    const total = batchTotal(entry.id, results), combined = total.estimate, status = total.status;
    if (readAt)
        combined.notes.push(recentRulesNote(readAt));
    const count = inputs.length;
    const lines = [`Estimate for ${count} input${count === 1 ? '' : 's'} of ${entry.id} (${entry.kind}); nothing was submitted or charged.`];
    lines.push(entry.spec ? 'Inputs look valid.' : 'Inputs not checked: this model\'s parameters are not documented here.');
    const warnings = checks.flatMap((check, index) => located(index, check?.warnings ?? []));
    if (warnings.length)
        lines.push('Warnings:', ...formatIssues(warnings));
    prepared.forEach((item, index) => {
        for (const applied of item.defaults)
            lines.push(`Applied default: inputs[${index}].${applied.param}=${applied.value} (${applied.reason}); this effective value is used for pricing and submission.`);
    });
    const prices = results.map(result => itemPrice(result.estimate));
    const same = prices.every(price => price === prices[0]);
    const each = same && count > 1 ? `; ${prices[0]} each` : '';
    const range = formatEstimateRange(combined);
    if (status === 'estimated' && range)
        lines.push(`Estimated cost: ${range} in total for ${count} input${count === 1 ? '' : 's'}${each}.`);
    else if (status === 'partial' && range)
        lines.push(`Partial estimate at published rates: ${range} in total (not a total or an upper bound; partial for ${itemsText(total.partial)}).`);
    else if (status === 'token_billed' && range)
        lines.push(`Reference price: ${range} in total for ${count} input${count === 1 ? '' : 's'}${each}. Billed by actual token usage and settled when each task finishes, so the final charge may be lower or slightly higher.`);
    else if (status === 'needs_input')
        lines.push(`Cost: cannot estimate yet. ${itemsText(total.needsInput)} depend${total.needsInput.length === 1 ? 's' : ''} on usage this request does not give:`, ...(combined.usage_help ?? []).map(line => `- ${line}`));
    if (!same)
        lines.push('Per input:', ...prices.map((price, index) => `- inputs[${index}]: ${price}`));
    if (combined.basis.length)
        lines.push('Based on:', ...combined.basis.map(line => `- ${line}`));
    if (combined.possible_extras.length)
        lines.push('May also charge:', ...combined.possible_extras.map(line => `- ${line}`));
    for (const note of combined.notes)
        lines.push(`Note: ${note}`);
    // Without a total for every input there is nothing to approve: no amounts and no approval record.
    const quoted = status !== 'needs_input';
    const rule = results[0].rule;
    const structured = {
        model: entry.id,
        type: entry.kind,
        batch,
        pricing_scope: 'public_default',
        pricing_source: 'pricing_rules',
        ...(quoted ? { pricing_quote: total.approval, amounts: total.amounts } : { submission_allowed: false }),
        total_known: status === 'estimated',
        ...(combined.missing_usage ? { missing_usage: combined.missing_usage } : {}),
        items: results.map((result, index) => ({ index, status: result.estimate.status, total_known: result.estimate.total_known === true,
            ...(result.estimate.status === 'needs_input' ? {} : { amounts: result.amounts }),
            ...(result.estimate.missing_usage ? { missing_usage: result.estimate.missing_usage } : {}),
            ...(result.estimate.search_charges?.length ? { search_charges: result.estimate.search_charges } : {}),
            ...(prepared[index].applies ? { effective_input: prepared[index].input, defaults_applied: prepared[index].defaults } : {}) })),
        policy_version: rule.policy_version,
        policy_checksum: rule.policy_checksum,
        settlement_basis: rule.settlement_basis,
        ...(quoted ? { expires_at: total.approval.expires_at } : {}),
        ...(readAt ? { rules_read_at: readAt } : {}),
        final_budget_enforced: false,
        input_valid: entry.spec ? true : null,
        problems: [],
        warnings,
        estimate: combined,
    };
    await addBalance(config, combined, lines, structured);
    if (quoted)
        lines.push(`Estimate valid until ${total.approval.expires_at}.`, status === 'token_billed'
            ? `Public default reference price; account discounts are not included. Confirm it for the whole batch before generation. The final charge follows actual token usage.`
            : `Public default estimate; account discounts are not included. Confirm this estimated cost for the whole batch before generation. Final charges depend on actual usage.`, `One approval covers all ${count} input${count === 1 ? '' : 's'}: pass this pricing_quote with the same inputs, in the same order, to generate_${entry.kind}.`);
    else
        lines.push('No total or approval record was issued. Estimate again with the missing usage before asking the user to approve a generation.');
    return ok(lines.join('\n'), structured);
}
