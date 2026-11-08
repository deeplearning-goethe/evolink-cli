// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { QuoteError } from './pricing-quote-client.js';
import { CJK } from './gpt-image-tokens.js';
const TIERS = ['360p', '720p', '1080p', '4k'];
/** Video tokens per second by resolution (1.1 and 1.2), for the output and for input and reference videos alike. */
const RATE = { '360p': 1931, '720p': 5792, '1080p': 8688, '4k': 17376 };
/** Reserved for each input image, and for the other output (text and thinking) of every task except an upscale. */
export const OMNI_IMAGE_TOKENS = 2020, OMNI_OTHER_OUTPUT_TOKENS = 1000;
/** The resolution the gateway reserves at when it cannot read an input video's, and the one MCP counts. */
export const OMNI_UNREAD_TIER = '4k';
const DEFAULT_TIER = '720p';
/** 1.0 (gemini-omni-flash-*): one 720p output rate, a fixed input video rate, outputs of 3–10 seconds, 10 by default. */
const V10 = { output: 5792, inputVideo: 5760, defaultSeconds: 10, minSeconds: 3, maxSeconds: 10, maxInputSeconds: 10 };
/** 1.2 upscale output tokens per second, by source and target resolution; an upscale bills nothing else. */
const UPSCALE = { '360p>720p': 2896, '720p>1080p': 2896, '360p>1080p': 5792, '720p>4k': 11584, '1080p>4k': 11584 };
const G11 = { label: '1.1', maxOutput: 10, maxFrameOutput: 10, maxExtend: 10,
    maxInput: { edit: 10, extend: 30, reference: 10, upscale: 10 }, referenceVideosAboveTen: 0, maxVideoOutputTokens: 17376 * 10 };
const G12 = { label: '1.2', maxOutput: 15, maxFrameOutput: 10, maxExtend: 10,
    maxInput: { edit: 15, extend: 30, reference: 10, upscale: 15 }, referenceVideosAboveTen: 1, maxVideoOutputTokens: 17376 * 15 };
const ROUTES = { 'text-to-video': 'text', 'image-to-video': 'image', 'reference-to-video': 'reference',
    'video-edit': 'edit', 'video-extend': 'extend', 'video-upscale': 'upscale' };
function omniModel(model) {
    const match = /^gemini-omni-(?:(1\.[12])-)?flash-([a-z-]+)$/.exec(model.trim().toLowerCase());
    const route = match ? ROUTES[match[2]] : undefined;
    if (!match || !route)
        return undefined;
    if (!match[1])
        return ['text', 'image', 'reference', 'edit'].includes(route) ? { route } : undefined;
    if (match[1] === '1.1' && route === 'upscale')
        return undefined;
    return { generation: match[1] === '1.1' ? G11 : G12, route };
}
/** Gemini Omni Flash video models (1.0, 1.1 and 1.2), which the gateway reserves and bills by token counts. */
export const isOmniTokenModel = (model) => omniModel(model) !== undefined;
// Hundredths of a token per character, by class, for the gpt-4 encoding the gateway counts Omni prompts with. Calibrated
// on 11-07 against the gateway's counts (scripts/omni-reservation): typical prompts come out 0.8 to 1.8 times the exact
// count, most a little above it.
const LETTER = 22, DIGIT_OR_MARK = 85, CJK_CHARACTER = 160, OTHER_SCRIPT = 95, ASTRAL = 375;
/**
 * Prompt tokens, approximately: the gateway counts them with the gpt-4 encoding, which this package does not ship.
 * Prompt tokens are a small part of a video's price, and the task settles at the count the upstream reports.
 */
export function approximateOmniPromptTokens(prompt) {
    let hundredths = 0;
    for (const character of prompt) {
        const code = character.codePointAt(0);
        hundredths += code < 0x80 ? /[A-Za-z\s]/.test(character) ? LETTER : DIGIT_OR_MARK
            : code > 0xffff ? ASTRAL : CJK.test(character) ? CJK_CHARACTER : OTHER_SCRIPT;
    }
    return Math.ceil(hundredths / 100);
}
function invalid(param, message) { throw new QuoteError('invalid_quote_parameter', message, param); }
const textOf = (value) => typeof value === 'string' ? value : '';
/** parseFlexibleStringArray: one string or a list; empty and non-string entries do not count. */
const flexible = (value) => typeof value === 'string' ? value === '' ? [] : [value]
    : Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : [];
/** dedupeNonEmptyImageURLs: trimmed, without blanks or repeats, in order. */
const dedupe = (values) => [...new Set(values.map(value => value.trim()).filter(Boolean))];
const isHTTP = (url) => /^https?:\/\//i.test(url.trim());
/** 1.0 reads every image and video field and keeps repeats (getGeminiOmniImageInputs / getGeminiOmniVideoInputs). */
function media10(input, list, single, legacy) {
    const one = textOf(input[legacy]);
    return [...flexible(input[list]), ...flexible(input[single]), ...(one.trim() !== '' ? [one] : [])];
}
/** 1.1 and 1.2: image_urls with image_url, else image_start and image_end, else image; repeats count once. */
function images11(input) {
    const modern = dedupe([...flexible(input.image_urls), ...flexible(input.image_url)]);
    if (modern.length)
        return modern;
    const frames = dedupe([textOf(input.image_start), textOf(input.image_end)]);
    return frames.length ? frames : dedupe([textOf(input.image)]);
}
function videos11(input) {
    const modern = dedupe([...flexible(input.video_urls), ...flexible(input.video_url)]);
    return modern.length ? modern : dedupe([textOf(input.video)]);
}
/** An integer duration as given; "auto" and absence are 0, which each route reads as its default. */
const durationOf = (value) => typeof value === 'number' && Number.isInteger(value) ? value : 0;
/** clampOmniSeconds: 0 is the default of 3 seconds; otherwise 3 to the route's maximum. */
const clampSeconds = (seconds, max) => seconds <= 0 ? 3 : Math.min(Math.max(seconds, 3), max);
/** The input seconds the gateway counts: rounded up, at most the route's longest input. */
const wholeSeconds = (seconds, max) => { const whole = Math.ceil(seconds); return whole <= 0 || whole > max ? max : whole; };
const upscaleMax = (target) => Math.max(0, ...Object.entries(UPSCALE).filter(([pair]) => pair.endsWith(`>${target}`)).map(([, rate]) => rate));
/** The source resolution that bills the most for an upscale target, as the gateway reserves when it cannot read the size. */
const upscaleSource = (target) => TIERS.find(tier => UPSCALE[`${tier}>${target}`] === upscaleMax(target));
function checkLength(mediaSeconds, max, what, model) {
    if (mediaSeconds > max)
        invalid('media_seconds', `${what} must be ${max} seconds or shorter for ${model}; media_seconds is ${mediaSeconds}.`);
}
function requirePrompt(input, model) {
    const prompt = textOf(input.prompt);
    if (prompt.trim() === '')
        invalid('prompt', `prompt is required for ${model}.`);
    return prompt;
}
/**
 * The tokens the gateway reserves at submission for this input, or the length it needs first. inputTier counts the input
 * and reference videos at that resolution instead of the highest (for the price of a lower-resolution input).
 * countPromptTokens replaces the approximate prompt count when the gateway's exact count is known.
 */
export function omniReservation(model, input, mediaSeconds, options = {}) {
    const id = model.trim().toLowerCase(), found = omniModel(id) ?? invalid('model', `${model} is not a Gemini Omni Flash model.`);
    const count = options.countPromptTokens ?? approximateOmniPromptTokens, route = found.route, g = found.generation;
    const tokensOf = (prompt) => prompt === '' ? 0 : count(prompt);
    if (!g)
        return reservation10(id, route, input, mediaSeconds, tokensOf);
    const images = images11(input), videos = videos11(input);
    // validateGeminiOmni11FrameParams and validateGeminiOmni11MediaCounts: the media each route takes.
    const start = textOf(input.image_start).trim(), end = textOf(input.image_end).trim();
    if (start || end) {
        if (route !== 'image')
            invalid('image_start', `image_start and image_end are only for gemini-omni-${g.label}-flash-image-to-video.`);
        if (end && !start)
            invalid('image_end', 'image_end needs image_start: a last frame only is not supported.');
    }
    const duration = durationOf(input.duration);
    if (route === 'text' && (images.length || videos.length))
        invalid('image_urls', `${id} takes no image or video input.`);
    if (route === 'image') {
        if (images.length < 1 || images.length > 2)
            invalid('image_urls', `${id} takes 1 or 2 images (a first frame, then a last frame), got ${images.length}.`);
        if (videos.length)
            invalid('video_urls', `${id} takes no video input.`);
        if (images.length === 2 && duration > g.maxFrameOutput)
            invalid('duration', `first and last frame generation supports up to ${g.maxFrameOutput} seconds on ${id}, got ${duration}.`);
    }
    if (route === 'reference') {
        if (images.length < 1)
            invalid('image_urls', `${id} needs at least 1 image.`);
        if (g.referenceVideosAboveTen && duration > 10 && videos.length > g.referenceVideosAboveTen) {
            invalid('video_urls', `${id} takes at most ${g.referenceVideosAboveTen} reference video when duration is longer than 10 seconds, got ${videos.length}.`);
        }
    }
    if (route === 'upscale' && images.length)
        invalid('image_urls', `${id} takes no image input.`);
    if (['edit', 'extend', 'upscale'].includes(route)) {
        if (videos.length !== 1)
            invalid('video_urls', `${id} takes exactly 1 video, got ${videos.length}.`);
        if (!isHTTP(videos[0]))
            invalid('video_urls', `${id} takes the video as an http(s) URL.`);
    }
    // An upscale takes no prompt; the gateway drops one.
    const prompt = route === 'upscale' ? '' : requirePrompt(input, id);
    const quality = textOf(input.quality).trim().toLowerCase();
    const follows = (route === 'edit' || route === 'extend') && (quality === '' || quality === 'auto');
    if (quality !== '' && !follows && !TIERS.includes(quality))
        invalid('quality', `quality ${input.quality} is not supported by ${id}.`);
    if (route === 'upscale' && (quality === '' || quality === '360p'))
        invalid('quality', `quality on ${id} is the target resolution: 720p, 1080p or 4k.`);
    const tier = (quality === '' || quality === 'auto' ? DEFAULT_TIER : quality);
    // Input and reference videos: the gateway reads their length at submission and refuses one that is too long.
    let input_videos;
    if (videos.length) {
        if (mediaSeconds === undefined)
            return { needs: 'media_seconds', videos: videos.length };
        const max = g.maxInput[route] ?? g.maxInput.edit;
        checkLength(mediaSeconds, max, videos.length > 1 ? 'each reference video' : 'the input video', id);
        const resolution = options.inputTier ?? OMNI_UNREAD_TIER;
        input_videos = { count: videos.length, seconds: wholeSeconds(mediaSeconds, max), resolution, resolution_assumed: options.inputTier === undefined };
    }
    const cap = (tokens) => Math.min(tokens, g.maxVideoOutputTokens);
    // omniInputVideoTokens: each video's seconds at its own rate or the output's, whichever is higher.
    const videoTokens = (output) => input_videos ? input_videos.count * input_videos.seconds * Math.max(RATE[input_videos.resolution], RATE[output]) : 0;
    const promptTokens = tokensOf(prompt), imageTokens = images.length * OMNI_IMAGE_TOKENS;
    const base = { generation: g.label, prompt_tokens: promptTokens, images: images.length, ...(input_videos ? { input_videos } : {}) };
    switch (route) {
        case 'upscale': {
            const target = quality, source = options.inputTier ?? upscaleSource(target);
            const rate = UPSCALE[`${source}>${target}`];
            if (rate === undefined)
                invalid('quality', `${id} cannot upscale ${source} to ${target}; supported: 360p to 720p or 1080p, 720p to 1080p or 4k, 1080p to 4k.`);
            return { ...base, route, prompt_tokens: 0, output: { resolution: target, seconds: input_videos.seconds },
                upscale: { target, source, source_assumed: options.inputTier === undefined, tokens_per_second: rate },
                tokens: { input_tokens: 0, video_output_tokens: cap(rate * input_videos.seconds), other_output_tokens: 0 } };
        }
        case 'edit':
        case 'extend': {
            const output = follows ? input_videos.resolution : tier;
            const seconds = route === 'edit' ? input_videos.seconds : clampSeconds(duration, g.maxExtend);
            return { ...base, route, output: { resolution: output, seconds, ...(follows ? { follows_input: true } : {}) },
                tokens: { input_tokens: promptTokens + imageTokens + videoTokens(output), video_output_tokens: cap(RATE[output] * seconds),
                    other_output_tokens: OMNI_OTHER_OUTPUT_TOKENS } };
        }
        default: {
            const seconds = clampSeconds(duration, g.maxOutput);
            return { ...base, route, output: { resolution: tier, seconds },
                tokens: { input_tokens: promptTokens + (route === 'text' ? 0 : imageTokens) + (route === 'reference' ? videoTokens(tier) : 0),
                    video_output_tokens: cap(RATE[tier] * seconds), other_output_tokens: OMNI_OTHER_OUTPUT_TOKENS } };
        }
    }
}
/** EstimateGeminiOmniPreCharge, for 1.0: one 720p rate; an edit's output counts 10 seconds whatever its input. */
function reservation10(id, route, input, mediaSeconds, tokensOf) {
    const images = media10(input, 'image_urls', 'image_url', 'image'), videos = media10(input, 'video_urls', 'video_url', 'video');
    // validateGeminiOmniFlashRequest: no resolution or frame fields, an edit takes no duration, and the media each route takes.
    if (textOf(input.quality) !== '')
        invalid('quality', `quality is not supported by ${id}.`);
    if (textOf(input.image_start) !== '' || textOf(input.image_end) !== '')
        invalid('image_start', `image_start and image_end are not supported by ${id}; use image_urls.`);
    if (route === 'edit' && (durationOf(input.duration) !== 0 || input.duration === 'auto'))
        invalid('duration', `duration is not supported by ${id}.`);
    if (route === 'text' && (images.length || videos.length))
        invalid('image_urls', `${id} takes no image or video input.`);
    if (route === 'image' && images.length !== 1)
        invalid('image_urls', `${id} takes exactly 1 image, got ${images.length}.`);
    if (route === 'reference' && (images.length < 1 || images.length > 6))
        invalid('image_urls', `${id} takes 1 to 6 images, got ${images.length}.`);
    if ((route === 'image' || route === 'reference') && videos.length)
        invalid('video_urls', `${id} takes no video input.`);
    if (route === 'edit') {
        if (images.length)
            invalid('image_urls', `${id} takes no image input.`);
        if (videos.length !== 1)
            invalid('video_urls', `${id} takes exactly 1 video, got ${videos.length}.`);
        if (!isHTTP(videos[0]))
            invalid('video_urls', `${id} takes the video as an http(s) URL.`);
    }
    const prompt = requirePrompt(input, id), promptTokens = tokensOf(prompt);
    let input_videos, inputTokens = promptTokens;
    if (route === 'image' || route === 'reference')
        inputTokens += images.length * OMNI_IMAGE_TOKENS;
    if (route === 'edit') {
        if (mediaSeconds === undefined)
            return { needs: 'media_seconds', videos: 1 };
        checkLength(mediaSeconds, V10.maxInputSeconds, 'the input video', id);
        const seconds = wholeSeconds(mediaSeconds, V10.maxInputSeconds);
        input_videos = { count: 1, seconds, resolution: DEFAULT_TIER, resolution_assumed: false };
        inputTokens += seconds * V10.inputVideo;
    }
    const given = route === 'edit' ? 0 : durationOf(input.duration);
    const seconds = given <= 0 ? V10.defaultSeconds : Math.min(Math.max(given, V10.minSeconds), V10.maxSeconds);
    return { generation: '1.0', route, prompt_tokens: promptTokens, images: images.length, output: { resolution: DEFAULT_TIER, seconds },
        ...(input_videos ? { input_videos } : {}),
        tokens: { input_tokens: inputTokens, video_output_tokens: seconds * V10.output, other_output_tokens: OMNI_OTHER_OUTPUT_TOKENS } };
}
/**
 * The input resolutions a reference price is also given at, lowest first, when the gateway reads the input's own at
 * submission: every tier for an input or reference video, or for an upscale each source it accepts for the target.
 */
export function omniInputTiers(reservation) {
    if (reservation.upscale) {
        const target = reservation.upscale.target;
        return reservation.upscale.source_assumed ? TIERS.filter(tier => UPSCALE[`${tier}>${target}`] !== undefined) : [];
    }
    return reservation.input_videos?.resolution_assumed ? [...TIERS] : [];
}
/** The resolution the reference price itself counts the input at: the highest, or the upscale source that costs most. */
export const omniQuotedTier = (reservation) => reservation.upscale?.source ?? reservation.input_videos?.resolution;
/** The lower-resolution input a reference price can also be given for: 720p, or for an upscale the cheaper source. */
export function omniLowerInputTier(reservation) {
    if (reservation.upscale) {
        const target = reservation.upscale.target;
        const cheaper = TIERS.filter(tier => UPSCALE[`${tier}>${target}`] !== undefined && UPSCALE[`${tier}>${target}`] < reservation.upscale.tokens_per_second);
        return reservation.upscale.source_assumed ? cheaper.at(-1) : undefined;
    }
    return reservation.input_videos?.resolution_assumed ? '720p' : undefined;
}
