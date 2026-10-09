// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
/** Published input fields are evidence of accepted references, not of visual quality. */
export function referenceInputs(spec) {
    if (!spec)
        return [];
    const result = [];
    for (const [parameter, value] of Object.entries(spec.params)) {
        let kind;
        if (/^(?:.*_)?image_urls?$|^(?:images|image|input_image|first_frame|last_frame)$/.test(parameter))
            kind = 'image';
        else if (/^(?:.*_)?video_urls?$|^videos$/.test(parameter))
            kind = 'video';
        else if (/^(?:.*_)?audio_urls?$|^audios$/.test(parameter))
            kind = 'audio';
        else if (parameter === 'source_task_id')
            kind = 'task';
        else if (parameter === 'voice_id' || parameter === 'persona_id')
            kind = 'resource';
        if (kind)
            result.push({ parameter, kind, required: !!value.required, multiple: value.type === 'array' });
    }
    return result;
}
