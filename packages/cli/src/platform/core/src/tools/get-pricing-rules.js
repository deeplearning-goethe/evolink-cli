// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { currentRequestCredentials } from '../request-context.js';
import { RequestTimeoutError } from '../services/http-policy.js';
import { getPricingRules, PricingRulesError, PricingRulesQuery } from '../services/pricing-rules-client.js';
import { failure, ok, READ_ONLY } from './shared.js';
export function registerPricingRules(server) {
    server.registerTool('get_pricing_rules', {
        title: 'Read public pricing rules',
        description: 'Read schema-2 public default pricing rules, decimal-string rates including fractional UC, minimum charges, tiers and optional full expressions. Free and anonymous upstream. The returned price_selection identifies route-priority prices or legacy minimum configuration prices. Published production coverage is currently text-only. These are public reference rates, not account prices, live availability, a task quote, a bill or a final spending cap. Do not substitute these rules for media estimate_cost or assume empty media results are free.',
        inputSchema: PricingRulesQuery.shape,
        annotations: { title: 'Read public pricing rules', ...READ_ONLY },
    }, async (input) => {
        try {
            const { body, source } = await getPricingRules(input);
            const models = 'model' in body ? [body.model] : body.models;
            const selection = body.meta.price_selection ?? 'configured_minimum';
            const warnings = [
                selection === 'route_priority'
                    ? 'Public reference rates use enabled routes by priority, with the existing web-price fallback when every route is unavailable. Failover can change the actual routed price.'
                    : 'Legacy public rates use the lowest configured price, which can include an unavailable route and differ from the web-price reference.',
                'Public default configuration prices may differ from routed settlement, account-group prices, discounts and promotions.',
                'No task quote or final spending cap was established. Do not multiply unit rates into a bill; minimum charges, tiers and rounding apply.',
                'Current published coverage is text-only. Empty image, video or audio results mean rules are not published, not zero cost.',
            ];
            const lines = [`Public pricing rules (${body.meta.price_scope}; ${selection}; ${source}); ${models.length} model(s).`, ...warnings];
            for (const model of models) {
                lines.push(`${model.model_id} (${model.modality}; ${model.pricing_status}; ${model.policy_source} v${model.policy_version})`);
                for (const component of model.components)
                    lines.push(`- ${component.role}: ${component.rate.usd} USD (${component.rate.credits} credits) per ${component.billing_unit_size} ${component.unit === '1k_tokens' ? 'tokens' : component.unit}; minimum ${component.minimum_charge.usd} USD; ${component.tiers.length} tier(s); ${component.pricing_status}.`);
            }
            return ok(lines.join('\n'), { ...body, pricing_source: source,
                pricing_endpoint: '/v1/catalog/pricing-rules', quote_established: false, final_budget_enforced: false,
                account_price: false, warnings });
        }
        catch (error) {
            // This operation never reads account credentials. A transport failure or
            // cancellation must not ask the user to sign in or expose exception text.
            const safeError = error instanceof PricingRulesError ? error : new PricingRulesError(currentRequestCredentials()?.http?.signal?.aborted ? 'interrupted'
                : error instanceof RequestTimeoutError ? 'pricing_rules_timeout'
                    : error instanceof TypeError ? 'pricing_rules_network_error' : 'pricing_rules_unavailable');
            return failure(safeError.status === 404
                ? 'No public pricing rules are published for this model and filters. This does not mean the model is free or unavailable.'
                : safeError.code === 'interrupted' ? 'Public pricing rules lookup was interrupted. No quote or spending limit was established.'
                    : safeError.message, { error: { category: safeError.code === 'interrupted' ? 'interrupted'
                        : safeError.status === 404 ? 'not_found' : safeError.status === 429 ? 'rate_limit' : 'server_error',
                    code: safeError.code, status: safeError.status,
                    retryable: safeError.status === 429 || safeError.status >= 500
                        || ['pricing_rules_timeout', 'pricing_rules_network_error'].includes(safeError.code),
                    ...(safeError.retryAfter !== undefined ? { retry_after: safeError.retryAfter } : {}) }, charged: 'no',
                quote_established: false, final_budget_enforced: false });
        }
    });
}
