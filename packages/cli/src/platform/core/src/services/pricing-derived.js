// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
// Rule parameters the gateway derives from differently named request fields. Each mapping mirrors the gateway's
// pre-deduction code (GroAPI feat/task-microservice-split); without it the published default quotes the cheaper case.
const proTiers = { '1K': '1K', '1.5K': '1.5K', '2K': '2K' };
const proTier = (value) => typeof value === 'string' ? proTiers[value.trim().toUpperCase()] : undefined;
// service/multi_sku_billing_service.go seedDreamProOutputTierThresholdPixels. Every 1K and 1.5K ratio preset is
// below it and every 2K preset above it, so a ratio follows quality.
const SEEDREAM_PRO_2K_PIXELS = 2_610_000;
/** controller preprocessSeedream5ProParams, then service ResolveSeedDreamProOutput. */
function seedreamProTier(input) {
    const size = typeof input.size === 'string' ? input.size.trim() : '';
    if (size === '' || size === 'auto' || size.includes(':'))
        return proTier(input.quality) ?? '1K';
    const named = proTier(size);
    if (named)
        return named;
    const pixels = /^(\d+)\s*x\s*(\d+)$/.exec(size.toLowerCase().replace(/\u00d7/g, 'x'));
    return pixels && Number(pixels[1]) * Number(pixels[2]) > SEEDREAM_PRO_2K_PIXELS ? '2K' : '1K';
}
/** service/minimax_h3_models.go MiniMaxH3CountInputImages: first frame, last frame and references all count. */
function inputImageCount(input) {
    const filled = (value) => typeof value === 'string' && value.trim() !== '';
    return ['image_start', 'image_end'].filter(key => filled(input[key])).length
        + (Array.isArray(input.image_urls) ? input.image_urls.filter(filled).length : 0);
}
const derived = {
    'doubao-seedream-5.0-pro output_images_2k': input => seedreamProTier(input) === '2K' ? 1 : 0,
    'doubao-seedream-5.0-pro output_images_standard': input => seedreamProTier(input) === '2K' ? 0 : 1,
    'minimax-h3-reference-to-video image_count': inputImageCount,
    'minimax-h3-max-reference-to-video image_count': inputImageCount,
    // service/tencent_video_upscale.go: the output keeps the source frame rate up to max_fps (120 when unset),
    // so only a 30 fps cap fixes the price tier before the source is measured.
    'tencent-video-upscale output_fps': (_input, modelParams) => String(modelParams.max_fps).trim() === '30' ? 30 : undefined,
};
/** Keys ("model parameter") the generation input decides; a different pricing_parameters value conflicts. */
export const DERIVED_QUOTE_PARAMETERS = new Set(Object.keys(derived));
export function derivedQuoteParameter(model, name, input, modelParams) {
    return derived[`${model.toLowerCase()} ${name}`]?.(input, modelParams);
}
/** Settings the generation input cannot carry: without measured usage the higher-priced value is quoted. */
export const CONSERVATIVE_QUOTE_PARAMETERS = {
    // controller/unified_videos.go rejects content_filter on a draft conversion; the draft's own setting is kept.
    'seedance-2.5-draft-to-video content_filter': { value: false,
        note: 'Assumes the source draft was generated without the content filter (10% more); if it kept the default content_filter=true, pass pricing_parameters.content_filter=true.' },
};
/** Usage the request cannot state: quoting it needs pricing_parameters unless a mapping above fixes it. */
export function derivedUsage(model, name) {
    return model.toLowerCase() === 'tencent-video-upscale' && name === 'output_fps';
}
