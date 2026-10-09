// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { loadCatalog } from '../services/model-catalog.js';
import { formatPrice, startingPrice } from '../services/pricing-client.js';
import { trackedLink } from '../services/utm.js';
import { MODEL_SELECTION_GUIDANCE, modelPreference } from '../services/model-recommendations.js';
import { referenceInputs } from '../services/model-capabilities.js';
import { READ_ONLY, errorResult, ok } from './shared.js';
export function modelTitle(entry) {
    const title = entry.spec?.title?.replace(/\s+(interface|api)$/i, '').trim();
    return title || entry.title || entry.priced?.description?.slice(0, 120) || undefined;
}
/** Every term must appear somewhere; matches in the model ID count most. */
export function scoreModel(entry, terms) {
    if (terms.length === 0)
        return 0;
    const id = entry.id.toLowerCase();
    const normalizedId = [id, ...(entry.aliases ?? [])].map(value => value.toLowerCase().replace(/[.\-_\s]/g, ''));
    const haystack = [id, modelTitle(entry), entry.priced?.description, entry.priced?.vendor, entry.kind]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    let total = 0;
    for (const term of terms) {
        const normalized = term.replace(/[.\-_]/g, '');
        if (id === term)
            total += 10;
        else if (id.startsWith(term))
            total += 6;
        else if (id.includes(term))
            total += 4;
        else if (normalized && normalizedId.some(value => value.includes(normalized)))
            total += 3;
        else if (haystack.includes(term))
            total += 1;
        else
            return undefined;
    }
    return total;
}
export function registerSearchModels(server, config) {
    server.registerTool('search_models', {
        title: 'Search models',
        description: [
            'Find EvoLink image, video and audio models by type and keywords. Free.',
            'Returns model IDs with a starting price; call get_model for a model\'s parameters and full pricing before generating.',
            'Prices are in USD (68 credits ≈ $1).',
            MODEL_SELECTION_GUIDANCE,
        ].join(' '),
        inputSchema: {
            type: z.enum(['image', 'video', 'audio', 'all']).default('all').describe('Kind of output to look for.'),
            query: z.string().max(100).optional().describe('Keywords, e.g. "seedance", "image-to-video", "kling", "music".'),
            limit: z.number().int().min(1).max(50).default(20).describe('Maximum number of models to return (1–50, default 20).'),
            page: z.number().int().min(1).max(100_000).default(1).describe('Page number for this search (default 1); live availability may change between pages.'),
        },
        annotations: { title: 'Search models', ...READ_ONLY },
    }, async ({ type, query, limit, page }) => {
        try {
            const catalog = await loadCatalog(config);
            const terms = (query ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
            const matches = catalog.entries
                .filter(entry => type === 'all' || entry.kind === type)
                .map(entry => ({ entry, score: scoreModel(entry, terms), start: entry.priced ? startingPrice(entry.priced) : undefined, preference: modelPreference(entry) }))
                .filter((item) => item.score !== undefined)
                .sort((a, b) => b.score - a.score || Number(!!b.start) - Number(!!a.start)
                || (a.preference?.priority ?? Infinity) - (b.preference?.priority ?? Infinity)
                || a.entry.id.localeCompare(b.entry.id));
            const shown = matches.slice((page - 1) * limit, page * limit);
            const models = shown.map(({ entry, start, preference }) => ({
                id: entry.id,
                aliases: entry.aliases,
                type: entry.kind,
                title: modelTitle(entry),
                from_usd: start?.min_usd,
                from_unit: start?.unit,
                parameters_documented: !!entry.spec,
                reference_inputs: referenceInputs(entry.spec),
                docs: entry.spec ? trackedLink(entry.spec.docs, 'model_docs') : undefined,
                ...(preference ? { recommendation: { basis: preference.basis, family: preference.family, use_case: preference.use_case } } : {}),
            }));
            const lines = [
                `${matches.length} model${matches.length === 1 ? '' : 's'} match${terms.length ? ` "${query}"` : ''}${type !== 'all' ? ` (${type})` : ''}${matches.length > shown.length ? `; showing ${shown.length}` : ''}:`,
                ...shown.map(({ entry, start, preference }) => {
                    const parts = [`- ${entry.id} [${entry.kind}]`];
                    const title = modelTitle(entry);
                    if (title)
                        parts.push(title);
                    parts.push(start ? `from ${formatPrice(start)}` : 'pricing data unavailable in this catalog');
                    if (!entry.spec)
                        parts.push('parameters not documented');
                    if (preference)
                        parts.push(`platform preference for ${preference.use_case}`);
                    return parts.join(' · ');
                }),
            ];
            if (matches.length === 0)
                lines.push('No model matched. Try fewer or broader keywords, or type "all".');
            else
                lines.push('', 'Next: compare suitable models with get_model. Keyword relevance comes first; platform preferences break ties after price availability. Search order is not a quality or popularity ranking, and a unit starting price is not the task total.');
            if (catalog.pricingWarning)
                lines.push(`Note: ${catalog.pricingWarning}`);
            return ok(lines.join('\n'), {
                models,
                total_matches: matches.length,
                page, page_size: limit, next_page: page * limit < matches.length ? page + 1 : null,
                availability_source: 'live_catalog_and_health', ordering: 'keyword_relevance_then_price_availability_then_platform_preference_then_id',
                ...(catalog.pricingWarning ? { pricing_warning: catalog.pricingWarning } : {}),
            });
        }
        catch (error) {
            return errorResult(error);
        }
    });
}
