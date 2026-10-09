// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { modelParamsMeta } from '../data/model-params.js';
import { loadCatalog } from '../services/model-catalog.js';
import { referenceInputs } from '../services/model-capabilities.js';
import { modelPreference } from '../services/model-recommendations.js';
import { startingPrice } from '../services/pricing-client.js';
import { trackedLink } from '../services/utm.js';
import { modelTitle, scoreModel } from './search-models.js';
import { READ_ONLY, errorResult, ok } from './shared.js';
export function registerDiscovery(server, config) {
    server.registerTool('recommend_models', {
        title: 'Compare suitable models',
        description: 'Find available documented models by output type, optional search keywords and required reference media. Returns alternatives and explicit selection reasons. Platform preferences are editorial, not a quality, popularity or release-date ranking. Starting unit prices are not task totals or budget guarantees. Read get_model and estimate_cost before any paid generation.',
        inputSchema: {
            type: z.enum(['image', 'video', 'audio']),
            query: z.string().max(100).optional().describe('Search keywords, not a full generation prompt; every term must match.'),
            references: z.array(z.enum(['image', 'video', 'audio'])).max(3).default([]).describe('Reference kinds that must have documented input fields.'),
            limit: z.number().int().min(1).max(10).default(3),
        },
        annotations: { title: 'Compare suitable models', ...READ_ONLY },
    }, async ({ type, query, references, limit }) => {
        try {
            const catalog = await loadCatalog(config);
            const terms = (query ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
            const candidates = catalog.entries.filter(entry => entry.kind === type && entry.spec)
                .map(entry => ({ entry, score: scoreModel(entry, terms), fields: referenceInputs(entry.spec), preference: modelPreference(entry) }))
                .filter(item => item.score !== undefined && references.every(kind => item.fields.some(field => field.kind === kind)))
                .sort((a, b) => b.score - a.score || (a.preference?.priority ?? Infinity) - (b.preference?.priority ?? Infinity) || a.entry.id.localeCompare(b.entry.id));
            const models = candidates.slice(0, limit).map(({ entry, fields, preference, score }) => ({
                model: entry.id, type: entry.kind, title: modelTitle(entry), reference_inputs: fields,
                reasons: ['Currently available in this catalog', 'Input parameters documented',
                    ...(references.length ? [`Documented reference inputs for: ${references.join(', ')}`] : []),
                    ...(preference ? [`Platform preference for ${preference.use_case}`] : [])],
                selection: { keyword_score: score, platform_preference: preference?.basis },
                starting_price: entry.priced ? startingPrice(entry.priced) : undefined,
                docs: trackedLink(entry.spec.docs, 'model_docs'),
            }));
            const next = models.length ? 'Compare parameters with get_model, then estimate_cost using the actual input. Ask for approval before generating.'
                : 'No documented model met all filters. Try broader keywords with search_models; do not silently drop a required reference kind.';
            return ok([`${models.length} alternatives (${candidates.length} suitable documented models).`,
                ...models.map(model => `- ${model.model}: ${model.reasons.join('; ')}`), next].join('\n'), {
                models, total_matches: candidates.length, selection_basis: 'documented_inputs_keyword_match_platform_preference',
                parameters_source: modelParamsMeta(), unit_prices_are_task_quotes: false, next_step: next,
                ...(catalog.pricingWarning ? { pricing_warning: catalog.pricingWarning } : {}),
            });
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool('search_docs', {
        title: 'Search model reference documentation',
        description: 'Search bundled official model reference titles, IDs and parameter descriptions for currently available models. Free. Returns source commit, matching parameter excerpts and official links. This is a versioned reference index, not a live full-site crawl or account/billing documentation search.',
        inputSchema: {
            query: z.string().trim().min(1).max(100),
            type: z.enum(['image', 'video', 'audio', 'all']).default('all'),
            limit: z.number().int().min(1).max(20).default(5),
        },
        annotations: { title: 'Search model reference documentation', ...READ_ONLY },
    }, async ({ query, type, limit }) => {
        try {
            const catalog = await loadCatalog(config);
            const terms = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
            const hits = catalog.entries.filter(entry => entry.spec && (type === 'all' || type === entry.kind))
                .map(entry => {
                const parameters = Object.entries(entry.spec.params);
                const text = [entry.id, ...(entry.aliases ?? []), entry.spec.title, ...parameters.flatMap(([name, value]) => [name, value.description ?? ''])].join(' ').toLowerCase();
                const matched = parameters.filter(([name, value]) => terms.some(term => `${name} ${value.description ?? ''}`.toLowerCase().includes(term)));
                return { entry, matches: terms.every(term => text.includes(term)), matched };
            }).filter(item => item.matches).sort((a, b) => b.matched.length - a.matched.length || a.entry.id.localeCompare(b.entry.id));
            const documents = hits.slice(0, limit).map(({ entry, matched }) => ({
                model: entry.id, title: entry.spec.title, url: trackedLink(entry.spec.docs, 'model_docs'),
                excerpts: matched.slice(0, 5).map(([parameter, value]) => ({ parameter, text: (value.description ?? `Documented ${parameter} parameter`).slice(0, 300) })),
            }));
            return ok([`${hits.length} model references match "${query}".`, ...documents.map(doc => `- ${doc.model}: ${doc.url}`),
                'Use get_model for parameters and schema. References are bundled at the reported source commit.'].join('\n'), {
                documents, total_matches: hits.length, scope: 'available_model_reference_index', source: modelParamsMeta(),
            });
        }
        catch (error) {
            return errorResult(error);
        }
    });
}
