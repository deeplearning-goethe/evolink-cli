// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { QuoteError } from './pricing-quote-client.js';
// The tokens the gateway reserves for a Qwen Audio TTS speech task at submission. Ported from GroAPI
// (feat/task-microservice-split) service/qwen_audio_tts.go (QwenAudioTTSEffectiveText and
// EstimateQwenAudioTTSPreChargeUsage) and the speech checks in controller/unified_audio_qwen_tts.go that run before it.
// The gateway counts each character's worst case by its class, so a task usually settles below the reservation, at the
// tokens the upstream reports.
const MODELS = new Set(['qwen-audio-3.1-tts-flash']);
/** Qwen Audio TTS models, which the gateway reserves and bills by input and output token counts. */
export const isQwenTTSModel = (model) => MODELS.has(model.trim().toLowerCase());
/**
 * The input as the gateway reads it: hot_fix null is no hot_fix there (it neither checks it nor sends it on), so it is
 * left out before the documented parameters are checked, the input is priced and it is submitted.
 */
export function qwenTTSInput(model, input) {
    if (input.hot_fix !== null || !isQwenTTSModel(model))
        return input;
    const rest = { ...input };
    delete rest.hot_fix;
    return rest;
}
/** The longest text one task synthesizes, in characters, also after hot_fix.replace. */
export const QWEN_TTS_MAX_TEXT = 5000;
/** instruction holds at most this many billing characters, a Han character counting two. */
const MAX_INSTRUCTION = 100;
/** hot_fix holds at most this many word entries across its lists. */
const MAX_HOT_FIX_ENTRIES = 200;
const HOT_FIX_LISTS = new Set(['pronunciation', 'replace']);
/** Reserved for every task: what a one-character request uses at most. */
const BASE_INPUT_TOKENS = 2, BASE_OUTPUT_TOKENS = 10;
/** Spaces and common punctuation, read like the words around them. */
const PUNCTUATION = new Set(' .,!?;:\'"-()\n，。！？；：、“”‘’（）…—');
/** Input tokens per character, by class. */
const INPUT_TOKENS = { han: 1, caseless: 1, lower: 1, punctuation: 1, other: 3 };
/** Output tokens per character in halves, as read and with an instruction or a [tag] in the text. */
const OUTPUT_HALVES = {
    han: [16, 20], caseless: [8, 16], lower: [9, 18], punctuation: [6, 12], other: [30, 30]
};
const HAN = /^\p{Script=Han}$/u, LETTER = /^\p{L}$/u, UPPER = /^\p{Lu}$/u, LOWER = /^\p{Ll}$/u;
/** The class the gateway counts a character in, checked in its order: Han, a letter without case, lowercase, punctuation. */
export function qwenCharacterClass(character) {
    if (HAN.test(character))
        return 'han';
    if (LETTER.test(character) && !UPPER.test(character) && !LOWER.test(character))
        return 'caseless';
    if (LOWER.test(character))
        return 'lower';
    if (PUNCTUATION.has(character))
        return 'punctuation';
    return 'other';
}
function invalid(param, message) { throw new QuoteError('invalid_quote_parameter', message, param); }
/** A string as the gateway decodes it from the request JSON: an unpaired surrogate becomes U+FFFD. */
const decoded = (text) => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
function textParam(input, param) {
    const value = input[param];
    if (value === undefined || value === null)
        return '';
    return typeof value === 'string' ? decoded(value) : invalid(param, `${param} must be a string.`);
}
const characters = (text) => [...text].length;
/** strings.TrimSpace(text) == "": only the characters unicode.IsSpace accepts. */
const blank = (text) => /^[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$/u.test(text);
/** CountBillingChars: a Han character counts two, any other one. */
const billingCharacters = (text) => { let count = 0; for (const character of text)
    count += HAN.test(character) ? 2 : 1; return count; };
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** sort.Strings: by UTF-8 bytes, which is code point order. */
function byCodePoint(a, b) {
    const x = [...a], y = [...b];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const difference = x[i].codePointAt(0) - y[i].codePointAt(0);
        if (difference)
            return difference;
    }
    return x.length - y.length;
}
/** validateQwenAudioTTSHotFix: {pronunciation?, replace?}, each a non-empty list of {"word": "value"} objects. */
function checkHotFix(hotFix) {
    const shape = () => invalid('hot_fix', 'hot_fix must be an object with pronunciation and/or replace arrays of {"word": "value"} objects.');
    if (!isObject(hotFix) || !Object.keys(hotFix).length)
        shape();
    let entries = 0;
    for (const [list, items] of Object.entries(hotFix)) {
        if (!HOT_FIX_LISTS.has(list) || !Array.isArray(items) || !items.length)
            shape();
        for (const item of items) {
            if (!isObject(item) || !Object.keys(item).length)
                shape();
            for (const [word, value] of Object.entries(item)) {
                if (typeof value !== 'string' || word === '' || value === '')
                    shape();
                entries++;
            }
        }
    }
    if (entries > MAX_HOT_FIX_ENTRIES)
        invalid('hot_fix', `hot_fix may contain at most ${MAX_HOT_FIX_ENTRIES} entries in total, got ${entries}.`);
}
/**
 * QwenAudioTTSEffectiveText: the text after hot_fix.replace, item by item and each item's words in code point order,
 * and its length. A replacement that would make the text longer than max is not made (ok false, with that length).
 */
export function qwenEffectiveText(text, hotFix, max = QWEN_TTS_MAX_TEXT) {
    let length = characters(text);
    if (!isObject(hotFix))
        return { text, characters: length, ok: length <= max };
    if (length > max)
        return { text, characters: length, ok: false };
    for (const item of Array.isArray(hotFix.replace) ? hotFix.replace : []) {
        const pair = isObject(item) ? item : {};
        for (const word of Object.keys(pair).sort((a, b) => byCodePoint(decoded(a), decoded(b)))) {
            const target = pair[word];
            if (typeof target !== 'string' || word === '')
                continue;
            const from = decoded(word), to = decoded(target);
            const hits = text.split(from).length - 1;
            if (!hits)
                continue;
            const projected = length + hits * (characters(to) - characters(from));
            if (projected > max)
                return { text, characters: projected, ok: false };
            text = text.split(from).join(to);
            length = projected;
        }
    }
    return { text, characters: length, ok: true };
}
/** Characters of json.Marshal(value): Go escapes <, > and & (HTML), U+2028 and U+2029, and control characters. */
export function goJSONCharacters(value) {
    if (typeof value === 'string') {
        let count = 2;
        for (const character of decoded(value)) {
            const code = character.codePointAt(0);
            count += character === '"' || character === '\\' || '\b\f\n\r\t'.includes(character) ? 2
                : code < 0x20 || character === '<' || character === '>' || character === '&' || code === 0x2028 || code === 0x2029 ? 6 : 1;
        }
        return count;
    }
    if (Array.isArray(value))
        return 2 + value.reduce((sum, item, i) => sum + (i ? 1 : 0) + goJSONCharacters(item), 0);
    if (isObject(value))
        return 2 + Object.entries(value).reduce((sum, [key, item], i) => sum + (i ? 1 : 0) + goJSONCharacters(key) + 1 + goJSONCharacters(item), 0);
    if (value === null)
        return 4;
    if (typeof value === 'boolean')
        return value ? 4 : 5;
    // checkHotFix leaves only objects, lists and strings; Go writes numbers differently from JavaScript.
    return invalid('hot_fix', 'hot_fix holds only objects, lists and strings.');
}
/**
 * The tokens the gateway reserves at submission for this input. The text is prompt, or input when prompt is empty;
 * the checks are the gateway's own before it reserves, which the documented parameters do not all cover.
 */
export function qwenTTSReservation(input) {
    const prompt = textParam(input, 'prompt'), alias = textParam(input, 'input');
    if (prompt !== '' && alias !== '' && prompt !== alias)
        invalid('input', 'prompt and input differ; send only one.');
    const text = prompt !== '' ? prompt : alias;
    if (blank(text))
        invalid('prompt', 'prompt is required.');
    if (characters(text) > QWEN_TTS_MAX_TEXT)
        invalid('prompt', `prompt must be at most ${QWEN_TTS_MAX_TEXT} characters, got ${characters(text)}.`);
    const instruction = textParam(input, 'instruction');
    const billed = billingCharacters(instruction);
    if (billed > MAX_INSTRUCTION)
        invalid('instruction', `instruction must be at most ${MAX_INSTRUCTION} billing characters (Han characters count as 2), got ${billed}.`);
    const hotFix = input.hot_fix === null ? undefined : input.hot_fix;
    if (hotFix !== undefined)
        checkHotFix(hotFix);
    const effective = qwenEffectiveText(text, hotFix);
    if (!effective.ok)
        invalid('hot_fix', `prompt must be at most ${QWEN_TTS_MAX_TEXT} characters after hot_fix.replace is applied, got ${effective.characters}.`);
    const hotFixCharacters = hotFix === undefined ? 0 : goJSONCharacters(hotFix);
    const expressive = instruction !== '' || effective.text.includes('[');
    const classes = { han: 0, caseless: 0, lower: 0, punctuation: 0, other: 0 };
    let inputTokens = BASE_INPUT_TOKENS + hotFixCharacters * 3, halves = BASE_OUTPUT_TOKENS * 2;
    for (const character of effective.text) {
        const kind = qwenCharacterClass(character);
        classes[kind]++;
        inputTokens += INPUT_TOKENS[kind];
        halves += OUTPUT_HALVES[kind][expressive ? 1 : 0];
    }
    return { tokens: { input_tokens: inputTokens, output_tokens: Math.ceil(halves / 2) }, characters: effective.characters, classes,
        hot_fix_characters: hotFixCharacters, expressive };
}
