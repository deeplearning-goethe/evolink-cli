// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { currentRequestCredentials } from '../request-context.js';
import { isIP } from 'node:net';
import { CREDITS_PER_USD, formatUsd } from './error-handler.js';
import { DEFAULT_READ_TIMEOUT_MS, evoHeaders, fetchWithTimeout, readJsonBody, timeoutFromEnv, } from './http-policy.js';
const CACHE_TTL_MS = 5 * 60_000;
const MAX_STALE_MS = 24 * 60 * 60_000;
/** Gateway display rate: 1 USD = 6.8 CNY. */
const CNY_PER_USD = 6.8;
const caches = new Map();
const pending = new Map();
/** Base for the public web API (pricing); EVOLINK_CONTROL_BASE points it at a staging host. */
export function controlBaseURL() {
    const configured = (currentRequestCredentials()?.http?.controlBaseUrl ?? process.env.EVOLINK_CONTROL_BASE ?? 'https://api.evolink.ai').trim().replace(/\/$/, '');
    let parsed;
    try {
        parsed = new URL(configured);
    }
    catch {
        throw new Error('EVOLINK_CONTROL_BASE must be an absolute URL');
    }
    const loopback = parsed.hostname === 'localhost' || (isIP(parsed.hostname) !== 0 && parsed.hostname === '127.0.0.1');
    if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('EVOLINK_CONTROL_BASE must use HTTPS, except for loopback development, and contain no credentials/query/fragment');
    }
    return configured;
}
const ROUTING_NOTE = /\$([\d,]*\.?\d+)(?:\s*[-–~]\s*\$?([\d,]*\.?\d+))?\s+per\s+([A-Za-z0-9 ]+?)(?=[.,;]|$)/;
/** Charges for optional inputs or features, as opposed to the generated output ("Reference to Video" is an output). */
const ADD_ON_NAME = /\binput (image|images|video|audio|text)\b|\breference (image|images|video seconds|audio)\b|web search|cached|cache (hit|write)|asset upload|输入/i;
function parseMetadata(value) {
    if (!value)
        return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
function unitFromRule(rule) {
    switch (rule) {
        case 'per_image': return 'image';
        case 'per_second': return 'second';
        case 'per_hour': return 'hour';
        case 'per_1k':
        case 'per_1k_tokens': return '1K tokens';
        case 'per_token': return 'token';
        default: return 'request';
    }
}
/** The gateway's routing note for a SKU served by several upstream providers (controller/model_pricing.go buildRoutingNote). */
const MULTIPLE_PROVIDERS = /Calls prioritize/i;
const PREFERRED_PROVIDER = /prioritize the \$([\d,]*\.?\d+) provider/i;
/** Unit and USD price of one SKU: the gateway's routing note first (it carries the corrected unit), the raw fields second. */
export function skuPrice(sku) {
    const note = ROUTING_NOTE.exec(sku.routing_note ?? '');
    let unit;
    let minUsd;
    let maxUsd;
    if (note) {
        unit = note[3].trim().toLowerCase();
        minUsd = Number(note[1].replaceAll(',', ''));
        maxUsd = note[2] ? Number(note[2].replaceAll(',', '')) : minUsd;
    }
    else {
        unit = unitFromRule(sku.billing_rule);
        const range = sku.price_range;
        if (range && typeof range.min_usd === 'number' && typeof range.max_usd === 'number') {
            minUsd = range.min_usd;
            maxUsd = range.max_usd;
        }
        else if (typeof sku.cny_price === 'number') {
            minUsd = sku.cny_price / CNY_PER_USD;
            maxUsd = minUsd;
        }
        else {
            return undefined;
        }
    }
    if (!Number.isFinite(minUsd) || !Number.isFinite(maxUsd))
        return undefined;
    const metadata = parseMetadata(sku.metadata);
    const tokenBased = /token/.test(unit);
    const addOn = !tokenBased && (metadata.role === 'input_image' || ADD_ON_NAME.test(sku.sku_name));
    const multipliers = sku.resolution_multipliers
        ?? (metadata.resolution_multipliers && typeof metadata.resolution_multipliers === 'object'
            ? metadata.resolution_multipliers
            : undefined);
    const price = {
        sku_id: String(sku.sku_id),
        name: sku.sku_name,
        unit,
        min_usd: minUsd,
        max_usd: maxUsd,
        role: tokenBased ? 'token' : addOn ? 'add_on' : 'output',
    };
    if (multipliers && Object.keys(multipliers).length > 0)
        price.multipliers = multipliers;
    if (note?.[2] && maxUsd > minUsd && MULTIPLE_PROVIDERS.test(sku.routing_note ?? '')) {
        price.provider_range = true;
        const preferred = PREFERRED_PROVIDER.exec(sku.routing_note ?? '');
        if (preferred)
            price.preferred_usd = Number(preferred[1].replaceAll(',', ''));
    }
    if (typeof sku.min_charge_uc === 'number' && sku.min_charge_uc > 0 && !tokenBased) {
        price.min_charge_usd = sku.min_charge_uc / 10_000 / CREDITS_PER_USD;
    }
    return price;
}
function buildIndex(skus) {
    const models = new Map();
    for (const sku of skus) {
        if (!sku?.model_name || !['image', 'video', 'audio'].includes(sku.model_type))
            continue;
        const price = skuPrice(sku);
        let model = models.get(sku.model_name);
        if (!model) {
            model = { id: sku.model_name, kind: sku.model_type, vendor: sku.vendor_slug, description: sku.description || undefined, prices: [] };
            models.set(sku.model_name, model);
        }
        if (!model.description && sku.description)
            model.description = sku.description;
        if (price)
            model.prices.push(price);
    }
    return models;
}
async function fetchPricing() {
    const response = await fetchWithTimeout(`${controlBaseURL()}/web/api/models/pricing`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', ...evoHeaders('pricing') },
    }, timeoutFromEnv('EVOLINK_MCP_READ_TIMEOUT_MS', DEFAULT_READ_TIMEOUT_MS));
    const body = await readJsonBody(response);
    if (!response.ok || !Array.isArray(body.data)) {
        throw new Error(`the pricing list returned HTTP ${response.status}`);
    }
    return { models: buildIndex(body.data), fetchedAt: Date.now() };
}
/** Image, video and audio models with their published unit prices; cached for five minutes, served stale for a day if a refresh fails. */
export async function getPricing() {
    const now = Date.now();
    const key = controlBaseURL();
    const cached = caches.get(key);
    if (!currentRequestCredentials()?.http?.freshPricing && cached && now - cached.fetchedAt < CACHE_TTL_MS)
        return { ...cached, source: 'cache' };
    try {
        let inflight = pending.get(key);
        if (!inflight) {
            inflight = fetchPricing().finally(() => pending.delete(key));
            pending.set(key, inflight);
        }
        const fresh = await inflight;
        caches.set(key, fresh);
        return { ...fresh, source: 'live' };
    }
    catch (error) {
        if (cached && now - cached.fetchedAt <= MAX_STALE_MS)
            return { ...cached, source: 'stale-cache' };
        throw error;
    }
}
export function resetPricingCacheForTests() {
    caches.clear();
    pending.clear();
}
export function findPricedModel(models, id) {
    const direct = models.get(id.trim());
    if (direct)
        return direct;
    const lower = id.trim().toLowerCase();
    for (const model of models.values())
        if (model.id.toLowerCase() === lower)
            return model;
    return undefined;
}
export function formatPrice(price) {
    const amount = price.min_usd === price.max_usd
        ? `$${formatUsd(price.min_usd)}`
        : `$${formatUsd(price.min_usd)}–$${formatUsd(price.max_usd)}`;
    return `${amount} per ${price.unit}`;
}
/** Lowest main unit price, for listings ("from $0.04 per image"). */
export function startingPrice(model) {
    const outputs = model.prices.filter(price => price.role === 'output');
    const pool = outputs.length > 0 ? outputs : model.prices;
    return [...pool].sort((a, b) => a.min_usd - b.min_usd)[0];
}
const COUNT_PARAMS = ['n', 'num_images', 'number_of_images', 'image_count', 'count'];
const DURATION_PARAMS = ['duration', 'seconds', 'duration_seconds'];
const TIER_PARAMS = ['quality', 'resolution', 'size'];
const TIER_TOKEN = /\b(\d+(?:\.\d+)?k|\d{3,4}p)\b/gi;
/**
 * A documented model billed per second that has no duration parameter: the gateway measures the seconds when
 * the task runs, usually from the media it works on (the input video of an upscale, edit or motion transfer,
 * the audio of a talking head). Its input alone cannot price it; media_seconds can.
 */
export function billedByMediaLength(model, spec) {
    if (!spec || DURATION_PARAMS.some(name => spec.params[name] !== undefined))
        return false;
    return (model?.prices ?? []).some(price => price.role === 'output' && price.unit === 'second');
}
/** media_seconds as billed seconds: whole seconds, rounded up, at least one. */
function mediaLength(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0)
        return undefined;
    // Do not subtract an epsilon: some gateway strategies ceil every positive fraction.
    const whole = Math.max(1, Math.ceil(seconds));
    return { value: whole, source: whole === seconds ? 'media_seconds' : `media_seconds ${seconds}, rounded up` };
}
function numberParam(input, names, spec) {
    for (const name of names) {
        const value = input[name];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0)
            return { value, source: `input.${name}` };
        if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) > 0) {
            return { value: Number(value), source: `input.${name}` };
        }
    }
    for (const name of names) {
        const fallback = spec?.params[name]?.default;
        if (typeof fallback === 'number' && fallback > 0)
            return { value: fallback, source: `default ${name}` };
    }
    return undefined;
}
function tierOf(name) {
    return [...name.matchAll(TIER_TOKEN)].map(match => match[1].toLowerCase());
}
function countInputMedia(input, pattern) {
    let count = 0;
    for (const [key, value] of Object.entries(input)) {
        if (!pattern.test(key))
            continue;
        if (Array.isArray(value))
            count += value.filter(item => typeof item === 'string' && item).length;
        else if (typeof value === 'string' && value)
            count += 1;
    }
    return count;
}
function multiplierRange(price, tiers) {
    if (!price.multipliers)
        return [1, 1];
    const entries = Object.entries(price.multipliers).filter(([, value]) => typeof value === 'number' && value > 0);
    if (entries.length === 0)
        return [1, 1];
    const chosen = entries.find(([key]) => tiers.includes(key.toLowerCase()));
    if (chosen)
        return [chosen[1], chosen[1]];
    const values = entries.map(([, value]) => value);
    return [Math.min(...values), Math.max(...values)];
}
/**
 * Interim media estimate: published unit price × images or seconds, plus
 * per-input-image charges. The gateway's own pre-charge at submit time is
 * authoritative; this only tells the user what to expect.
 */
export function estimateCost(model, kind, input, spec, options = {}) {
    const byMedia = billedByMediaLength(model, spec);
    const estimate = priceEstimate(model, input, spec, byMedia ? options.mediaSeconds : undefined, byMedia);
    if (spec?.constraints?.outputDuration === 'unknown' && byMedia) {
        if (estimate.status === 'estimated')
            estimate.status = 'partial';
        estimate.uncheckable_reason = 'output_duration';
        estimate.notes = estimate.notes.filter(note => !note.includes('usually the length of the input video or audio') && !note.startsWith('This uses the length'));
        estimate.notes.push('This model bills the generated audio duration, which cannot be set in input. media_seconds is only an expected output length for an illustrative estimate; it is not the reference clip length, a total or an upper bound. Do not add input.duration.');
    }
    if (/^wan3\.0-/.test(spec?.model ?? '') && input.duration === -1) {
        if (estimate.status === 'estimated')
            estimate.status = 'partial';
        estimate.uncheckable_reason = 'output_duration';
        estimate.notes.push('Smart duration (-1) has an unknown output length. The gateway reserves up to 30 seconds; this range is not an upper bound. Use an explicit duration for an estimate.');
        delete estimate.min_usd;
        delete estimate.max_usd;
        delete estimate.min_credits;
        delete estimate.max_credits;
        estimate.basis = estimate.basis.filter(line => !line.includes('default duration'));
    }
    // Public prices do not describe all input-video seconds or video-dependent multipliers.
    // media_seconds is only a declared length, so it cannot make this a complete price.
    const hasInputVideo = (Array.isArray(input.video_urls) && input.video_urls.length > 0)
        || (typeof input.video_url === 'string' && input.video_url.length > 0)
        || (typeof input.source_task_id === 'string' && input.source_task_id.length > 0);
    if (kind === 'video' && hasInputVideo
        && model?.prices.some(price => price.role === 'output' && price.unit === 'second')) {
        if (estimate.status === 'estimated')
            estimate.status = 'partial';
        estimate.uncheckable_reason = 'reference_video';
        estimate.possible_extras.push('Input/reference video seconds and video-dependent billing multipliers may also apply; they are not fully covered by this range.');
        estimate.notes.push('For a per-second video request with input.video_urls, input.video_url or input.source_task_id, this is not a total or an upper bound. max_cost_usd cannot be checked; the gateway reservation at submission is authoritative.');
    }
    if (options.mediaSeconds !== undefined && !byMedia) {
        const takesDuration = spec !== undefined && DURATION_PARAMS.some(name => spec.params[name] !== undefined);
        estimate.notes.push(`media_seconds was not used: it is only for models billed per second that have no duration parameter${takesDuration ? '; this one takes input.duration' : ''}.`);
    }
    return estimate;
}
function priceEstimate(model, input, spec, mediaSeconds, byMedia) {
    const estimate = { status: 'no_price', basis: [], possible_extras: [], notes: [] };
    if (!model || model.prices.length === 0) {
        estimate.notes.push('Pricing data is unavailable in this catalog, so no estimate is possible.');
        return estimate;
    }
    const tiers = TIER_PARAMS
        .map(name => input[name] ?? spec?.params[name]?.default)
        .filter((value) => typeof value === 'string')
        .map(value => value.toLowerCase());
    const outputs = model.prices.filter(price => price.role === 'output');
    if (outputs.length === 0) {
        estimate.status = model.prices.some(price => price.role === 'token') ? 'token_billed' : 'no_price';
        estimate.notes.push('This model is billed by tokens used, so the cost is only known after it runs.');
        for (const price of model.prices)
            estimate.basis.push(`${price.name}: ${formatPrice(price)}`);
        return estimate;
    }
    // Pick the price tier the input asks for (e.g. "4K", "1080p"); untiered SKUs are the default tier.
    let candidates = outputs;
    if (tiers.length > 0) {
        const matching = outputs.filter(price => tierOf(price.name).some(tier => tiers.includes(tier)));
        const untiered = outputs.filter(price => tierOf(price.name).length === 0);
        if (matching.length > 0)
            candidates = matching;
        else if (untiered.length > 0)
            candidates = untiered;
    }
    let min = Infinity;
    let max = 0;
    for (const price of candidates) {
        let quantity = 1;
        let quantityText = '';
        if (price.unit === 'image') {
            const count = numberParam(input, COUNT_PARAMS, spec);
            quantity = count?.value ?? 1;
            quantityText = ` × ${quantity} image${quantity === 1 ? '' : 's'}${count ? ` (${count.source})` : ''}`;
        }
        else if (price.unit === 'second') {
            // Without a duration parameter, input.duration would be refused as unknown: only media_seconds counts.
            const duration = byMedia ? mediaLength(mediaSeconds) : numberParam(input, DURATION_PARAMS, spec);
            if (!duration) {
                estimate.status = 'needs_input';
                estimate.missing = byMedia ? 'media_seconds' : 'duration';
                estimate.notes.push(byMedia
                    ? `${price.name} is billed per second, and this model has no duration parameter: EvoLink measures the seconds when the task runs (usually the length of the input video or audio). Pass that length as media_seconds to get an estimate.`
                    : `${price.name} is billed per second; pass input.duration to get an estimate.`);
                estimate.basis.push(`${price.name}: ${formatPrice(price)}`);
                continue;
            }
            quantity = duration.value;
            quantityText = ` × ${quantity} s (${duration.source})`;
        }
        else if (price.unit !== 'request') {
            estimate.notes.push(`${price.name} is billed per ${price.unit}; it is not included in the range.`);
            continue;
        }
        const [lowFactor, highFactor] = multiplierRange(price, tiers);
        let low = price.min_usd * quantity * lowFactor;
        let high = price.max_usd * quantity * highFactor;
        if (price.min_charge_usd !== undefined) {
            low = Math.max(low, price.min_charge_usd);
            high = Math.max(high, price.min_charge_usd);
        }
        min = Math.min(min, low);
        max = Math.max(max, high);
        const factorText = highFactor !== 1 || lowFactor !== 1 ? ` × resolution factor ${lowFactor === highFactor ? lowFactor : `${lowFactor}–${highFactor}`}` : '';
        estimate.basis.push(`${price.name}: ${formatPrice(price)}${quantityText}${factorText}`);
    }
    if (estimate.status === 'needs_input')
        return estimate;
    const mainCharge = min !== Infinity && max > 0;
    // Per-image input charges that this input actually triggers; anything else is listed as a possible extra.
    for (const price of model.prices.filter(item => item.role === 'add_on')) {
        const used = price.unit === 'image' ? countInputMedia(input, /image|frame/i) : 0;
        if (mainCharge && used > 0) {
            min += price.min_usd * used;
            max += price.max_usd * used;
            estimate.basis.push(`${price.name}: ${formatPrice(price)} × ${used} input image${used === 1 ? '' : 's'}`);
        }
        else {
            estimate.possible_extras.push(`${price.name}: ${formatPrice(price)}`);
        }
    }
    if (!mainCharge)
        return estimate;
    estimate.status = 'estimated';
    estimate.min_usd = min;
    estimate.max_usd = max;
    estimate.min_credits = min * CREDITS_PER_USD;
    estimate.max_credits = max * CREDITS_PER_USD;
    if (byMedia) {
        estimate.notes.push('This uses the length given as media_seconds. EvoLink measures the media itself when the task runs and charges by what it measures, which can differ from this estimate.');
    }
    if (candidates.length < outputs.length) {
        estimate.notes.push(`Price tier chosen from ${TIER_PARAMS.filter(name => input[name] !== undefined).map(name => `input.${name}`).join(', ') || 'the default settings'}.`);
    }
    else if (outputs.length > 1) {
        estimate.notes.push('The range covers all output tiers; set the quality or resolution to narrow it.');
    }
    // The gateway picks the provider by channel priority, not by price: name the price it tries first when the note says it.
    const ranged = candidates.filter(price => price.provider_range);
    if (ranged.length > 0) {
        const named = ranged.every(price => price.preferred_usd !== undefined);
        estimate.notes.push(named
            ? `The range covers EvoLink's upstream providers. A task goes to the preferred provider first, at ${ranged.map(price => `$${formatUsd(price.preferred_usd)} per ${price.unit}${ranged.length > 1 ? ` (${price.name})` : ''}`).join(', ')}; another provider's price applies only when it is unavailable.`
            : 'The range covers EvoLink\'s upstream providers for this model: a task goes to the preferred provider first, and another provider\'s price applies only when it is unavailable.');
    }
    return estimate;
}
export function formatEstimateRange(estimate) {
    if (estimate.min_usd === undefined || estimate.max_usd === undefined)
        return undefined;
    const usd = Math.abs(estimate.max_usd - estimate.min_usd) < 1e-9
        ? `$${formatUsd(estimate.max_usd)}`
        : `$${formatUsd(estimate.min_usd)}–$${formatUsd(estimate.max_usd)}`;
    const credits = Math.abs((estimate.max_credits ?? 0) - (estimate.min_credits ?? 0)) < 1e-6
        ? `${Number((estimate.max_credits ?? 0).toFixed(2))}`
        : `${Number((estimate.min_credits ?? 0).toFixed(2))}–${Number((estimate.max_credits ?? 0).toFixed(2))}`;
    return `${usd} (${credits} credits)`;
}
