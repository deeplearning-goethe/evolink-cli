// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
/** Parameters an assistant may not set through MCP, with the reason shown to it. */
const BLOCKED_PARAMS = {
    callback_url: 'callbacks are not available through MCP; use get_task to wait for the result',
};
/** Levenshtein distance, capped for long strings. */
function distance(a, b) {
    if (a === b)
        return 0;
    const rows = a.length + 1;
    const cols = b.length + 1;
    let previous = Array.from({ length: cols }, (_, j) => j);
    for (let i = 1; i < rows; i++) {
        const current = [i];
        for (let j = 1; j < cols; j++) {
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        previous = current;
    }
    return previous[cols - 1];
}
/** Up to `limit` candidates that look like `value`, best first. */
export function closestMatches(value, candidates, limit = 3) {
    const needle = value.toLowerCase();
    return candidates
        .map(candidate => {
        const lower = candidate.toLowerCase();
        const contains = lower.includes(needle) || needle.includes(lower);
        const score = distance(needle, lower) / Math.max(needle.length, lower.length, 1) - (contains ? 0.5 : 0);
        return { candidate, score };
    })
        .filter(item => item.score <= 0.45)
        .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
        .slice(0, limit)
        .map(item => item.candidate);
}
function describeType(type) {
    return type.split('|').map(part => (part === 'integer' ? 'a whole number' : part === 'array' ? 'a list' : `a ${part}`)).join(' or ');
}
function matchesType(type, value) {
    if (!type)
        return true;
    return type.split('|').some(part => {
        switch (part) {
            case 'string': return typeof value === 'string';
            case 'integer': return typeof value === 'number' && Number.isInteger(value);
            case 'number': return typeof value === 'number' && Number.isFinite(value);
            case 'boolean': return typeof value === 'boolean';
            case 'array': return Array.isArray(value);
            case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
            case 'null': return value === null;
            default: return true;
        }
    });
}
function show(value) {
    const json = JSON.stringify(value);
    return json && json.length > 60 ? `${json.slice(0, 57)}…` : json ?? String(value);
}
function checkValue(name, spec, value, result) {
    if (value === undefined)
        return;
    if (spec.anyOf?.length) {
        const alternatives = spec.anyOf.map(option => {
            const branch = { errors: [], warnings: [] };
            checkValue(name, option, value, branch);
            return branch;
        });
        if (alternatives.every(branch => branch.errors.length > 0)) {
            result.errors.push({ param: name, problem: `must match one of the documented alternatives (${alternatives.map(branch => branch.errors.map(issue => issue.problem).join(' ')).join(' OR ')}).` });
            return;
        }
    }
    if (!matchesType(spec.type, value)) {
        const numericString = typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value));
        const hint = numericString && /integer|number/.test(spec.type ?? '') ? ` Use ${Number(value)} (a number), not "${value}".` : '';
        result.errors.push({ param: name, problem: `must be ${describeType(spec.type)}, got ${show(value)}.${hint}` });
        return;
    }
    if (spec.enum && spec.enum.length > 0 && (typeof value !== 'object' || value === null)) {
        if (!spec.enum.some(option => option === value)) {
            const caseMatch = typeof value === 'string'
                ? spec.enum.find(option => typeof option === 'string' && option.toLowerCase() === value.toLowerCase())
                : undefined;
            result.errors.push({
                param: name,
                problem: caseMatch !== undefined
                    ? `use ${show(caseMatch)} (values are case-sensitive), got ${show(value)}.`
                    : `must be one of ${spec.enum.map(show).join(', ')}; got ${show(value)}.`,
            });
            return;
        }
    }
    if (typeof value === 'number') {
        if (spec.minimum !== undefined && value < spec.minimum)
            result.errors.push({ param: name, problem: `must be at least ${spec.minimum}, got ${value}.` });
        if (spec.maximum !== undefined && value > spec.maximum)
            result.errors.push({ param: name, problem: `must be at most ${spec.maximum}, got ${value}.` });
        if (spec.exclusiveMinimum !== undefined && value <= spec.exclusiveMinimum)
            result.errors.push({ param: name, problem: `must be greater than ${spec.exclusiveMinimum}, got ${value}.` });
        if (spec.exclusiveMaximum !== undefined && value >= spec.exclusiveMaximum)
            result.errors.push({ param: name, problem: `must be less than ${spec.exclusiveMaximum}, got ${value}.` });
    }
    if (typeof value === 'string') {
        if (spec.maxLength !== undefined && value.length > spec.maxLength) {
            result.warnings.push({ param: name, problem: `is ${value.length} characters; the documented limit is ${spec.maxLength}. The gateway may reject it.` });
        }
        if (spec.minLength !== undefined && value.length < spec.minLength) {
            result.errors.push({ param: name, problem: `must be at least ${spec.minLength} characters.` });
        }
    }
    if (Array.isArray(value)) {
        if (spec.maxItems !== undefined && value.length > spec.maxItems)
            result.errors.push({ param: name, problem: `allows at most ${spec.maxItems} items, got ${value.length}.` });
        if (spec.minItems !== undefined && value.length < spec.minItems)
            result.errors.push({ param: name, problem: `needs at least ${spec.minItems} items, got ${value.length}.` });
        const items = spec.items;
        if (items) {
            value.forEach((item, position) => {
                checkValue(`${name}[${position}]`, { type: items.type, enum: items.enum, properties: items.properties }, item, result);
            });
        }
    }
    if (spec.properties && value && typeof value === 'object' && !Array.isArray(value)) {
        checkObject(name, spec.properties, value, result);
    }
}
function checkObject(prefix, properties, value, result) {
    const known = Object.keys(properties);
    for (const [key, nested] of Object.entries(value)) {
        const spec = properties[key];
        const path = prefix ? `${prefix}.${key}` : key;
        if (!spec) {
            const suggestions = closestMatches(key, known);
            result.errors.push({
                param: path,
                problem: `is not a parameter here.${suggestions.length ? ` Did you mean ${suggestions.map(s => `"${s}"`).join(' or ')}?` : ''} Allowed: ${known.join(', ') || 'none'}.`,
            });
            continue;
        }
        checkValue(path, spec, nested, result);
    }
    for (const [key, spec] of Object.entries(properties)) {
        if (spec.required && value[key] === undefined) {
            result.errors.push({ param: prefix ? `${prefix}.${key}` : key, problem: 'is required.' });
        }
    }
}
/**
 * Checks a generation input against the documented parameters before
 * anything is sent: unknown names, wrong types, values outside the documented
 * choices or ranges. The gateway still validates the request in full.
 */
export function validateInput(spec, input) {
    const result = { errors: [], warnings: [] };
    const rest = {};
    for (const [key, value] of Object.entries(input)) {
        if (key === 'model') {
            if (value !== undefined && value !== spec.model) {
                result.errors.push({ param: 'model', problem: `set the model with the model argument, not inside input (input has ${show(value)}).` });
            }
            continue;
        }
        if (BLOCKED_PARAMS[key]) {
            result.errors.push({ param: key, problem: `${BLOCKED_PARAMS[key]}.` });
            continue;
        }
        rest[key] = value;
    }
    checkObject('', spec.params, rest, result);
    for (const group of spec.constraints?.mutuallyExclusive ?? []) {
        const present = group.filter(name => Array.isArray(rest[name]) ? rest[name].length > 0 : rest[name] !== undefined && rest[name] !== null && rest[name] !== '');
        if (present.length > 1)
            result.errors.push({ param: present.join(', '), problem: 'are mutually exclusive; pass only one reference type.' });
    }
    const size = spec.constraints?.imageSize;
    const value = size ? rest[size.param] : undefined;
    if (size && typeof value === 'string' && !size.allowed.includes(value)) {
        const pixels = /^(\d+)[x×](\d+)$/.exec(value);
        if (!pixels || !size.allowPixels) {
            result.errors.push({ param: size.param, problem: `must be one of ${size.allowed.join(', ')}${size.allowPixels ? ', or a valid WxH pixel size' : ''}.` });
        }
        else {
            const width = Number(pixels[1]), height = Number(pixels[2]), total = width * height;
            if (!Number.isSafeInteger(total) || width < size.minEdge || height < size.minEdge || width > size.maxEdge || height > size.maxEdge
                || width % size.step !== 0 || height % size.step !== 0 || total < size.minPixels || total > size.maxPixels
                || Math.max(width, height) > size.maxRatio * Math.min(width, height)) {
                result.errors.push({ param: size.param, problem: `requires edges ${size.minEdge}–${size.maxEdge}, multiples of ${size.step}, ${size.minPixels}–${size.maxPixels} pixels, and an aspect ratio at most ${size.maxRatio}:1.` });
            }
        }
    }
    if (size?.ratioResolution && typeof value === 'string' && value !== 'auto' && rest.resolution !== undefined
        && String(rest.resolution).toUpperCase() !== size.ratioResolution) {
        result.errors.push({ param: 'resolution', problem: `must be ${size.ratioResolution} when size is a ratio.` });
    }
    return result;
}
export function formatIssues(issues) {
    return issues.map(issue => `- ${issue.param} ${issue.problem}`);
}
