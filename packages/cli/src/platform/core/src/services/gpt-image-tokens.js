// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { QuoteError } from './pricing-quote-client.js';
// The tokens the gateway reserves for a GPT Image task at submission. Ported from GroAPI (feat/task-microservice-split)
// common/gpt_image2_token.go and the token image pre-charge in controller/unified_images.go. The output token
// calculator is the one on OpenAI's image generation guide; its floating-point steps keep the same order, so every count
// matches the gateway's. The task itself settles at the tokens the upstream reports.
const STEP = 16, MIN_PIXELS = 655_360, MAX_PIXELS = 8_294_400, MAX_EDGE = 3840, MAX_RATIO = 3;
const RATIOS = { '1:1': [1, 1], '1:2': [1, 2], '2:1': [2, 1], '1:3': [1, 3], '3:1': [3, 1],
    '2:3': [2, 3], '3:2': [3, 2], '3:4': [3, 4], '4:3': [4, 3], '4:5': [4, 5], '5:4': [5, 4], '9:16': [9, 16], '16:9': [16, 9],
    '21:9': [21, 9], '9:21': [9, 21] };
/** Pixel budget of each resolution tier for a ratio size. */
const BUDGETS = { '1K': 1024 * 1024, '2K': 2048 * 2048, '4K': MAX_PIXELS };
/** Long-edge tile base by quality: gpt-image-2, and the 2.5 family, whose tiers sit lower. */
const BASE_2 = { low: 16, medium: 48, high: 96 };
const BASE_25 = { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 };
/** gpt-image-1 and 1.5 bill fixed tiles by quality: portrait, landscape, square. */
const TILES_1 = { low: [408, 400, 272], medium: [1584, 1568, 1056], high: [6240, 6208, 4160] };
/** Reserved for each reference image or mask: the most a 1024² input has used. Larger inputs can use more. */
export const INPUT_IMAGE_TOKENS = 1536;
const family25 = (model) => model.trim().toLowerCase().startsWith('gpt-image-2.5');
const family1 = (model) => model === 'gpt-image-1.5' || model === 'gpt-image-1';
/** Models the gateway reserves and bills by token counts. */
export const isTokenImageModel = (model) => model === 'gpt-image-2' || family1(model) || family25(model);
function invalid(param, message) { throw new QuoteError('invalid_quote_parameter', message, param); }
const text = (param, value) => value === undefined ? '' : typeof value === 'string' ? value : invalid(param, `${param} must be a string.`);
/** strconv.Atoi for the sizes the gateway reads; a longer number is not a size it can accept. */
const integer = (part) => /^[+-]?\d{1,15}$/.test(part) ? Number(part) : NaN;
function pixelSize(size) {
    if (size === '')
        return undefined;
    const lower = size.toLowerCase();
    for (const separator of ['x', '×']) {
        const at = lower.indexOf(separator);
        if (at < 0)
            continue;
        const width = integer(lower.slice(0, at).trim()), height = integer(lower.slice(at + separator.length).trim());
        if (width > 0 && height > 0)
            return [width, height];
    }
    return undefined;
}
function checkPixels(width, height) {
    const longer = Math.max(width, height), shorter = Math.min(width, height), pixels = width * height;
    if (width % STEP || height % STEP || pixels > MAX_PIXELS || pixels < MIN_PIXELS || longer > MAX_EDGE || longer > MAX_RATIO * shorter) {
        invalid('size', `size ${width}x${height} needs edges that are multiples of ${STEP}, ${MIN_PIXELS}–${MAX_PIXELS} pixels, an edge of at most ${MAX_EDGE} and an aspect ratio of at most ${MAX_RATIO}:1.`);
    }
}
const roundToStep = (n) => n < STEP ? STEP : Math.trunc((n + STEP / 2) / STEP) * STEP;
const floorToStep = (n) => n < STEP ? STEP : Math.trunc(n / STEP) * STEP;
/** Scales a ratio size into the pixel and edge limits, keeping its aspect ratio. */
function fitBudget(width, height) {
    const pixels = width * height, edge = Math.max(width, height);
    if (pixels <= MAX_PIXELS && edge <= MAX_EDGE)
        return [width, height];
    let scale = 1;
    if (pixels > MAX_PIXELS)
        scale = Math.min(scale, Math.sqrt(MAX_PIXELS / pixels));
    if (edge > MAX_EDGE)
        scale = Math.min(scale, MAX_EDGE / edge);
    // Nearest multiple of 16 first (2:1 at 4K is 3840×1920); rounding down only when that leaves the limits.
    const near = [roundToStep(Math.round(width * scale)), roundToStep(Math.round(height * scale))];
    return near[0] * near[1] > MAX_PIXELS || Math.max(...near) > MAX_EDGE
        ? [floorToStep(Math.trunc(width * scale)), floorToStep(Math.trunc(height * scale))] : near;
}
/** ResolveGPTImage2Size: explicit pixels as given; a ratio fitted to the resolution's pixel budget. */
function outputSize(size, resolution) {
    const trimmed = size.trim(), pixels = pixelSize(trimmed);
    if (pixels) {
        checkPixels(...pixels);
        return pixels;
    }
    const ratio = ['', 'auto'].includes(trimmed.toLowerCase()) ? '1:1' : trimmed.toLowerCase();
    const aspect = RATIOS[ratio] ?? invalid('size', `size ${size} is not a supported ratio or WxH pixel size.`);
    const tier = resolution.trim().toUpperCase() || '1K', budget = BUDGETS[tier] ?? invalid('resolution', `resolution ${resolution} must be 1K, 2K or 4K.`);
    const [width, height] = fitBudget(roundToStep(Math.trunc(Math.sqrt(budget * aspect[0] / aspect[1]))), roundToStep(Math.trunc(Math.sqrt(budget * aspect[1] / aspect[0]))));
    checkPixels(width, height);
    return [width, height];
}
/** resolveGPTImage1FamilySize: gpt-image-1 and 1.5 take three sizes. */
function family1Size(size) {
    const value = size.trim().toLowerCase();
    if (['', '1024x1024', '1024×1024', '1:1'].includes(value))
        return [1024, 1024];
    if (['1024x1536', '1024×1536', '2:3'].includes(value))
        return [1024, 1536];
    if (['1536x1024', '1536×1024', '3:2'].includes(value))
        return [1536, 1024];
    return invalid('size', `size ${size} must be 1024x1024, 1024x1536, 1536x1024, 1:1, 2:3 or 3:2.`);
}
function scaledTiles(base, longer, shorter) {
    // The calculator's own order of division: base * shorter / longer differs in the last bit for a few sizes.
    const c = base / (longer / shorter), p = Math.floor(c);
    return c - p === 0.5 ? p + p % 2 : Math.round(c);
}
/** Output tokens for one image. */
export function imageOutputTokens(model, width, height, quality) {
    if (family1(model)) {
        const tiles = TILES_1[quality];
        return width < height ? tiles[0] : width > height ? tiles[1] : tiles[2];
    }
    const base = (family25(model) ? BASE_25 : BASE_2)[quality];
    return Math.ceil(base * scaledTiles(base, Math.max(width, height), Math.min(width, height)) * (2_000_000 + width * height) / 4_000_000);
}
/** CJK ideographs, kana, Hangul and their punctuation and full-width forms. */
const CJK = /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/u;
// Hundredths of a token per character, by class. Calibrated on 10-31 against the gateway's o200k_base counts
// (scripts/gpt-image-reservation): typical prompts come out 0.8 to 1.8 times the exact count, most a little above it.
const LETTER = 25, DIGIT_OR_MARK = 75, CJK_CHARACTER = 110, OTHER_SCRIPT = 50, ASTRAL = 300;
/**
 * Prompt tokens, approximately: the gateway counts them with the o200k_base encoding, which this package does not
 * ship. Prompt tokens are a small part of an image's price, and the task settles at the count the upstream reports.
 */
export function approximatePromptTokens(prompt) {
    let hundredths = 0;
    for (const character of prompt) {
        const code = character.codePointAt(0);
        hundredths += code < 0x80 ? /[A-Za-z\s]/.test(character) ? LETTER : DIGIT_OR_MARK
            : code > 0xffff ? ASTRAL : CJK.test(character) ? CJK_CHARACTER : OTHER_SCRIPT;
    }
    return Math.ceil(hundredths / 100);
}
const filled = (value) => typeof value === 'string' && value !== '';
/** parseFlexibleStringArray: one string or a list; empty and non-string entries do not count. */
const referenceCount = (value) => Array.isArray(value) ? value.filter(filled).length : filled(value) ? 1 : 0;
/**
 * The tokens the gateway reserves at submission for this input, as the reference price counts them. Without a size (or
 * with auto) gpt-image-2 and the 2.5 family count a 2048×2048 output; quality defaults to medium, high for gpt-image-1
 * and 1.5. countPromptTokens replaces the approximation when the exact count is known.
 */
export function tokenImageReservation(model, input, countPromptTokens = approximatePromptTokens) {
    const n = input.n === undefined ? 1 : Number.isInteger(input.n) ? Math.max(1, input.n) : invalid('n', 'n must be a whole number.');
    const given = text('quality', input.quality);
    const quality = given === '' ? family1(model) ? 'high' : 'medium' : given.trim().toLowerCase();
    if (!Object.hasOwn(family1(model) ? TILES_1 : family25(model) ? BASE_25 : BASE_2, quality))
        invalid('quality', `quality ${given} is not supported by ${model}.`);
    const size = text('size', input.size), resolution = text('resolution', input.resolution);
    const auto = !family1(model) && ['', 'auto'].includes(size.trim().toLowerCase());
    const [width, height] = auto ? [2048, 2048] : family1(model) ? family1Size(size) : outputSize(size, resolution);
    const mask = text('mask_url', input.mask_url);
    const references = referenceCount(input.image_url) + referenceCount(input.image_urls) + (mask !== '' ? 1 : 0);
    const prompt = text('prompt', input.prompt);
    return { per_image: { image_output_tokens: imageOutputTokens(model, width, height, quality),
            text_input_tokens: prompt === '' ? 0 : countPromptTokens(prompt), image_input_tokens: INPUT_IMAGE_TOKENS * references },
        images: n, output: { width, height, quality, size: family1(model) ? 'fixed' : auto ? 'auto' : pixelSize(size.trim()) ? 'pixels' : 'ratio' },
        reference_images: references };
}
