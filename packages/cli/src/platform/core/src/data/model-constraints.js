// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { searchUsage } from '../services/search-usage.js';
/** Reviewed structured supplements for constraints still described only in OpenAPI prose.
 * Sources: GroAPI unified_videos_validation.go / common/gpt_image2_token.go,
 * and mintlify-docs en/api-manual/audio-series/doubao-seed-audio/*.json.
 * Kept outside generated data so rebuilding the docs index cannot erase them.
 */
export function withModelConstraints(model) {
    const searches = searchUsage({ id: model.model, kind: model.kind, spec: model }, {});
    if (searches.length) {
        const nested = model.params.model_params?.properties;
        for (const search of searches) {
            const key = search.role;
            if (nested?.[key])
                nested[key] = { ...nested[key], default: false,
                    description: `${nested[key].description ?? ''} Defaults to false. When enabled, actual searches are billed separately; one task may perform multiple searches.`.trim() };
        }
        // Default examples must not opt the caller into search. Keep explicit search examples in the docs.
        if (model.example?.model_params && typeof model.example.model_params === 'object') {
            const params = { ...model.example.model_params };
            delete params.web_search;
            delete params.image_search;
            if (Array.isArray(params.tools)) {
                params.tools = params.tools.filter(tool => !(tool && typeof tool === 'object' && tool.type === 'web_search'));
                if (!params.tools.length)
                    delete params.tools;
            }
            model.example = { ...model.example };
            if (Object.keys(params).length)
                model.example.model_params = params;
            else
                delete model.example.model_params;
        }
    }
    if (/^wan3\.0-(?:prime-)?(?:text-to-video|image-to-video|reference-video)$/.test(model.model)) {
        model.params.duration = { ...model.params.duration, anyOf: [
                { type: 'integer', minimum: 2, maximum: 30 }, { type: 'integer', enum: [-1] },
            ] };
        const properties = model.inputSchema?.schema.properties;
        if (properties)
            properties.duration = { type: 'integer', anyOf: model.params.duration.anyOf, description: model.params.duration.description, default: model.params.duration.default };
    }
    // mintlify-docs kling-v4-video-edit.json: duration is 3-30 seconds or "auto" (as long as the input video);
    // the generated index keeps the range but leaves any string open.
    if (model.model === 'kling-v4-video-edit') {
        const anyOf = [{ type: 'integer', minimum: 3, maximum: 30 }, { type: 'string', enum: ['auto'] }];
        model.params.duration = { ...model.params.duration, anyOf };
        const properties = model.inputSchema?.schema.properties;
        if (properties)
            properties.duration = { anyOf, description: model.params.duration.description, default: model.params.duration.default };
    }
    if (['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2-beta'].includes(model.model)) {
        model.constraints = { ...model.constraints, imageSize: {
                param: 'size', allowed: ['auto', '1:1', '1:2', '2:1', '1:3', '3:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '9:21', '21:9'],
                allowPixels: model.model !== 'gpt-image-2-beta', step: 16, minEdge: 16, maxEdge: 3840,
                minPixels: 655360, maxPixels: 8294400, maxRatio: 3,
                ...(model.model === 'gpt-image-2-beta' ? { ratioResolution: '1K' } : {}),
            } };
        const properties = model.inputSchema?.schema.properties;
        if (properties)
            properties.size = { type: 'string', anyOf: [
                    { enum: model.constraints.imageSize.allowed },
                    ...(model.constraints.imageSize.allowPixels ? [{ pattern: '^\\d+[x×]\\d+$' }] : []),
                ], default: model.params.size?.default, description: model.params.size?.description, 'x-evolink-image-size': model.constraints.imageSize };
    }
    if (model.model === 'doubao-seed-audio-1-0') {
        model.constraints = { ...model.constraints, outputDuration: 'unknown', mutuallyExclusive: [['audio_references', 'image_urls']] };
        if (model.inputSchema)
            model.inputSchema.schema['x-evolink-mutually-exclusive'] = model.constraints.mutuallyExclusive;
    }
    return model;
}
