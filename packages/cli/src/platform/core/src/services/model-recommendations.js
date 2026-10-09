// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { startingPrice } from './pricing-client.js';
/** Editorial platform preferences, not measured popularity or a quality ranking.
 * Only live catalog entries with documented inputs and published rates qualify.
 * Specialized editing routes remain searchable without a general-generation boost.
 */
const PREFERENCES = [
    { kind: 'image', pattern: /^gpt-image-2\.5-(flare|sunburst)$/, family: 'gpt-image-2.5', useCase: 'image_generation' },
    { kind: 'image', pattern: /^gpt-image-2$/, family: 'gpt-image-2', useCase: 'image_generation' },
    { kind: 'image', pattern: /^doubao-seedream-5\.0-(flash|lite|pro)$/, family: 'seedream-5.0', useCase: 'image_generation' },
    { kind: 'video', pattern: /^seedance-2\.5-(text|image|reference)-to-video$/, family: 'seedance-2.5', useCase: 'video_generation' },
    { kind: 'video', pattern: /^seedance-2\.0-(?:(fast|mini)-)?(text|image|reference)-to-video$/, family: 'seedance-2.0', useCase: 'video_generation' },
    { kind: 'video', pattern: /^wan3\.0-(?:prime-)?(text-to-video|image-to-video|reference-video)$/, family: 'wan3.0', useCase: 'video_generation' },
    { kind: 'audio', pattern: /^suno-v6(?:-(mini|wild))?$/, family: 'suno-v6', useCase: 'music' },
];
export function modelPreference(entry) {
    if (!entry.spec || !entry.priced || !startingPrice(entry.priced))
        return undefined;
    const priority = PREFERENCES.findIndex(item => item.kind === entry.kind && item.pattern.test(entry.id));
    if (priority < 0)
        return undefined;
    const item = PREFERENCES[priority];
    return { priority, basis: 'platform_preference', family: item.family, use_case: item.useCase };
}
export const MODEL_SELECTION_GUIDANCE = [
    'Respect the user\'s explicit model/provider choice, required capabilities and budget before platform preferences.',
    'For an unspecified model, consider available GPT Image 2.5/2 and Seedream 5.0 for images, Seedance 2.5/2.0 and Wan 3.0 for videos, and Suno v6 for music.',
    'Use speech models for narration/TTS; Suno is a music preference, not a speech default.',
    'Search the preferred families with search_models, then compare suitable candidates with get_model for reference inputs, output settings and billing; choose the correct text/image/reference/edit route.',
    'Explain briefly why the chosen model fits. Fall back to other available models when preferences do not fit the task or budget.',
    'Search order and platform_preference labels are editorial discovery hints, not measured popularity, release dates, quality rankings or the total task cost.',
    'Do not automatically select the first result or a Beta model. Prefer a suitable non-Beta route when comparable, and explain why if choosing Beta.',
    'Do not invent model IDs, availability, release dates, parameters or prices; missing documentation or rates must be resolved or disclosed before proposing a paid call.',
].join(' ');
