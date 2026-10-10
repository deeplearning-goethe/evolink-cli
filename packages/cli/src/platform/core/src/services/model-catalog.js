// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { findModelParams } from '../data/model-params.js';
import { currentRequestCredentials } from '../request-context.js';
import { getAvailableModelIds } from './api-client.js';
import { currentModels } from './catalog-client.js';
import { closestMatches } from './param-validator.js';
import { getPricing } from './pricing-client.js';
function isMediaKind(value) {
    return value === 'image' || value === 'video' || value === 'audio';
}
/** Live available IDs are authoritative; their published aliases join documentation and prices. */
export async function loadCatalog(config, pricingOptions = {}) {
    const live = await currentModels();
    // /v1/models is credential-specific. OAuth currently allows only media/task/credit
    // routes, so its catalog uses public health (enabled abilities/channels), not a rejected call.
    let allowed;
    if (config && !currentRequestCredentials()?.serviceChannel) {
        allowed = new Set((await getAvailableModelIds(config)).map(id => id.toLowerCase()));
    }
    const entries = new Map();
    for (const model of live.models) {
        if (model.lifecycle === 'retired' || !live.available.has(model.model_id.toLowerCase()))
            continue;
        const names = [model.model_id, ...model.aliases];
        if (allowed && !names.some(name => allowed.has(name.toLowerCase())))
            continue;
        const spec = names.map(findModelParams).find(Boolean);
        const kind = model.capabilities.find(isMediaKind);
        if (!kind || (spec && spec.kind !== kind))
            continue;
        const protocol = { image: 'openai-images', video: 'evolink-video-generations', audio: 'openai-audio' }[kind];
        if (!spec && !model.protocols.includes(protocol))
            continue;
        entries.set(model.model_id, { id: model.model_id, kind, aliases: model.aliases, title: model.display_name,
            ...(spec ? { spec: { ...spec, model: model.model_id } } : {}) });
    }
    if (pricingOptions.skipPricing)
        return { entries: [...entries.values()] };
    let pricingWarning;
    try {
        const pricing = await getPricing(pricingOptions);
        if (pricing.source === 'stale-cache')
            pricingWarning = 'Prices could not be refreshed; showing the last known prices.';
        for (const entry of entries.values()) {
            const prices = [entry.id, ...(entry.aliases ?? [])].flatMap(name => [...pricing.models.values()].filter(price => price.id.toLowerCase() === name.toLowerCase()));
            if (prices.length)
                entry.priced = { ...prices[0], id: entry.id, pricingIncomplete: prices.some(model => model.pricingIncomplete), prices: [...new Map(prices.flatMap(model => model.prices).map(price => [price.sku_id, price])).values()] };
        }
    }
    catch (error) {
        pricingWarning = `Prices are unavailable right now (${error instanceof Error ? error.message : 'unknown error'}).`;
    }
    return { entries: [...entries.values()], pricingWarning };
}
export function findEntry(catalog, id) {
    const lower = id.trim().toLowerCase();
    return catalog.entries.find(entry => entry.id.toLowerCase() === lower)
        ?? catalog.entries.find(entry => entry.aliases?.some(alias => alias.toLowerCase() === lower));
}
export function suggestModels(catalog, id, kind) {
    const pool = catalog.entries.filter(entry => !kind || entry.kind === kind).map(entry => entry.id);
    return closestMatches(id, pool, 5);
}
/** Looks a model up for one request; prices are best effort. */
export async function resolveModel(id, config, pricingOptions = {}) {
    const catalog = await loadCatalog(config, pricingOptions);
    const entry = findEntry(catalog, id);
    return { catalog, entry };
}
