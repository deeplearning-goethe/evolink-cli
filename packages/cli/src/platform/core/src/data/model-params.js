// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { MODEL_PARAMS_JSON } from './model-params.generated.js';
import { withModelConstraints } from './model-constraints.js';
let index;
function load() {
    if (!index) {
        index = JSON.parse(MODEL_PARAMS_JSON);
        for (const model of Object.values(index.models))
            withModelConstraints(model);
    }
    return index;
}
export function modelParamsMeta() {
    return load().meta;
}
export function allModelParams() {
    return Object.values(load().models);
}
/** Exact model ID first, then a case-insensitive match. */
export function findModelParams(model) {
    const models = load().models;
    const trimmed = model.trim();
    if (models[trimmed])
        return models[trimmed];
    const lower = trimmed.toLowerCase();
    return Object.values(models).find(entry => entry.model.toLowerCase() === lower);
}
