// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { submitTask } from '../services/api-client.js';
import { resolveModel, suggestModels } from '../services/model-catalog.js';
import { formatIssues, validateInput } from '../services/param-validator.js';
import { formatEstimateRange } from '../services/pricing-client.js';
import { ApprovedAccountQuote, QuoteParameters, QuoteError } from '../services/pricing-quote-client.js';
import { ApprovedRulesEstimate, createRulesEstimate, checkRulesApproval, rulesBudgetExceeded } from '../services/pricing-rules-estimate.js';
import { PricingRulesError } from '../services/pricing-rules-client.js';
import { CLIENT_REQUEST_ID_PATTERN, newRunId } from '../services/http-policy.js';
import { formatUsd } from '../services/error-handler.js';
import { MEDIA_SECONDS_DESCRIPTION, MEDIA_SECONDS_MAX, PAID, errorResult, failure, money, ok, progressReporter, usdOf } from './shared.js';
import { RESULT_DELIVERY_GUIDANCE, TERMINAL_STATUSES, describeTask, waitForTask } from './task-format.js';
import { PAID_GENERATION_GUIDANCE } from '../tool-guidance.js';
import { currentRequestCredentials } from '../request-context.js';
const PATHS = {
    image: '/v1/images/generations',
    video: '/v1/videos/generations',
    audio: '/v1/audios/generations',
};
/** Images usually finish in seconds, so the tool waits for them; video and audio return the task at once. */
const WAIT_MS = { image: 40_000, video: 0, audio: 0 };
const DESCRIPTIONS = {
    image: 'Generate or edit images with an EvoLink image model. PAID: charges the user\'s EvoLink balance.',
    video: 'Generate a video with an EvoLink video model (text-to-video, image-to-video, reference, edit, extend). PAID: charges the user\'s EvoLink balance.',
    audio: 'Generate music, songs or speech with an EvoLink audio model. PAID: charges the user\'s EvoLink balance.',
};
const AFTER = {
    image: 'Waits up to 40 s and returns the image links when ready; otherwise returns the task_id for get_task.',
    video: 'Returns a task_id at once (videos take minutes); then call get_task, which can wait up to 45 s per call.',
    audio: 'Returns a task_id at once; then call get_task, which can wait up to 45 s per call.',
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
function rangeText(estimate) {
    return formatEstimateRange(estimate) ?? 'unknown';
}
/** Why max_cost_usd could not be checked, and what the assistant can do next. */
function uncheckedCap(estimate, pricingWarning) {
    if (estimate.uncheckable_reason === 'usage')
        return ['published pricing rules need additional billing usage to calculate a complete estimate', `Provide the missing expected or measured usage in pricing_parameters. ${estimate.possible_extras.join(' ')}`];
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
        inputSchema: {
            model: z.string().min(1).max(128).describe(`${kind[0].toUpperCase()}${kind.slice(1)} model ID from search_models.`),
            // The cap is checked in the handler: a schema limit makes the SDK answer with a bare validation error.
            prompt: z.string().optional().describe(`Shortcut for input.prompt; up to ${PROMPT_SHORTCUT_MAX.toLocaleString('en-US')} characters (get_model lists the model's own limit).`),
            input: z.record(z.unknown()).optional()
                .describe('Model parameters exactly as listed by get_model, e.g. {"prompt":"…","quality":"1080p"}. Do not put model or callback_url here.'),
            client_request_id: z.string().regex(CLIENT_REQUEST_ID_PATTERN).optional()
                .describe('Optional idempotency key (16–96 characters: letters, digits, . _ -). Reuse the same value only to retry the same request after a network error or timeout.'),
            max_cost_usd: z.number().positive().max(10_000).optional()
                .describe('Compatibility option for a budget explicitly specified by the user. Compare the submission estimate against that budget; never derive this value from the estimate. This does not limit the final charge. Refuses when the estimate is incomplete or exceeds the budget.'),
            account_quote: ApprovedAccountQuote.optional().describe('Legacy approval. Refresh with estimate_cost and obtain user approval before using the new pricing rules.'),
            pricing_quote: ApprovedRulesEstimate.optional().describe('Client approval record from estimate_cost, for exactly this input. Rechecked against fresh pricing rules before submission; does not bind final settlement.'),
            pricing_parameters: QuoteParameters.optional().describe('The same explicit billing usage passed to estimate_cost.'),
            media_seconds: z.number().positive().max(MEDIA_SECONDS_MAX).optional().describe(MEDIA_SECONDS_DESCRIPTION),
        },
        annotations: { title, ...PAID },
    }, async (args, extra) => {
        const started = Date.now();
        const credentials = currentRequestCredentials();
        const unavailable = !credentials?.serviceChannel && !credentials?.apiKey ? credentials?.unavailableReason : undefined;
        if (unavailable)
            return failure(`${unavailable} Nothing was submitted or charged.`, {
                error: { category: 'unauthorized' }, charged: 'no',
            });
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
            const { catalog, entry } = await resolveModel(args.model, config, { fresh: true, allowStale: false, skipPricing: true });
            if (!entry) {
                const suggestions = suggestModels(catalog, args.model, kind);
                return failure(`Unknown ${kind} model "${args.model}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''} Use search_models to find model IDs. Nothing was submitted or charged.`, { error: { category: 'not_found', param: 'model' }, suggestions, charged: 'no' });
            }
            if (entry.kind !== kind) {
                return failure(`${entry.id} is ${entry.kind === 'video' ? 'a' : 'an'} ${entry.kind} model; use generate_${entry.kind}. Nothing was submitted or charged.`, {
                    error: { category: 'invalid_request', param: 'model' },
                    use_tool: `generate_${entry.kind}`,
                    charged: 'no',
                });
            }
            const warnings = [];
            if (entry.spec) {
                const validation = validateInput(entry.spec, input);
                if (validation.errors.length > 0) {
                    return failure([
                        `The input for ${entry.id} has problems; nothing was submitted or charged:`,
                        ...formatIssues(validation.errors),
                        'get_model lists every parameter with its allowed values.',
                    ].join('\n'), { error: { category: 'invalid_request' }, problems: validation.errors, charged: 'no' });
                }
                warnings.push(...validation.warnings.map(issue => `${issue.param} ${issue.problem}`));
            }
            else {
                warnings.push('This model\'s parameters are not documented here, so the input was not checked before sending.');
            }
            // media_seconds only prices the request; the body below is built from input alone.
            if (args.account_quote)
                throw new QuoteError('quote_refresh_required', 'Refresh the legacy account estimate with estimate_cost and obtain user approval.');
            const rulesEstimate = await createRulesEstimate(entry, input, { mediaSeconds: args.media_seconds, pricingParameters: args.pricing_parameters });
            if (args.pricing_quote)
                checkRulesApproval(args.pricing_quote, rulesEstimate);
            const estimate = rulesEstimate.estimate;
            if (args.max_cost_usd !== undefined) {
                if (estimate.uncheckable_reason !== undefined || estimate.status !== 'estimated' || estimate.max_usd === undefined) {
                    const [reason, next] = uncheckedCap(estimate, catalog.pricingWarning);
                    return failure(`max_cost_usd cannot be checked for ${entry.id}: ${reason}. Nothing was submitted or charged. ${next}`, {
                        error: { category: 'invalid_request', param: 'max_cost_usd' },
                        estimate,
                        charged: 'no',
                    });
                }
                if (rulesBudgetExceeded(rulesEstimate.amounts.uc, args.max_cost_usd)) {
                    return failure(`The estimated cost ${rangeText(estimate)} is above max_cost_usd $${formatUsd(args.max_cost_usd)}. Nothing was submitted or charged. Lower the duration, count or quality, or ask the user to raise the cap.`, {
                        error: { category: 'invalid_request', param: 'max_cost_usd' },
                        estimate,
                        charged: 'no',
                    });
                }
            }
            if (estimate.status === 'needs_input')
                throw new QuoteError('quote_usage_required', 'No charge can be estimated yet; supply the missing pricing usage before submission.');
            clientRequestId = args.client_request_id ?? newRunId();
            const body = { ...input, model: entry.id };
            const submitted = await submitTask(config, {
                path: entry.spec?.path ?? PATHS[kind],
                body,
                tool: name,
                idempotencyKey: clientRequestId,
            });
            acceptedTaskId = submitted.id;
            let task = submitted;
            const waitUntil = started + WAIT_MS[kind];
            if (!TERMINAL_STATUSES.has(task.status) && WAIT_MS[kind] > 0 && Date.now() + 3_000 < waitUntil) {
                const report = progressReporter(extra, WAIT_MS[kind] / 1000);
                try {
                    task = await waitForTask(config, submitted.id, {
                        deadline: waitUntil,
                        tool: name,
                        signal: extra.signal,
                        onPoll: current => report((Date.now() - started) / 1000, `${current.status}, ${current.progress ?? 0}%`),
                    });
                }
                catch {
                    // The task exists; a failed status read must not turn a successful submit into an error.
                    task = submitted;
                }
                task.usage = { ...submitted.usage, ...task.usage };
            }
            const view = describeTask({ ...task, request_id: task.request_id ?? submitted.request_id });
            const header = submitted.idempotency_replayed
                ? `This client_request_id was used before: returning the original task (no new charge).`
                : `Submitted ${entry.id}.`;
            const lines = [header, ...view.lines];
            const reserved = submitted.usage?.credits_reserved;
            if (typeof reserved === 'number' && reserved > 0 && !lines.some(line => line.startsWith('Reserved:')) && task.status !== 'completed') {
                lines.push(`Reserved: ${money(reserved)}`);
            }
            if (estimate.status === 'estimated')
                lines.push(`Estimate before submitting: ${rangeText(estimate)}`);
            if (estimate.status === 'partial') {
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
                submitted: { model: entry.id, input },
                pricing_scope: 'public_default',
                pricing_source: 'pricing_rules',
                amounts: rulesEstimate.amounts,
                final_budget_enforced: false,
                client_request_id: clientRequestId,
                replayed: submitted.idempotency_replayed === true,
                ...(typeof reserved === 'number' ? { reserved_credits: reserved, reserved_usd: usdOf(reserved) } : {}),
                ...(estimate.status === 'estimated' ? { estimate: { min_usd: estimate.min_usd, max_usd: estimate.max_usd } } : {}),
                ...(estimate.status === 'partial' ? { estimate } : {}),
                ...(warnings.length ? { warnings } : {}),
            }, view.resources);
        }
        catch (error) {
            if (error instanceof PricingRulesError)
                return failure('The pricing rules could not be verified. Nothing was submitted or charged.', { error: { category: 'estimate_unavailable', code: error.code }, charged: 'no', submission_state: 'not_submitted' });
            if (error instanceof QuoteError)
                return failure(`${error.message} Nothing was submitted or charged.`, { error: { category: 'estimate_unavailable', code: error.code }, charged: 'no', submission_state: 'not_submitted' });
            // clientRequestId is set right before the submit, so it also tells whether a request may have gone out.
            return errorResult(error, { paid: clientRequestId !== undefined, clientRequestId, taskId: acceptedTaskId,
                phase: acceptedTaskId ? 'accepted' : clientRequestId ? 'submit_started' : 'before_submit' });
        }
    });
}
