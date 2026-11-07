// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { submitTask } from '../services/api-client.js';
import { BATCH_REQUEST_ID_MAX, BATCH_SUBMIT_CONCURRENCY, MAX_BATCH_ITEMS, batchTotal, checkBatchApproval, keptRefusal, keyConflict, refusedBeforeRunning, submitBatch } from '../services/batch-generation.js';
import { resolveModel, suggestModels } from '../services/model-catalog.js';
import { formatIssues, validateInput } from '../services/param-validator.js';
import { formatEstimateRange } from '../services/pricing-client.js';
import { ApprovedAccountQuote, QuoteParameters, QuoteError } from '../services/pricing-quote-client.js';
import { ApprovedRulesEstimate, REFERENCE_BUDGET_FACTOR, amountsForUC, calculateRulesEstimate, createRulesEstimate, checkRulesApproval, readPricingRulesFor, referenceAllowance, referenceBudgetExceeded, rulesBudgetExceeded } from '../services/pricing-rules-estimate.js';
import { PricingRulesError } from '../services/pricing-rules-client.js';
import { CLIENT_REQUEST_ID_PATTERN, monotonicNow, newRunId, remainingMs } from '../services/http-policy.js';
import { formatUsd } from '../services/error-handler.js';
import { DASHBOARD_CHECK_GUIDANCE, MEDIA_SECONDS_DESCRIPTION, MEDIA_SECONDS_MAX, PAID, dashboardCheck, errorResult, failure, money, ok, progressReporter, retryText, usdOf } from './shared.js';
import { RESULT_DELIVERY_GUIDANCE, TERMINAL_STATUSES, describeTask, waitForTask } from './task-format.js';
import { PAID_GENERATION_GUIDANCE } from '../tool-guidance.js';
import { currentRequestCredentials } from '../request-context.js';
import { prepareSeedanceInput } from '../services/seedance-input.js';
const PATHS = {
    image: '/v1/images/generations',
    video: '/v1/videos/generations',
    audio: '/v1/audios/generations',
};
/** Images usually finish in seconds, so the tool waits for them; video and audio return the task at once. */
const WAIT_MS = { image: 40_000, video: 0, audio: 0 };
/** The longest post-submit wait wait_seconds may ask for, so the call stays within clients' tool-call limits. */
const MAX_WAIT_SECONDS = 40;
const DESCRIPTIONS = {
    image: 'Generate or edit images with an EvoLink image model. PAID: charges the user\'s EvoLink balance.',
    video: 'Generate a video with an EvoLink video model (text-to-video, image-to-video, reference, edit, extend). PAID: charges the user\'s EvoLink balance.',
    audio: 'Generate music, songs or speech with an EvoLink audio model. PAID: charges the user\'s EvoLink balance.',
};
const AFTER = {
    image: 'Waits up to 40 s (wait_seconds) and returns the image links when ready; otherwise returns the task_id for get_task.',
    video: 'Returns a task_id at once (videos take minutes) unless wait_seconds is set; then call get_task (each call waits up to 45 s).',
    audio: 'Returns a task_id at once unless wait_seconds is set; then call get_task (each call waits up to 45 s).',
};
function description(kind) {
    return [
        DESCRIPTIONS[kind],
        PAID_GENERATION_GUIDANCE,
        'Find models with search_models and their parameters with get_model; pass the parameters in input.',
        AFTER[kind],
        'Never call this again to check progress or to "retry" a running task: each call creates and charges a new task.',
        'After a network error or timeout, reuse the same client_request_id to retry without being charged twice.',
        RESULT_DELIVERY_GUIDANCE,
    ].join(' ');
}
/** Longest prompt accepted through the prompt shortcut. */
const PROMPT_SHORTCUT_MAX = 20_000;
function inputSchema(kind) {
    return {
        model: z.string().min(1).max(128).describe(`${kind[0].toUpperCase()}${kind.slice(1)} model ID from search_models.`),
        // The cap is checked in the handler: a schema limit makes the SDK answer with a bare validation error.
        prompt: z.string().optional().describe(`Shortcut for input.prompt; up to ${PROMPT_SHORTCUT_MAX.toLocaleString('en-US')} characters (get_model lists the model's own limit).`),
        input: z.record(z.string(), z.unknown()).optional()
            .describe('Model parameters exactly as listed by get_model, e.g. {"prompt":"…","quality":"1080p"}. Do not put model or callback_url here.'),
        // The leading max() lets zod stop at an oversized array instead of checking every element.
        inputs: z.array(z.record(z.string(), z.unknown())).max(MAX_BATCH_ITEMS).min(1).optional()
            .describe(`Several tasks of this model at once (1–${MAX_BATCH_ITEMS}), each item like input. One pricing_quote from estimate_cost with the same inputs, in the same order, approves the whole batch; every item is submitted right away (up to ${BATCH_SUBMIT_CONCURRENCY} at a time) and the result lists each item's task_id or error. Collect the results with list_tasks (task_ids). To finish a batch, call again with the same client_request_id and exactly the same inputs within 24 hours: the items the result lists to finish (not submitted, or refused and since fixed) are then submitted, and accepted items return their original tasks without a new charge. Never resubmit accepted, not-submitted or unknown-outcome items under a new client_request_id: that creates and charges new tasks. media_seconds and pricing_parameters apply to every item. Pass input or inputs, not both.`),
        client_request_id: z.string().regex(CLIENT_REQUEST_ID_PATTERN).optional()
            .describe(`Optional idempotency key (16–96 characters: letters, digits, . _ -; with inputs at most ${BATCH_REQUEST_ID_MAX}, since each item adds .NN). Reuse the same value only to retry the same request after a network error or timeout, or to finish a batch with exactly the same inputs.`),
        max_cost_usd: z.number().positive().max(10_000).optional()
            .describe(`Compatibility option for a budget explicitly specified by the user. Compare the submission estimate against that budget; never derive this value from the estimate. This does not limit the final charge. Refuses when the estimate is incomplete or exceeds the budget; a token-billed reference price must fit ${REFERENCE_BUDGET_FACTOR} times over. With inputs it applies to the batch total.`),
        account_quote: ApprovedAccountQuote.optional().describe('Legacy approval. Refresh with estimate_cost and obtain user approval before using the new pricing rules.'),
        pricing_quote: ApprovedRulesEstimate.optional().describe('Client approval record from estimate_cost, for exactly this input (or these inputs). Rechecked against fresh pricing rules before submission; past its expires_at it still applies while the input and price are unchanged. Does not bind final settlement.'),
        pricing_parameters: QuoteParameters.optional().describe('The same explicit billing usage passed to estimate_cost.'),
        media_seconds: z.number().positive().max(MEDIA_SECONDS_MAX).optional().describe(MEDIA_SECONDS_DESCRIPTION),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional()
            .describe(`Seconds to wait for the result after submitting, 0–${MAX_WAIT_SECONDS} (default ${WAIT_MS[kind] / 1000}; with inputs only 0). 0 returns the task_id right after submission: use it when submitting several tasks, then collect them with list_tasks.`),
        skip_estimate: z.boolean().optional().describe('Only when the user has explicitly said not to estimate or not to confirm (for example "generate directly", "no need to estimate", "from now on just generate"); never on your own initiative. Submits without an approved estimate, also when the price cannot be computed or a pricing_quote changed, and says so in the result; the task is charged by actual usage. Invalid input and an explicit max_cost_usd are still checked.'),
    };
}
const argsSchema = (kind) => z.object(inputSchema(kind));
function rangeText(estimate) {
    return formatEstimateRange(estimate) ?? 'unknown';
}
/**
 * Why the price could not be computed, when skip_estimate may set that aside: rules that are missing, unreadable or
 * limited, or usage known only once the task runs. Input problems and a cancelled call are never set aside.
 */
function unpriced(error) {
    if (error instanceof PricingRulesError) {
        if (error.code === 'interrupted')
            return undefined;
        if (error.code === 'rate_limit_exceeded')
            return { reason: 'rules_rate_limited', why: 'the platform was limiting pricing requests, so the price was not checked' };
        if (error.code === 'not_found')
            return { reason: 'no_published_rule', why: 'no published price is available for this model' };
        return { reason: 'rules_unavailable', why: 'the pricing rules could not be read, so the price was not checked' };
    }
    if (!(error instanceof QuoteError))
        return undefined;
    if (error.code === 'pricing_rules_unavailable')
        return { reason: 'no_published_rule', why: 'no published price is available for this model and input' };
    if (error.code === 'quote_usage_required')
        return { reason: 'needs_input', why: `no total can be estimated before the task runs (it depends on ${error.param ?? 'usage measured when it runs'})` };
    if (error.code === 'search_pricing_unavailable')
        return { reason: 'search_price_unverified', why: 'the unit price of the enabled search could not be verified' };
    if (error.code === 'invalid_pricing_expression')
        return { reason: 'rules_unavailable', why: 'the published pricing rules could not be evaluated' };
    return undefined;
}
/**
 * A pricing_quote that no longer matches, set aside by skip_estimate: the result names the approved and the current
 * price (`now`, undefined when no total can be computed before the task runs).
 */
function changedApproval(error, approval, now, batch = false) {
    if (error.code === 'quote_input_changed') {
        return { reason: 'quote_input_changed', why: batch ? `the pricing_quote was for different inputs${now ? `; the estimate of these inputs is ${now}` : ''}`
                : `the pricing_quote was for a different input${now ? `; this input's estimate is ${now}` : ''}` };
    }
    return { reason: 'price_changed', why: `the price changed after it was approved (approved ${money(Number(amountsForUC(approval.total_uc).credits))}, now ${now ?? 'not computable before the task runs'})`,
        approved: approval.total_uc };
}
/** Why max_cost_usd could not be checked, and what the assistant can do next. */
function uncheckedCap(estimate, pricingWarning) {
    if (estimate.uncheckable_reason === 'usage')
        return ['published pricing rules need additional billing usage to calculate a complete estimate', `Provide the missing expected or measured usage. ${(estimate.usage_help ?? estimate.possible_extras).join(' ')}`];
    if (estimate.uncheckable_reason === 'output_duration') {
        return ['the generated output duration is not fixed, so the declared seconds cannot establish an upper bound', 'Use an explicit duration if the model accepts it; otherwise ask the user whether to proceed without a cap.'];
    }
    if (estimate.uncheckable_reason === 'reference_video') {
        return [
            'this per-second video request uses input.video_urls, input.video_url or input.source_task_id, and published prices do not fully cover input video seconds or video-dependent billing multipliers',
            'media_seconds cannot resolve this billing gap. Ask the user whether to proceed without a cap.',
        ];
    }
    if (estimate.status === 'token_billed') {
        return ['it is billed by tokens used, so its cost is only known afterwards', 'Ask the user whether to proceed without a cap.'];
    }
    if (estimate.missing === 'media_seconds') {
        return [
            'it is billed per second and has no duration parameter, so EvoLink measures the seconds when the task runs (usually the length of the input video or audio)',
            'If you know that length, pass it as media_seconds; otherwise ask the user whether to proceed without a cap.',
        ];
    }
    if (estimate.missing === 'duration') {
        return ['it is billed per second and input.duration is not set', 'Set input.duration, or ask the user whether to proceed without a cap.'];
    }
    // Notes end with a full stop; the sentence around the reason adds its own.
    const note = estimate.notes[0] ?? pricingWarning ?? 'no price could be found for it';
    return [note.replace(/[.\s]+$/, ''), 'Ask the user whether to proceed without a cap.'];
}
/** The catalog entry of a generate tool's model, or the refusal to return. */
async function generationModel(config, kind, model) {
    const { catalog, entry } = await resolveModel(model, config, { fresh: true, allowStale: false, skipPricing: true });
    if (!entry) {
        const suggestions = suggestModels(catalog, model, kind);
        return { refused: failure(`Unknown ${kind} model "${model}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''} Use search_models to find model IDs. Nothing was submitted or charged.`, { error: { category: 'not_found', param: 'model' }, suggestions, charged: 'no' }) };
    }
    if (entry.kind !== kind) {
        return { refused: failure(`${entry.id} is ${entry.kind === 'video' ? 'a' : 'an'} ${entry.kind} model; use generate_${entry.kind}. Nothing was submitted or charged.`, {
                error: { category: 'invalid_request', param: 'model' },
                use_tool: `generate_${entry.kind}`,
                charged: 'no',
            }) };
    }
    return { catalog, entry };
}
/** An input as generate_* submits it, with the problems that stop it and the warnings it carries. */
function checkGenerationInput(entry, input) {
    const prepared = prepareSeedanceInput(entry, input);
    const errors = [], warnings = [];
    if (entry.spec) {
        const validation = validateInput(entry.spec, prepared.input);
        errors.push(...validation.errors, ...prepared.errors);
        warnings.push(...[...validation.warnings, ...prepared.warnings].map(issue => `${issue.param} ${issue.problem}`));
    }
    else {
        warnings.push('This model\'s parameters are not documented here, so the input was not checked before sending.');
    }
    return { prepared, effectiveInput: prepared.input, errors, warnings };
}
export function registerGenerateTools(server, config) {
    for (const kind of ['image', 'video', 'audio'])
        registerGenerate(server, config, kind);
}
function registerGenerate(server, config, kind) {
    const name = `generate_${kind}`;
    const title = `Generate ${kind} (paid)`;
    server.registerTool(name, {
        title,
        description: description(kind),
        inputSchema: inputSchema(kind),
        annotations: { title, ...PAID },
    }, async (args, extra) => {
        const started = Date.now();
        const startedMono = monotonicNow();
        const credentials = currentRequestCredentials();
        const unavailable = !credentials?.serviceChannel && !credentials?.apiKey ? credentials?.unavailableReason : undefined;
        if (unavailable)
            return failure(`${unavailable} Nothing was submitted or charged.`, {
                error: { category: 'unauthorized' }, charged: 'no',
            });
        if (args.inputs !== undefined)
            return generateBatch(config, kind, args, extra, startedMono);
        const input = { ...(args.input ?? {}) };
        if (args.prompt !== undefined) {
            if (input.prompt !== undefined && input.prompt !== args.prompt) {
                return failure('prompt was given twice with different values (prompt and input.prompt). Pass it once. Nothing was submitted or charged.', {
                    error: { category: 'invalid_request', param: 'prompt' },
                    charged: 'no',
                });
            }
            if (args.prompt.length > PROMPT_SHORTCUT_MAX) {
                return failure(`The prompt is ${args.prompt.length.toLocaleString('en-US')} characters; the limit is ${PROMPT_SHORTCUT_MAX.toLocaleString('en-US')}. Shorten it and try again. Nothing was submitted or charged.`, {
                    error: { category: 'invalid_request', param: 'prompt' },
                    charged: 'no',
                });
            }
            input.prompt = args.prompt;
        }
        let clientRequestId;
        let acceptedTaskId;
        try {
            const resolved = await generationModel(config, kind, args.model);
            if ('refused' in resolved)
                return resolved.refused;
            const { catalog, entry } = resolved;
            const { prepared, effectiveInput, errors, warnings } = checkGenerationInput(entry, input);
            if (errors.length > 0) {
                return failure([
                    `The input for ${entry.id} has problems; nothing was submitted or charged:`,
                    ...formatIssues(errors),
                    'get_model lists every parameter with its allowed values.',
                ].join('\n'), { error: { category: 'invalid_request' }, problems: errors, charged: 'no' });
            }
            // media_seconds only prices the request; the body below is built from input alone.
            const skip = args.skip_estimate === true;
            if (args.account_quote && !skip)
                throw new QuoteError('quote_refresh_required', 'Refresh the legacy account estimate with estimate_cost and obtain user approval.');
            let rulesEstimate;
            let skipped;
            try {
                rulesEstimate = await createRulesEstimate(entry, effectiveInput, { mediaSeconds: args.media_seconds, pricingParameters: args.pricing_parameters,
                    purpose: 'generation', signal: extra.signal });
            }
            catch (error) {
                // The user asked to generate without an estimate: a price that cannot be computed no longer stops it.
                skipped = skip && !extra.signal.aborted ? unpriced(error) : undefined;
                if (!skipped)
                    throw error;
            }
            let approvalExpired = false;
            if (args.pricing_quote && rulesEstimate) {
                try {
                    approvalExpired = checkRulesApproval(args.pricing_quote, rulesEstimate).expired;
                }
                catch (error) {
                    if (!skip || !(error instanceof QuoteError))
                        throw error;
                    skipped = changedApproval(error, args.pricing_quote, rulesEstimate.estimate.status === 'needs_input' ? undefined : money(Number(rulesEstimate.amounts.credits)));
                }
            }
            const estimate = rulesEstimate?.estimate;
            // A reference price is settled at actual token usage, so a budget must leave room above it.
            const reference = estimate?.status === 'token_billed' && estimate.max_usd !== undefined && estimate.uncheckable_reason === undefined;
            const allowance = reference && rulesEstimate ? referenceAllowance(rulesEstimate.amounts.uc) : undefined;
            if (args.max_cost_usd !== undefined) {
                // skip_estimate sets aside the estimate, never the user's own budget.
                if (!rulesEstimate || !estimate) {
                    return failure(`max_cost_usd cannot be checked for ${entry.id}: ${skipped?.why ?? 'no price could be computed'}. Nothing was submitted or charged. skip_estimate does not set aside the user's budget: ask the user whether to proceed without the cap.`, {
                        error: { category: 'invalid_request', param: 'max_cost_usd' },
                        charged: 'no',
                    });
                }
                if (!reference && (estimate.uncheckable_reason !== undefined || estimate.status !== 'estimated' || estimate.max_usd === undefined)) {
                    const [reason, next] = uncheckedCap(estimate, catalog.pricingWarning);
                    return failure(`max_cost_usd cannot be checked for ${entry.id}: ${reason}. Nothing was submitted or charged. ${next}`, {
                        error: { category: 'invalid_request', param: 'max_cost_usd' },
                        estimate,
                        charged: 'no',
                    });
                }
                if (allowance && referenceBudgetExceeded(rulesEstimate.amounts.uc, args.max_cost_usd)) {
                    return failure(`The reference price ${rangeText(estimate)} is billed by actual token usage, and ${REFERENCE_BUDGET_FACTOR} times it ($${allowance.usd}, ${allowance.credits} credits) is above max_cost_usd $${args.max_cost_usd}. Nothing was submitted or charged. Lower the size, quality, count or reference images, or ask the user to raise the cap.`, {
                        error: { category: 'invalid_request', param: 'max_cost_usd' },
                        estimate, budget_check: { factor: REFERENCE_BUDGET_FACTOR, amounts: allowance },
                        charged: 'no',
                    });
                }
                if (!allowance && rulesBudgetExceeded(rulesEstimate.amounts.uc, args.max_cost_usd)) {
                    return failure(`The estimated cost ${rangeText(estimate)} is above max_cost_usd $${formatUsd(args.max_cost_usd)}. Nothing was submitted or charged. Lower the duration, count or quality, or ask the user to raise the cap.`, {
                        error: { category: 'invalid_request', param: 'max_cost_usd' },
                        estimate,
                        charged: 'no',
                    });
                }
            }
            if (estimate?.status === 'needs_input') {
                if (!skip) {
                    return failure([`No total can be estimated for ${entry.id} yet, so nothing was submitted or charged. The total depends on:`,
                        ...(estimate.usage_help ?? []).map(line => `- ${line}`),
                        'Estimate again with this usage and get the user\'s approval before generating.'].join('\n'), {
                        error: { category: 'estimate_unavailable', code: 'quote_usage_required' },
                        missing_usage: estimate.missing_usage, usage_help: estimate.usage_help, charged: 'no', submission_state: 'not_submitted'
                    });
                }
                skipped ??= { reason: 'needs_input', why: `no total can be estimated before the task runs (it depends on ${estimate.missing_usage?.join(', ') ?? 'usage measured when it runs'})` };
            }
            // An approved pricing_quote that still matches means nothing was skipped.
            const estimateSkipped = skip && !(args.pricing_quote && rulesEstimate && !skipped);
            clientRequestId = args.client_request_id ?? newRunId();
            const body = { ...effectiveInput, model: entry.id };
            const submitted = await submitTask(config, {
                path: entry.spec?.path ?? PATHS[kind],
                body,
                tool: name,
                idempotencyKey: clientRequestId,
            });
            acceptedTaskId = submitted.id;
            let task = submitted;
            let statusCheck = 'not_requested';
            // The post-submit wait has its own deadline; it never bounds or interrupts the paid submission above.
            const waitMs = args.wait_seconds !== undefined ? args.wait_seconds * 1000 : WAIT_MS[kind];
            const waitUntil = startedMono + waitMs;
            if ((!task.status || !TERMINAL_STATUSES.has(task.status)) && waitMs > 0 && remainingMs(waitUntil) > 3_000) {
                const report = progressReporter(extra, waitMs / 1000);
                try {
                    const waited = await waitForTask(config, submitted.id, {
                        deadline: waitUntil,
                        tool: name,
                        signal: extra.signal,
                        onPoll: current => report((Date.now() - started) / 1000, `${current.status}${current.progress !== undefined ? `, ${current.progress}%` : ''}`),
                    });
                    task = waited.task;
                    statusCheck = waited.statusCheck;
                }
                catch {
                    // The task exists; a failed status read must not turn a successful submit into an error.
                    task = submitted;
                    statusCheck = 'unverified';
                }
                task.usage = { ...submitted.usage, ...task.usage };
            }
            const view = describeTask({ ...task, request_id: task.request_id ?? submitted.request_id }, statusCheck);
            const header = submitted.idempotency_replayed
                ? `This client_request_id was used before: returning the original task (no new charge).`
                : `Submitted ${entry.id}.`;
            const lines = [header, ...view.lines];
            const reserved = submitted.usage?.credits_reserved;
            if (typeof reserved === 'number' && reserved > 0 && !lines.some(line => line.startsWith('Reserved:')) && task.status !== 'completed') {
                lines.push(`Reserved: ${money(reserved)}`);
            }
            if (estimateSkipped) {
                if (!skipped)
                    lines.push('Submitted at the user\'s request without an approved estimate (skip_estimate).');
                else if (skipped.reason === 'price_changed' || skipped.reason === 'quote_input_changed')
                    lines.push(`Submitted at the user's request (skip_estimate) although ${skipped.why}.`);
                else
                    lines.push(`Price check skipped at the user's request (skip_estimate): ${skipped.why}. The task is charged by actual usage.`);
                if (!(typeof reserved === 'number' && reserved > 0) && task.status !== 'completed')
                    lines.push('get_task shows the charge when the task finishes.');
            }
            if (approvalExpired)
                lines.push(`The approved estimate expired at ${args.pricing_quote.expires_at}, but the input and price are unchanged, so it was submitted under that approval.`);
            if (estimate?.status === 'estimated')
                lines.push(`Estimate before submitting: ${rangeText(estimate)}`);
            if (reference && estimate)
                lines.push(`Reference price before submitting: ${rangeText(estimate)}. Billed by actual token usage; the final charge is settled when the task finishes.`);
            if (allowance && args.max_cost_usd !== undefined)
                lines.push(`max_cost_usd $${args.max_cost_usd} covers ${REFERENCE_BUDGET_FACTOR} times the reference price ($${allowance.usd}, ${allowance.credits} credits). This was checked before submitting; it does not limit the final charge.`);
            if (estimate?.search_charges?.length && estimate.status === 'estimated') {
                for (const note of estimate.notes.filter(note => /^(Web|Image) search is enabled\./.test(note)))
                    lines.push(`Note: ${note}`);
            }
            for (const applied of prepared.defaults)
                lines.push(`Applied default: ${applied.param}=${applied.value} (${applied.reason}).`);
            if (estimate?.status === 'partial') {
                lines.push(`Partial estimate at published rates: ${rangeText(estimate)} (not a total or an upper bound).`);
                for (const extra of estimate.possible_extras)
                    lines.push(`May also charge: ${extra}`);
                for (const note of estimate.notes)
                    lines.push(`Note: ${note}`);
            }
            for (const warning of warnings)
                lines.push(`Warning: ${warning}`);
            lines.push(`client_request_id: ${clientRequestId}`);
            return ok(lines.join('\n'), {
                ...view.structured,
                submitted: { model: entry.id, input: effectiveInput },
                ...(prepared.applies ? { effective_input: effectiveInput, defaults_applied: prepared.defaults,
                    usage_assumptions: (estimate?.notes ?? []).filter(note => note.startsWith('Web search is enabled.')) } : {}),
                pricing_scope: 'public_default',
                pricing_source: 'pricing_rules',
                ...(rulesEstimate && estimate?.status !== 'needs_input' ? { amounts: rulesEstimate.amounts } : {}),
                final_budget_enforced: false,
                ...(estimate?.search_charges?.length ? { search_charges: estimate.search_charges, estimate,
                    amount_scope: estimate.status === 'partial' ? 'known_components_subtotal' : 'expected_usage_estimate' } : {}),
                client_request_id: clientRequestId,
                submission_state: 'accepted',
                replayed: submitted.idempotency_replayed === true,
                ...(approvalExpired ? { approval_expired: true } : {}),
                ...(estimateSkipped ? { estimate_skipped: true, estimate_skip_reason: skipped?.reason ?? 'none' } : {}),
                ...(skipped?.approved ? { approved_amounts: amountsForUC(skipped.approved) } : {}),
                ...(typeof reserved === 'number' ? { reserved_credits: reserved, reserved_usd: usdOf(reserved) } : {}),
                ...(estimate?.status === 'estimated' && !estimate.search_charges?.length ? { estimate: { min_usd: estimate.min_usd, max_usd: estimate.max_usd } } : {}),
                ...(estimate?.status === 'partial' ? { estimate } : {}),
                ...(reference && estimate ? { estimate: { status: estimate.status, min_usd: estimate.min_usd, max_usd: estimate.max_usd, total_known: false,
                        reference_usage: estimate.reference_usage } } : {}),
                ...(allowance && args.max_cost_usd !== undefined ? { budget_check: { factor: REFERENCE_BUDGET_FACTOR, amounts: allowance, max_cost_usd: args.max_cost_usd } } : {}),
                ...(warnings.length ? { warnings } : {}),
            }, view.resources);
        }
        catch (error) {
            if (error instanceof PricingRulesError)
                return failure(error.code === 'rate_limit_exceeded'
                    ? `The platform is limiting pricing requests right now, so the price could not be checked and nothing was submitted or charged. Try again in ${retryText(error.retryAfter)}.`
                    : 'The pricing rules could not be verified. Nothing was submitted or charged.', {
                    error: { category: 'estimate_unavailable', code: error.code, ...(error.retryAfter !== undefined ? { retry_after_seconds: error.retryAfter } : {}) },
                    charged: 'no', submission_state: 'not_submitted'
                });
            if (error instanceof QuoteError)
                return failure(`${error.message} Nothing was submitted or charged.`, { error: { category: 'estimate_unavailable', code: error.code }, charged: 'no', submission_state: 'not_submitted' });
            // clientRequestId is set right before the submit, so it also tells whether a request may have gone out.
            return errorResult(error, { paid: clientRequestId !== undefined, clientRequestId, taskId: acceptedTaskId,
                phase: acceptedTaskId ? 'accepted' : clientRequestId ? 'submit_started' : 'before_submit' });
        }
    });
}
const itemList = (indexes) => indexes.map(index => `inputs[${index}]`).join(', ');
/**
 * A batch item's outcome, classified like a single submission. An item that never started, or that the gateway rate
 * limited on every attempt (it releases the key), is not submitted; a refusal that ran nothing is fixed and finished
 * with the same client_request_id, unless the gateway keeps it for the key. An item whose key was used for a different
 * input is refused: the same call would conflict again.
 */
function itemReport(submission, cancelled) {
    const index = submission.index, at = `inputs[${index}]`, base = { index, client_request_id: submission.requestId };
    const task = submission.receipt;
    if (task) {
        const reserved = task.usage?.credits_reserved, replayed = task.idempotency_replayed === true;
        const held = typeof reserved === 'number' && reserved > 0 ? reserved : undefined;
        return { index, state: 'accepted', finishable: false, taskId: task.id, reserved: held, replayed,
            line: `- ${at}: task ${task.id}, ${task.status ?? 'accepted'}${held ? `; reserved ${money(held)}` : ''}${replayed ? ' (submitted earlier with this client_request_id: the original task, no new charge)' : ''}`,
            structured: { ...base, submission_state: 'accepted', task_id: task.id, ...(task.status ? { status: task.status } : {}), replayed,
                ...(typeof reserved === 'number' ? { reserved_credits: reserved, reserved_usd: usdOf(reserved) } : {}) } };
    }
    if (!submission.started) {
        return { index, state: 'not_submitted', finishable: true,
            line: `- ${at}: not submitted (${cancelled ? 'the call was cancelled' : 'the batch ran out of time'}). Nothing was charged for it.`,
            structured: { ...base, submission_state: 'not_submitted', charged: 'no', finishable: true, reason: cancelled ? 'cancelled' : 'deadline', retryable: true } };
    }
    const failed = errorResult(submission.error, { paid: true, clientRequestId: submission.requestId, phase: 'submit_started' })
        .structuredContent;
    const info = failed.error;
    // Nothing ran either way, so nothing was charged; but the same key with this input conflicts every time.
    const refused = refusedBeforeRunning(submission);
    if (refused && keyConflict(submission)) {
        return { index, state: 'rejected', finishable: false, conflict: true, error: info,
            line: `- ${at}: refused (idempotency_conflict, HTTP 409): ${at} differs from what this client_request_id submitted earlier. Pass exactly the same inputs to finish the batch; a different input is a new task that needs a new estimate, approval and client_request_id. Nothing was charged for it.`,
            structured: { ...base, submission_state: 'rejected', charged: 'no', finishable: false,
                error: { category: 'idempotency_conflict', code: 'idempotency_conflict', status: 409,
                    message: `${at} differs from what this client_request_id submitted earlier.`, retryable: false } } };
    }
    const state = refused || failed.submission_state === 'not_submitted' ? 'not_submitted'
        : failed.submission_state === 'rejected' ? 'rejected' : 'outcome_unknown';
    const kept = state === 'rejected' && keptRefusal(info.code);
    const finishable = state === 'not_submitted' || state === 'rejected' && !kept;
    const label = `${info.category}${info.code ? `, ${info.code}` : ''}${info.status ? `, HTTP ${info.status}` : ''}`;
    const verb = state === 'outcome_unknown' ? 'outcome unknown' : state === 'rejected' ? 'refused' : 'not submitted';
    return { index, state, finishable, error: info,
        line: `- ${at}: ${verb} (${label}): ${info.headline ?? info.message}${state === 'outcome_unknown' ? ' Whether a charge was made is unknown.' : ' Nothing was charged for it.'}${kept
            ? ' The gateway keeps this refusal for this client_request_id for 24 hours: once it is fixed, submit this input separately, as a new task with a new estimate, approval and client_request_id.' : ''}`,
        structured: { ...base, submission_state: state, charged: state === 'outcome_unknown' ? 'unknown' : 'no', ...(state === 'outcome_unknown' ? {} : { finishable }),
            error: { category: info.category, ...(info.code ? { code: info.code } : {}), ...(info.status ? { status: info.status } : {}), message: info.message,
                retryable: state === 'not_submitted' || (info.retryable && !kept), ...(info.retry_after_seconds !== undefined ? { retry_after_seconds: info.retry_after_seconds } : {}),
                ...(info.request_id ? { request_id: info.request_id } : {}) } } };
}
/**
 * Several inputs for one model: every input is checked first, the rules are read once, one batch approval (or
 * skip_estimate) covers them all and max_cost_usd the total; then the items are submitted together (submitBatch).
 */
async function generateBatch(config, kind, args, extra, startedMono) {
    const name = `generate_${kind}`, inputs = args.inputs, count = inputs.length, batch = { items: count };
    const refuse = (param, text) => failure(`${text} Nothing was submitted or charged.`, { error: { category: 'invalid_request', param }, charged: 'no', batch });
    if (args.input !== undefined)
        return refuse('inputs', 'Pass input for one task or inputs for a batch, not both.');
    if (args.prompt !== undefined)
        return refuse('prompt', 'The prompt shortcut is for one input; with inputs, put each prompt in its item.');
    if (args.wait_seconds)
        return refuse('wait_seconds', 'wait_seconds is not used with inputs: a batch returns as soon as its items are submitted; collect the results with list_tasks (task_ids).');
    if (args.client_request_id !== undefined && args.client_request_id.length > BATCH_REQUEST_ID_MAX) {
        return refuse('client_request_id', `With inputs, client_request_id has at most ${BATCH_REQUEST_ID_MAX} characters, since each item adds .NN to it.`);
    }
    let batchId;
    try {
        const resolved = await generationModel(config, kind, args.model);
        if ('refused' in resolved)
            return resolved.refused;
        const { catalog, entry } = resolved;
        const checked = inputs.map(item => checkGenerationInput(entry, item));
        const problems = checked.flatMap((item, index) => item.errors.map(issue => ({ ...issue, param: `inputs[${index}].${issue.param}` })));
        if (problems.length > 0) {
            return failure([`Some inputs for ${entry.id} have problems; nothing was submitted or charged:`, ...formatIssues(problems),
                'get_model lists every parameter with its allowed values.'].join('\n'), { error: { category: 'invalid_request' }, problems, charged: 'no', batch });
        }
        const skipEstimate = args.skip_estimate === true;
        if (args.account_quote && !skipEstimate)
            throw new QuoteError('quote_refresh_required', 'Refresh the legacy account estimate with estimate_cost and obtain user approval.');
        // One read of the rules prices every input. skip_estimate sets aside a price that cannot be computed, batch-wide
        // (unreadable rules) or for single inputs; anything else stops the whole batch.
        let batchSkipped;
        const itemSkipped = inputs.map(() => undefined);
        let rules;
        try {
            rules = (await readPricingRulesFor(entry, { purpose: 'generation', signal: extra.signal })).body;
        }
        catch (error) {
            batchSkipped = skipEstimate && !extra.signal.aborted ? unpriced(error) : undefined;
            if (!batchSkipped)
                throw error;
        }
        const priced = rules ? checked.map((item, index) => {
            try {
                return calculateRulesEstimate(rules, entry, item.effectiveInput, { mediaSeconds: args.media_seconds, pricingParameters: args.pricing_parameters });
            }
            catch (error) {
                itemSkipped[index] = skipEstimate ? unpriced(error) : undefined;
                if (!itemSkipped[index])
                    throw error instanceof QuoteError ? new QuoteError(error.code, `inputs[${index}]: ${error.message}`, error.param) : error;
                return undefined;
            }
        }) : [];
        const estimates = rules && priced.every(item => item !== undefined) ? priced : undefined;
        const total = estimates ? batchTotal(entry.id, estimates) : undefined;
        let expiredApproval = false;
        if (args.pricing_quote && total) {
            try {
                expiredApproval = checkBatchApproval(args.pricing_quote, total.approval).expired;
            }
            catch (error) {
                if (!skipEstimate || !(error instanceof QuoteError))
                    throw error;
                batchSkipped = changedApproval(error, args.pricing_quote, total.status === 'needs_input' ? undefined : money(Number(total.amounts.credits)), true);
            }
        }
        // A batch reference price is settled at actual token usage, so a budget must leave room above it.
        const tokenBilled = total !== undefined && estimates.every(item => item.estimate.status === 'token_billed' && item.estimate.max_usd !== undefined
            && item.estimate.uncheckable_reason === undefined);
        const budgetRoom = tokenBilled ? referenceAllowance(total.amounts.uc) : undefined;
        if (args.max_cost_usd !== undefined) {
            // skip_estimate sets aside the estimate, never the user's own budget.
            if (!total || !estimates) {
                const first = itemSkipped.findIndex(Boolean);
                return failure(`max_cost_usd cannot be checked for ${batchSkipped || first < 0 ? '' : `inputs[${first}] of `}${entry.id}: ${batchSkipped?.why ?? itemSkipped[first]?.why ?? 'no price could be computed'}. Nothing was submitted or charged. skip_estimate does not set aside the user's budget: ask the user whether to proceed without the cap.`, {
                    error: { category: 'invalid_request', param: 'max_cost_usd' }, charged: 'no', batch
                });
            }
            const open = tokenBilled ? -1 : estimates.findIndex(item => item.estimate.uncheckable_reason !== undefined || item.estimate.status !== 'estimated' || item.estimate.max_usd === undefined);
            if (open >= 0) {
                const [reason, next] = uncheckedCap(estimates[open].estimate, catalog.pricingWarning);
                return failure(`max_cost_usd cannot be checked for inputs[${open}] of ${entry.id}: ${reason}. Nothing was submitted or charged. ${next}`, {
                    error: { category: 'invalid_request', param: 'max_cost_usd' }, estimate: total.estimate, charged: 'no', batch
                });
            }
            if (budgetRoom && referenceBudgetExceeded(total.amounts.uc, args.max_cost_usd)) {
                return failure(`The reference price of the batch, ${rangeText(total.estimate)}, is billed by actual token usage, and ${REFERENCE_BUDGET_FACTOR} times it ($${budgetRoom.usd}, ${budgetRoom.credits} credits) is above max_cost_usd $${args.max_cost_usd}. Nothing was submitted or charged. Use fewer inputs, or lower the size, quality, count or reference images, or ask the user to raise the cap.`, {
                    error: { category: 'invalid_request', param: 'max_cost_usd' }, estimate: total.estimate, budget_check: { factor: REFERENCE_BUDGET_FACTOR, amounts: budgetRoom }, charged: 'no', batch
                });
            }
            if (!budgetRoom && rulesBudgetExceeded(total.amounts.uc, args.max_cost_usd)) {
                return failure(`The estimated cost of the batch, ${rangeText(total.estimate)}, is above max_cost_usd $${formatUsd(args.max_cost_usd)}. Nothing was submitted or charged. Use fewer inputs, or lower the duration, count or quality, or ask the user to raise the cap.`, {
                    error: { category: 'invalid_request', param: 'max_cost_usd' }, estimate: total.estimate, charged: 'no', batch
                });
            }
        }
        if (total && total.needsInput.length > 0) {
            if (!skipEstimate) {
                return failure([`No total can be estimated for ${itemList(total.needsInput)} of ${entry.id} yet, so nothing was submitted or charged. The total depends on:`,
                    ...(total.estimate.usage_help ?? []).map(line => `- ${line}`),
                    'Estimate again with this usage and get the user\'s approval before generating.'].join('\n'), {
                    error: { category: 'estimate_unavailable', code: 'quote_usage_required' }, missing_usage: total.estimate.missing_usage,
                    usage_help: total.estimate.usage_help, charged: 'no', submission_state: 'not_submitted', batch
                });
            }
            for (const index of total.needsInput) {
                itemSkipped[index] ??= { reason: 'needs_input', why: `no total can be estimated before the task runs (it depends on ${estimates[index].estimate.missing_usage?.join(', ') ?? 'usage measured when it runs'})` };
            }
        }
        const someItemsSkipped = itemSkipped.some(Boolean);
        // An approved batch pricing_quote that still matches means nothing was skipped.
        const skippedBatch = skipEstimate && !(args.pricing_quote && total && !batchSkipped && !someItemsSkipped);
        const skipReasons = batchSkipped ? batchSkipped.reason : someItemsSkipped
            ? [...new Set(itemSkipped.flatMap(item => item ? [item.reason] : []))].sort().join(',') : 'none';
        batchId = args.client_request_id ?? newRunId();
        const token = extra._meta?.progressToken;
        const submissions = await submitBatch(config, { path: entry.spec?.path ?? PATHS[kind], bodies: checked.map(item => ({ ...item.effectiveInput, model: entry.id })),
            batchId, tool: name, startedMono, signal: extra.signal,
            onSubmitted: done => {
                if (token !== undefined)
                    void extra.sendNotification({ method: 'notifications/progress',
                        params: { progressToken: token, progress: done, total: count, message: `Submitted ${done} of ${count}` } }).catch(() => undefined);
            } });
        const reports = submissions.map(item => itemReport(item, extra.signal.aborted));
        const accepted = reports.filter(report => report.state === 'accepted');
        const tally = (state) => reports.filter(report => report.state === state).length;
        // Only these can still be finished with this client_request_id; an unknown outcome is retried later or looked up.
        const finishing = reports.filter(report => report.finishable).map(report => report.index);
        const unknown = reports.filter(report => report.state === 'outcome_unknown').map(report => report.index);
        const counts = { items: count, accepted: accepted.length, replayed: accepted.filter(report => report.replayed).length,
            not_submitted: tally('not_submitted'), rejected: tally('rejected'), outcome_unknown: tally('outcome_unknown'), finishable: finishing.length };
        const taskIds = accepted.map(report => report.taskId);
        const heldCredits = accepted.reduce((sum, report) => sum + (report.reserved ?? 0), 0);
        const lines = [`Submitted ${accepted.length} of ${count} input${count === 1 ? '' : 's'} to ${entry.id}.`];
        if (counts.replayed)
            lines.push(`${counts.replayed} of them had been submitted earlier with this client_request_id: the original task${counts.replayed === 1 ? ' was' : 's were'} returned without a new charge.`);
        lines.push(...reports.map(report => report.line));
        if (heldCredits > 0)
            lines.push(`Reserved in total: ${money(heldCredits)} (each final charge is settled when its task finishes).`);
        if (skippedBatch) {
            if (!batchSkipped && !someItemsSkipped)
                lines.push('Submitted at the user\'s request without an approved estimate (skip_estimate).');
            else if (batchSkipped?.reason === 'price_changed' || batchSkipped?.reason === 'quote_input_changed')
                lines.push(`Submitted at the user's request (skip_estimate) although ${batchSkipped.why}.`);
            else if (batchSkipped)
                lines.push(`Price check skipped at the user's request (skip_estimate): ${batchSkipped.why}. The tasks are charged by actual usage.`);
            const whys = [...new Set(itemSkipped.flatMap(item => item ? [item.why] : []))];
            for (const why of whys)
                lines.push(`Price check skipped at the user's request (skip_estimate) for ${itemList(itemSkipped.flatMap((item, index) => item?.why === why ? [index] : []))}: ${why}. Charged by actual usage.`);
            if (accepted.some(report => !report.reserved))
                lines.push('list_tasks or get_task shows each charge when its task finishes.');
        }
        if (expiredApproval)
            lines.push(`The approved estimate expired at ${args.pricing_quote.expires_at}, but the inputs and price are unchanged, so the batch was submitted under that approval.`);
        if (total?.status === 'estimated')
            lines.push(`Estimate before submitting: ${rangeText(total.estimate)} for ${count} input${count === 1 ? '' : 's'}.`);
        if (tokenBilled && total)
            lines.push(`Reference price before submitting: ${rangeText(total.estimate)} for ${count} input${count === 1 ? '' : 's'}. Billed by actual token usage; each final charge is settled when its task finishes.`);
        if (budgetRoom && args.max_cost_usd !== undefined)
            lines.push(`max_cost_usd $${args.max_cost_usd} covers ${REFERENCE_BUDGET_FACTOR} times the batch reference price ($${budgetRoom.usd}, ${budgetRoom.credits} credits). This was checked before submitting; it does not limit the final charge.`);
        if (total?.status === 'partial') {
            lines.push(`Partial estimate at published rates: ${rangeText(total.estimate)} for ${count} inputs (not a total or an upper bound; partial for ${itemList(total.partial)}).`);
            for (const item of total.estimate.possible_extras)
                lines.push(`May also charge: ${item}`);
        }
        checked.forEach((item, index) => {
            for (const applied of item.prepared.defaults)
                lines.push(`Applied default: inputs[${index}].${applied.param}=${applied.value} (${applied.reason}).`);
        });
        const warnings = [...new Set(checked.flatMap((item, index) => item.warnings.map(warning => entry.spec ? `inputs[${index}].${warning}` : warning)))];
        for (const warning of warnings)
            lines.push(`Warning: ${warning}`);
        if (taskIds.length)
            lines.push(`Collect the results with list_tasks (task_ids: ${taskIds.join(', ')}); it is free and read-only.`);
        if (finishing.length) {
            const fixFirst = reports.some(report => report.finishable && report.state === 'rejected');
            lines.push(`To finish the batch, call ${name} again with client_request_id "${batchId}" and exactly the same inputs within 24 hours${fixFirst ? ', after fixing what the refused inputs need' : ''}: ${itemList(finishing)} will then be submitted, and accepted items return their original tasks without a new charge.`);
        }
        if (unknown.length)
            lines.push(`The outcome of ${itemList(unknown)} is unknown: retry later with the same client_request_id and inputs, or check list_tasks.`);
        if (accepted.length < count)
            lines.push('Never resubmit accepted, not-submitted or unknown-outcome inputs under a new client_request_id: that creates and charges new tasks.');
        // Each distinct next step once, with the refused inputs it applies to.
        const steps = new Map();
        for (const report of reports) {
            if (report.state === 'rejected' && !report.conflict && report.error)
                steps.set(report.error.next_step, [...(steps.get(report.error.next_step) ?? []), report.index]);
        }
        if (steps.size)
            lines.push('Next steps for refused inputs:', ...[...steps].map(([step, indexes]) => `- ${itemList(indexes)}: ${step}`));
        if (counts.outcome_unknown)
            lines.push(DASHBOARD_CHECK_GUIDANCE);
        lines.push(`client_request_id: ${batchId}`);
        const structured = {
            model: entry.id,
            type: kind,
            batch: { client_request_id: batchId, ...counts },
            items: reports.map(report => report.structured),
            task_ids: taskIds,
            pricing_scope: 'public_default',
            pricing_source: 'pricing_rules',
            ...(total && total.status !== 'needs_input' ? { amounts: total.amounts } : {}),
            final_budget_enforced: false,
            client_request_id: batchId,
            submission_state: accepted.length === count ? 'accepted' : accepted.length ? 'partial'
                : counts.outcome_unknown ? 'outcome_unknown' : counts.rejected ? 'rejected' : 'not_submitted',
            ...(expiredApproval ? { approval_expired: true } : {}),
            ...(skippedBatch ? { estimate_skipped: true, estimate_skip_reason: skipReasons } : {}),
            ...(batchSkipped?.approved ? { approved_amounts: amountsForUC(batchSkipped.approved) } : {}),
            ...(heldCredits > 0 ? { reserved_credits: heldCredits, reserved_usd: usdOf(heldCredits) } : {}),
            ...(total?.status === 'estimated' ? { estimate: { min_usd: total.estimate.min_usd, max_usd: total.estimate.max_usd } } : {}),
            ...(total?.status === 'partial' ? { estimate: total.estimate } : {}),
            ...(tokenBilled && total ? { estimate: { status: total.status, min_usd: total.estimate.min_usd, max_usd: total.estimate.max_usd, total_known: false } } : {}),
            ...(budgetRoom && args.max_cost_usd !== undefined ? { budget_check: { factor: REFERENCE_BUDGET_FACTOR, amounts: budgetRoom, max_cost_usd: args.max_cost_usd } } : {}),
            ...(warnings.length ? { warnings } : {}),
            ...(counts.outcome_unknown ? dashboardCheck() : {}),
        };
        if (accepted.length > 0)
            return ok(lines.join('\n'), structured);
        const first = reports.find(report => report.error)?.error;
        return failure(lines.join('\n'), { ...structured, error: { category: first?.category ?? 'not_submitted', ...(first?.code ? { code: first.code } : {}) },
            charged: counts.outcome_unknown ? 'unknown' : 'no' });
    }
    catch (error) {
        if (error instanceof PricingRulesError)
            return failure(error.code === 'rate_limit_exceeded'
                ? `The platform is limiting pricing requests right now, so the prices of these inputs could not be checked and nothing was submitted or charged. Try again in ${retryText(error.retryAfter)}.`
                : 'The pricing rules could not be verified for these inputs. Nothing was submitted or charged.', {
                error: { category: 'estimate_unavailable', code: error.code, ...(error.retryAfter !== undefined ? { retry_after_seconds: error.retryAfter } : {}) },
                charged: 'no', submission_state: 'not_submitted', batch
            });
        if (error instanceof QuoteError)
            return failure(`${error.message} Nothing was submitted or charged.`, {
                error: { category: 'estimate_unavailable', code: error.code }, charged: 'no', submission_state: 'not_submitted', batch
            });
        // Each submission reports its own outcome, so an error here came before any item was submitted.
        return errorResult(error, { paid: false, clientRequestId: batchId, phase: 'before_submit' });
    }
}
