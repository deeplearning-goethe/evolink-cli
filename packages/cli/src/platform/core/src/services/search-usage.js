// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
/** Reviewed media contracts only; a pricing role alone does not prove search support. */
export function searchUsage(entry, input) {
    const image = entry.kind === 'image' && entry.spec?.path === '/v1/images/generations';
    const video = entry.kind === 'video' && entry.spec?.path === '/v1/videos/generations';
    const seedream = image && entry.id === 'doubao-seedream-5.0-lite';
    const gemini = image && ['gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview', 'gemini-nano-banana-2.1'].includes(entry.id ?? '');
    const seedance = video && ['seedance-2.0-text-to-video', 'seedance-2.0-fast-text-to-video', 'seedance-2.5-text-to-video'].includes(entry.id ?? '');
    if (!seedream && !gemini && !seedance)
        return [];
    const params = input.model_params && typeof input.model_params === 'object' && !Array.isArray(input.model_params)
        ? input.model_params : {};
    const web = seedream ? Array.isArray(params.tools) && params.tools.some(tool => tool && typeof tool === 'object'
        && !Array.isArray(tool) && tool.type === 'web_search') : params.web_search === true;
    const result = [{ role: 'web_search', parameter: 'search_count',
            input_parameter: seedream ? 'model_params.tools' : 'model_params.web_search', enabled: web }];
    if (gemini && entry.id !== 'gemini-3-pro-image-preview')
        result.push({ role: 'image_search', parameter: 'image_search_count',
            input_parameter: 'model_params.image_search', enabled: params.image_search === true });
    return result;
}
