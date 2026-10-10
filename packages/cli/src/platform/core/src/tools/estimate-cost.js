// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { getCredits } from '../services/api-client.js';
import { resolveModel, suggestModels } from '../services/model-catalog.js';
import { formatIssues, validateInput } from '../services/param-validator.js';
import { estimateCost, formatEstimateRange } from '../services/pricing-client.js';
import { PricingRulesError } from '../services/pricing-rules-client.js';
import { createAccountQuote, QuoteError, QuoteParameters } from '../services/pricing-quote-client.js';
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
            pricing_source: z.enum(['account', 'public_reference']).default('account').describe('Account uses authenticated backend Quote. Public reference only previews default prices and cannot be saved as an account quote.'),
            pricing_parameters: QuoteParameters.optional().describe('Measured or expected billing usage declared by the pricing policy, such as input_seconds. Do not include user_group, prices or generation prompts.'),
            media_seconds: z.number().positive().max(MEDIA_SECONDS_MAX).optional().describe(MEDIA_SECONDS_DESCRIPTION),
        },
        annotations: { title: 'Estimate cost', ...READ_ONLY },
    }, async ({ model, input, media_seconds: mediaSeconds, pricing_source: pricingSource, pricing_parameters: pricingParameters }) => {
        try {
            const { catalog, entry } = await resolveModel(model, config, { fresh: true, allowStale: false, skipPricing: pricingSource === 'account' });
            if (!entry) {
                const suggestions = suggestModels(catalog, model);
                return failure(`Unknown model "${model}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''} Use search_models to find model IDs.`, { error: { category: 'not_found', param: 'model' }, suggestions });
            }
            const values = input ?? {};
            const validation = entry.spec ? validateInput(entry.spec, values) : undefined;
            if (pricingSource === 'account' && validation?.errors.length)
                return failure('The generation input is invalid; no account quote was requested.', { input_valid: false, problems: validation.errors, error: { category: 'invalid_request' }, charged: 'no' });
            const account = pricingSource === 'account' ? await createAccountQuote(config, entry, values, { mediaSeconds, pricingParameters }) : undefined;
            const estimate = account?.estimate ?? estimateCost(entry.priced, entry.kind, values, entry.spec, { mediaSeconds });
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
                pricing_scope: account ? 'account' : 'public_default_group',
                pricing_source: account ? 'account' : 'public_reference',
                ...(account ? { account_quote: account.approval, estimate_id: account.quote.estimate_id,
                    pricing_parameters: account.approval.parameters, expires_at: account.quote.expires_at } : {}),
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
            if (catalog.pricingWarning && !account) {
                lines.push(`Note: ${catalog.pricingWarning}`);
                structured.pricing_warning = catalog.pricingWarning;
            }
            if (account)
                lines.push(`Estimate valid until ${account.quote.expires_at}.`, 'Confirm this estimated cost before generation. The task reports the final charge when it finishes.');
            else
                lines.push('Public reference estimate only. It is not an account quote or a final spending cap.');
            return ok(lines.join('\n'), structured);
        }
        catch (error) {
            if (error instanceof PricingRulesError)
                return failure('The model pricing rules could not be verified. No account quote or generation was created.', {
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
