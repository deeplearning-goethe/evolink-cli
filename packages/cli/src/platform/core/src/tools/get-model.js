// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { modelParamsMeta } from '../data/model-params.js';
import { resolveModel, suggestModels } from '../services/model-catalog.js';
import { billedByMediaLength, formatPrice } from '../services/pricing-client.js';
import { formatUsd } from '../services/error-handler.js';
import { trackedLink } from '../services/utm.js';
import { READ_ONLY, errorResult, failure, ok } from './shared.js';
import { modelTitle } from './search-models.js';
import { referenceInputs } from '../services/model-capabilities.js';
function value(v) {
    return JSON.stringify(v);
}
export function describeParam(name, spec, indent = '') {
    const facts = [spec.type, spec.required ? 'required' : undefined].filter(Boolean);
    const details = [];
    if (spec.enum?.length)
        details.push(`one of ${spec.enum.map(value).join(', ')}`);
    if (spec.default !== undefined)
        details.push(`default ${value(spec.default)}`);
    if (spec.minimum !== undefined || spec.maximum !== undefined)
        details.push(`range ${spec.minimum ?? '…'}–${spec.maximum ?? '…'}`);
    if (spec.minItems !== undefined || spec.maxItems !== undefined)
        details.push(`${spec.minItems ?? 0}–${spec.maxItems ?? '…'} items`);
    if (spec.maxLength !== undefined)
        details.push(`up to ${spec.maxLength} characters`);
    if (spec.items?.enum?.length)
        details.push(`each one of ${spec.items.enum.map(value).join(', ')}`);
    if (spec.anyOf?.length)
        details.push(`one of ${spec.anyOf.map(option => option.enum ? option.enum.join(', ') : `${option.minimum ?? '…'}–${option.maximum ?? '…'}`).join(' or ')}`);
    const head = `${indent}- ${name}${facts.length ? ` (${facts.join(', ')})` : ''}${details.length ? `: ${details.join('; ')}` : ''}`;
    const lines = [spec.description ? `${head} — ${spec.description}` : head];
    for (const [child, childSpec] of Object.entries(spec.properties ?? spec.items?.properties ?? {})) {
        lines.push(...describeParam(child, childSpec, `${indent}  `));
    }
    return lines;
}
function priceLine(price) {
    const minimum = price.min_charge_usd !== undefined ? ` (minimum $${formatUsd(price.min_charge_usd)} per task)` : '';
    const factors = price.multipliers ? ` (resolution factors ${Object.entries(price.multipliers).map(([k, v]) => `${k} ×${v}`).join(', ')})` : '';
    return `${price.name}: ${formatPrice(price)}${minimum}${factors}`;
}
export function registerGetModel(server, config) {
    server.registerTool('get_model', {
        title: 'Get model parameters and pricing',
        description: [
            'Show what one model accepts and what it costs: every input parameter (required, allowed values, ranges, defaults), the published prices and an example input. Free.',
            'Read this before calling generate_image, generate_video or generate_audio, and quote the price to the user.',
        ].join(' '),
        inputSchema: {
            model: z.string().min(1).max(128).describe('Model ID from search_models, e.g. "seedance-2.0-text-to-video".'),
        },
        annotations: { title: 'Get model parameters and pricing', ...READ_ONLY },
    }, async ({ model }) => {
        try {
            const { catalog, entry } = await resolveModel(model, config);
            if (!entry) {
                const suggestions = suggestModels(catalog, model);
                return failure(`Unknown model "${model}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''} Use search_models to find model IDs.`, { error: { category: 'not_found', param: 'model' }, suggestions });
            }
            const { spec, priced } = entry;
            const title = modelTitle(entry);
            const lines = [`${entry.id} (${entry.kind})${title ? ` — ${title}` : ''}`, `Generate with: generate_${entry.kind}`];
            const structured = {
                model: entry.id,
                type: entry.kind,
                tool: `generate_${entry.kind}`,
            };
            if (spec) {
                const docs = trackedLink(spec.docs, 'model_docs');
                lines.push(`Docs: ${docs}`, '', 'Input parameters (pass them in input):');
                const names = Object.keys(spec.params).sort((a, b) => Number(!!spec.params[b].required) - Number(!!spec.params[a].required));
                for (const name of names)
                    lines.push(...describeParam(name, spec.params[name]));
                if (spec.example)
                    lines.push('', `Example input: ${JSON.stringify(spec.example)}`);
                if (spec.constraints?.mutuallyExclusive)
                    lines.push(...spec.constraints.mutuallyExclusive.map(group => `Input constraint: ${group.join(' and ')} are mutually exclusive.`));
                const sizeRule = spec.constraints?.imageSize;
                if (sizeRule)
                    lines.push(sizeRule.allowPixels
                        ? `Pixel size constraint: edges ${sizeRule.minEdge}–${sizeRule.maxEdge}, divisible by ${sizeRule.step}; ${sizeRule.minPixels}–${sizeRule.maxPixels} total pixels; aspect ratio at most ${sizeRule.maxRatio}:1.`
                        : `Size constraint: only auto or the documented ratios; explicit pixels are not supported. Ratio resolution: ${sizeRule.ratioResolution}.`);
                Object.assign(structured, {
                    endpoint: spec.path,
                    docs,
                    required: spec.required,
                    parameters: spec.params,
                    constraints: spec.constraints,
                    example_input: spec.example,
                    parameters_source: modelParamsMeta(),
                    input_schema: spec.inputSchema?.schema,
                    response_schema: spec.responseSchema?.schema,
                    schema_info: {
                        dialect: spec.inputSchema?.dialect,
                        unresolved_input_refs: spec.inputSchema?.unresolved_refs,
                        unresolved_response_refs: spec.responseSchema?.unresolved_refs,
                        response_scope: 'generation_submission_response_not_final_task_result',
                        omitted_fields: { input: ['model', 'callback_url'], response: ['task_info.can_cancel'] },
                        additional_runtime_constraints: spec.constraints,
                        source: modelParamsMeta(),
                        validation_scope: 'documented_schema_plus_runtime_constraints',
                        runtime_constraints_source: 'reviewed_gateway_supplements',
                    },
                    reference_inputs: referenceInputs(spec),
                });
                lines.push('Schemas are versioned official OpenAPI references. response_schema describes submission, not necessarily the final task output. Apply the additional runtime constraints above.');
            }
            else {
                lines.push('', 'Parameters for this model are not documented here; the gateway checks the input when you submit.');
            }
            lines.push('', 'Pricing (USD; 68 credits ≈ $1):');
            if (priced && priced.prices.length > 0) {
                const groups = [['output', 'Main charge'], ['add_on', 'Extra charges'], ['token', 'Usage-based']];
                for (const [role, label] of groups) {
                    const prices = priced.prices.filter(price => price.role === role);
                    if (prices.length === 0)
                        continue;
                    lines.push(`${label}:`);
                    for (const price of prices)
                        lines.push(`- ${priceLine(price)}`);
                }
                if (billedByMediaLength(priced, spec)) {
                    lines.push(spec?.constraints?.outputDuration === 'unknown'
                        ? 'This model bills the generated audio duration, which is unknown before it runs. There is no input.duration. media_seconds can illustrate the cost of an expected output length, but cannot establish a spending cap.'
                        : 'This model has no duration parameter: EvoLink measures the billed seconds when the task runs (usually the length of the input video or audio). For an estimate before generating, pass that length as media_seconds to estimate_cost.');
                    structured.billed_by_media_length = true;
                }
                else {
                    lines.push('Use estimate_cost with your input for a total before generating.');
                }
                structured.prices = priced.prices;
            }
            else {
                lines.push(catalog.pricingWarning ?? 'Pricing data is unavailable in this catalog.');
            }
            if (catalog.pricingWarning)
                structured.pricing_warning = catalog.pricingWarning;
            return ok(lines.join('\n'), structured);
        }
        catch (error) {
            return errorResult(error);
        }
    });
}
