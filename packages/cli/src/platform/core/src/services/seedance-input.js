// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
const GENERATION_MODELS = new Set([
    'seedance-2.5-text-to-video',
    'seedance-2.5-image-to-video',
    'seedance-2.5-reference-to-video',
    'seedance-2.5-video-edit',
    'seedance-2.5-video-extend',
]);
/** Match the resolved catalog identity, never a borrowed documentation alias. */
export function isSeedanceGeneration(entry) {
    return entry.id !== undefined && GENERATION_MODELS.has(entry.id)
        && entry.kind === 'video' && entry.spec?.path === '/v1/videos/generations';
}
export function isSeedanceSearch(entry) {
    return isSeedanceGeneration(entry) && entry.id === 'seedance-2.5-text-to-video';
}
export function seedanceSearchEnabled(entry, input) {
    const params = input.model_params;
    return isSeedanceSearch(entry) && !!params && typeof params === 'object' && !Array.isArray(params)
        && params.web_search === true;
}
/** Only reviewed gateway checks are blocking. Documentation-only differences warn. */
export function prepareSeedanceInput(entry, input) {
    const applies = isSeedanceGeneration(entry);
    const errors = [], warnings = [];
    const defaults = [];
    if (!applies)
        return { applies, input, errors, warnings, defaults };
    // Do not mutate the shared catalog spec, caller input, or nested references.
    const effective = { ...input };
    const params = input.model_params && typeof input.model_params === 'object' && !Array.isArray(input.model_params)
        ? input.model_params : undefined;
    if (input.web_search !== undefined)
        errors.push({ param: 'web_search', problem: 'must be provided as model_params.web_search for this model.' });
    if (params?.draft !== undefined)
        errors.push({ param: 'model_params.draft', problem: 'must be provided as the top-level draft field.' });
    if (params?.web_search !== undefined && typeof params.web_search !== 'boolean') {
        errors.push({ param: 'model_params.web_search', problem: 'must be a boolean.' });
    }
    if (input.draft === true) {
        if (input.quality === undefined) {
            effective.quality = '480p';
            defaults.push({ param: 'quality', value: '480p', reason: 'draft=true requires 480p' });
        }
        else if (input.quality !== '480p') {
            errors.push({ param: 'quality', problem: 'must be 480p when draft is true; omit quality to use the 480p draft default.' });
        }
    }
    if (typeof input.duration === 'number' && (input.duration === 0 || input.duration < -1)) {
        errors.push({ param: 'duration', problem: 'must be an integer between 4 and 30 seconds, or -1 for automatic duration.' });
    }
    else if (entry.id !== 'seedance-2.5-video-edit' && typeof input.duration === 'number' && Number.isInteger(input.duration)
        && input.duration !== -1 && (input.duration < 4 || input.duration > 30)) {
        warnings.push({ param: 'duration', problem: 'is outside the documented 4–30 seconds or -1; acceptance by the service has not been verified.' });
    }
    if (seedanceSearchEnabled(entry, input) && input.content_filter === false) {
        warnings.push({ param: 'content_filter', problem: 'false with model_params.web_search=true is documented as unsupported; service acceptance has not been verified.' });
    }
    return { applies, input: effective, errors, warnings, defaults };
}
/** A fresh object for the resolved model; never augment the shared docs index. */
export function seedanceInputRules(entry) {
    if (!isSeedanceGeneration(entry))
        return undefined;
    return {
        model: entry.id, endpoint: entry.spec.path,
        conditional_defaults: [{ when: { draft: true }, parameter: 'quality', value: '480p' }],
        blocking: ['draft=true requires quality=480p or omitted', 'duration=0 and duration<-1 are rejected',
            'draft must be top-level', 'model_params.web_search must be boolean when provided'],
        warnings_only: ['Other unverified duration boundaries and search/content_filter combinations do not add blocking checks.'],
        ...(entry.id === 'seedance-2.5-video-edit' ? { duration_usage: 'duration=-1 selects video editing; supply expected output seconds separately as pricing_parameters.duration_seconds, not as input.duration.' } : {}),
        ...(isSeedanceSearch(entry) ? { search_usage: 'model_params.web_search=true requires expected search_count for a complete estimate; missing usage is not zero.' } : {}),
    };
}
