// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
// The gateway decides whether a Midjourney V7 edit is promptless after removing controlled parameters
// (provider SDK EffectiveMJV7EditPrompt, which wraps cleanRemixPrompt in provider/client_youchuan.go).
// These patterns keep the SDK's boundaries: RE2 \s is ASCII only, (?i) folds the long s (U+017F) with s, and Go's
// strings.TrimSpace removes NEL but not BOM, unlike String.prototype.trim.
const space = '[\\t\\n\\f\\r ]';
const nonSpace = '[^\\t\\n\\f\\r ]';
const fold = (words) => words.replace(/s/g, '[s\u017f]');
const forbidden = new RegExp(`${space}*--(${fold('version|v')})${space}*${nonSpace}+|${space}*--niji(?:${space}+\\d+)?\\b`, 'gi');
const billing = new RegExp(`${space}*--(${fold('fast|turbo|draft|relax')})\\b`, 'gi');
const unsupportedArgs = new RegExp(`${space}*--(${fold('stop|cref|cw|repeat|r|personalize|p')})\\b(?:${space}+${nonSpace}+)?`, 'gi');
const unsupportedFlags = new RegExp(`${space}*--(${fold('stealth|public')})\\b`, 'gi');
const goTrimSpace = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
/** The prompt text a Midjourney V7 edit keeps; an empty result runs and bills the edit as fast. */
export function effectiveMjV7EditPrompt(prompt) {
    return prompt.replace(forbidden, '').replace(billing, '').replace(unsupportedArgs, '').replace(unsupportedFlags, '').replace(goTrimSpace, '');
}
