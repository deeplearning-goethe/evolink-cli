// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { controlBaseURL } from './pricing-client.js';
import { DEFAULT_READ_TIMEOUT_MS, evoHeaders, fetchWithTimeout, readJsonBody, timeoutFromEnv } from './http-policy.js';
const catalogs = new Map();
const healths = new Map();
async function read(path) {
    const response = await fetchWithTimeout(`${controlBaseURL()}${path}`, {
        method: 'GET', headers: { Accept: 'application/json', ...evoHeaders('model_catalog') },
    }, timeoutFromEnv('EVOLINK_MCP_READ_TIMEOUT_MS', DEFAULT_READ_TIMEOUT_MS));
    const body = await readJsonBody(response);
    if (!response.ok || !Array.isArray(body.models))
        throw new Error('The current model catalog is unavailable; try again before selecting or submitting a model.');
    return body;
}
export async function currentModels() {
    const now = Date.now();
    const key = controlBaseURL();
    const catalog = catalogs.get(key), health = healths.get(key);
    const [models, available] = await Promise.all([
        (async () => {
            if (catalog && now - catalog.fetchedAt < 5 * 60_000)
                return catalog.models;
            const body = await read('/v1/catalog/models');
            const models = body.models.filter(model => typeof model.model_id === 'string'
                && Array.isArray(model.aliases) && Array.isArray(model.capabilities) && Array.isArray(model.protocols));
            catalogs.set(key, { models, fetchedAt: now });
            return models;
        })(),
        (async () => {
            if (health && now - health.fetchedAt < 30_000)
                return health.available;
            const body = await read('/v1/catalog/health');
            const available = new Set(body.models
                .filter(model => typeof model.model_id === 'string' && model.status === 'available').map(model => model.model_id.toLowerCase()));
            healths.set(key, { available, fetchedAt: now });
            return available;
        })(),
    ]);
    return { models, available };
}
export function resetCatalogCacheForTests() {
    catalogs.clear();
    healths.clear();
}
