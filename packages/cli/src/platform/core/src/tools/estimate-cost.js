// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { getCredits } from '../services/api-client.js';
import { resolveModel, suggestModels } from '../services/model-catalog.js';
import { formatIssues, validateInput } from '../services/param-validator.js';
import { formatEstimateRange } from '../services/pricing-client.js';
import { PricingRulesError } from '../services/pricing-rules-client.js';
import { QuoteError, QuoteParameters } from '../services/pricing-quote-client.js';
import { createRulesEstimate } from '../services/pricing-rules-estimate.js';
import { API_KEYS_URL, MCP_CONSOLE_URL, MCP_KEY_NAME, TOP_UP_URL } from '../services/http-policy.js';
import { trackedLink } from '../services/utm.js';
import { currentCredentialMode } from '../request-context.js';
import { MEDIA_SECONDS_DESCRIPTION, MEDIA_SECONDS_MAX, READ_ONLY, dailyLimitOf, errorResult, failure, money, ok } from './shared.js';
export function registerEstimateCost(server, config) {
    server.registerTool('estimate_cost', {
        title: 'Estimate cost',
        description: [
            'Check a generation input and estimate what it will cost, without submitting anything. Free.',
            'Returns whether the input is valid, the expected price range in USD and credits, what it is based on, and whether the account balance and any spending limit (the EvoLink MCP limit, or this API key\'s) cover it.',
            'Call it before a paid generate_* call, then use the generation confirmation template in the server instructions.',
        ].join(' '),
        inputSchema: {
            model: z.string().min(1).max(128).describe('Model ID, e.g. "seedance-2.0-text-to-video".'),
            input: z.record(z.unknown()).optional()
                .describe('The input you plan to pass to the generate tool, e.g. {"prompt":"…","duration":5,"quality":"1080p"}.'),
            pricing_source: z.enum(['pricing_rules', 'account', 'public_reference']).default('pricing_rules').describe('Use published full pricing rules for public default estimates. The old account/public_reference values are compatibility aliases; neither requests a backend account quote.'),
            pricing_parameters: QuoteParameters.optional().describe('Measured or expected billing usage declared by the pricing policy, such as input_seconds. Do not include user_group, prices or generation prompts.'),
            media_seconds: z.number().positive().max(MEDIA_SECONDS_MAX).optional().describe(MEDIA_SECONDS_DESCRIPTION),
        },
        annotations: { title: 'Estimate cost', ...READ_ONLY },
    }, async ({ model, input, media_seconds: mediaSeconds, pricing_source: pricingSource, pricing_parameters: pricingParameters }) => {
        try {
            const { catalog, entry } = await resolveModel(model, config, { fresh: true, allowStale: false, skipPricing: true });
            if (!entry) {
                const suggestions = suggestModels(catalog, model);
                return failure(`Unknown model "${model}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''} Use search_models to find model IDs.`, { error: { category: 'not_found', param: 'model' }, suggestions });
            }
            const values = input ?? {};
            const validation = entry.spec ? validateInput(entry.spec, values) : undefined;
            if (validation?.errors.length)
                return failure('The generation input is invalid; no estimate was created.', { input_valid: false, problems: validation.errors, error: { category: 'invalid_request' }, charged: 'no' });
            const rulesEstimate = await createRulesEstimate(entry, values, { mediaSeconds, pricingParameters });
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
            const range = formatEstimateRange(estimate);
            if (estimate.status === 'estimated' && range)
                lines.push(`Estimated cost: ${range}`);
            else if (estimate.status === 'partial' && range)
                lines.push(`Partial estimate at published rates: ${range} (not a total or an upper bound).`);
            else if (estimate.status === 'token_billed')
                lines.push('Cost: billed by tokens used; it is only known after the task runs.');
            else if (estimate.status === 'needs_input')
                lines.push('Cost: cannot estimate yet; see the note below.');
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
            const structured = {
                model: entry.id,
                type: entry.kind,
                pricing_scope: 'public_default',
                pricing_source: 'pricing_rules',
                pricing_quote: rulesEstimate.approval,
                amounts: rulesEstimate.amounts,
                components: rulesEstimate.components,
                pricing_parameters: rulesEstimate.parameters,
                policy_version: rulesEstimate.rule.policy_version,
                policy_checksum: rulesEstimate.rule.policy_checksum,
                settlement_basis: rulesEstimate.rule.settlement_basis,
                expires_at: rulesEstimate.approval.expires_at,
                final_budget_enforced: false,
                input_valid: validation ? validation.errors.length === 0 : null,
                problems: validation?.errors ?? [],
                warnings: validation?.warnings ?? [],
                estimate,
            };
            try {
                const credits = await getCredits(config, 'estimate_cost');
                const balance = Math.max(0, credits.user.remaining_credits);
                lines.push(`Account balance: ${money(balance)}`);
                structured.balance_credits = balance;
                if (estimate.status === 'estimated' && estimate.max_credits !== undefined) {
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
                    if (estimate.status === 'estimated' && estimate.max_credits !== undefined) {
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
                if (daily && estimate.status === 'estimated' && estimate.max_credits !== undefined) {
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
            lines.push(`Estimate valid until ${rulesEstimate.approval.expires_at}.`, 'Public default estimate; account discounts are not included. Confirm this estimated cost before generation. Final charges depend on actual usage.');
            return ok(lines.join('\n'), structured);
        }
        catch (error) {
            if (error instanceof PricingRulesError)
                return failure('The model pricing rules could not be verified. No estimate or generation was created.', {
                    error: { category: 'estimate_unavailable', code: error.code, status: error.status }, pricing_source: pricingSource,
                    submission_allowed: false, final_budget_enforced: false, charged: 'no'
                });
            if (error instanceof QuoteError)
                return failure(`${error.message} Nothing was submitted or charged.`, {
                    error: { category: 'estimate_unavailable', code: error.code, ...(error.param ? { param: error.param } : {}) },
                    pricing_source: pricingSource, submission_allowed: false, final_budget_enforced: false, charged: 'no'
                });
            const failed = errorResult(error);
            return { ...failed, structuredContent: { ...failed.structuredContent, pricing_source: pricingSource,
                    submission_allowed: false, final_budget_enforced: false, charged: 'no' } };
        }
    });
}
