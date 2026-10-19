// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { publicIdentifier, publicNumber, publicText } from './public-error.js';
import { publicTaskMessage } from './error-handler.js';
const STATUSES = new Set(['pending', 'processing', 'completed', 'failed', 'cancelled']);
const taskIdentifier = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
/** A failed read is not a failed generation or evidence about its charge. */
export class TaskResponseError extends Error {
    code;
    taskId;
    requestId;
    rawStatus;
    constructor(code, taskId, requestId, rawStatus) {
        super(code === 'task_identity_mismatch' ? 'The response did not match the requested task.'
            : code === 'task_status_unknown' ? 'The task status could not be verified.' : 'The task response could not be verified.');
        this.code = code;
        this.taskId = taskId;
        this.requestId = requestId;
        this.rawStatus = rawStatus;
        this.name = 'TaskResponseError';
    }
}
const outputSchema = {
    voice: 'id', voice_id: 'id', persona_id: 'id', result_id: 'id', id: 'id', title: 'text', tags: 'text',
    duration: 'number', seed: 'number', video_url: 'url', image_url: 'url', audio_url: 'url', stream_audio_url: 'url',
};
const schema = {
    model: 'text', object: 'text', type: 'text', created: 'number', progress: 'number', duration: 'number', video_duration: 'number',
    task_info: { can_cancel: 'boolean', estimated_time: 'number', video_duration: 'number' },
    usage: { billing_rule: 'text', credits_reserved: 'number', credits_used: 'number',
        cost: { credits: 'number', usd: 'number', cny: 'number' }, user_group: 'text' },
    billing: { charge_status: ['unknown', 'reserved', 'charged', 'released'],
        refund_status: ['unknown', 'not_required', 'pending', 'completed', 'failed'],
        refund_scope: ['account_balance'], limit_restoration: ['unknown'], reserved_credits: 'number', charged_credits: 'number',
        refunded_credits: 'number', refunded_at: 'text' },
    error: { code: 'text', message: 'task_message', type: 'text', suggestion: 'text' }, request_id: 'id',
};
function url(value) {
    if (typeof value !== 'string' || value.length > 16384)
        return;
    try {
        const parsed = new URL(value);
        if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password)
            return value;
    }
    catch { /* Invalid optional URLs are omitted without fetching them. */ }
}
function normalize(value, rule, path, warnings) {
    if (value === undefined)
        return;
    let result;
    if (rule === 'text')
        result = typeof value === 'string' ? publicText(value).slice(0, 2000) : undefined;
    else if (rule === 'task_message')
        result = publicTaskMessage(value);
    else if (rule === 'id')
        result = publicIdentifier(value);
    else if (rule === 'number')
        result = publicNumber(value);
    else if (rule === 'boolean')
        result = typeof value === 'boolean' ? value : undefined;
    else if (rule === 'url')
        result = url(value);
    else if (Array.isArray(rule))
        result = typeof value === 'string' && rule.includes(value) ? value : undefined;
    else if (record(value)) {
        const fields = {};
        for (const [key, child] of Object.entries(rule)) {
            const parsed = normalize(value[key], child, `${path}.${key}`, warnings);
            if (parsed !== undefined)
                fields[key] = parsed;
        }
        result = fields;
    }
    if (result === undefined)
        warnings.add(path);
    return result;
}
/** Project known public fields; model-specific omissions do not invalidate a task. */
export function parseTaskReceipt(value, requestId) {
    if (!record(value) || !taskIdentifier(value.id))
        throw new TaskResponseError('task_response_invalid', undefined, requestId);
    const warnings = new Set();
    const task = { id: value.id };
    for (const [key, rule] of Object.entries(schema)) {
        const parsed = normalize(value[key], rule, key, warnings);
        if (parsed !== undefined)
            task[key] = parsed;
    }
    if (typeof task.progress === 'number' && task.progress > 100) {
        delete task.progress;
        warnings.add('progress');
    }
    // Limit dates before consumers convert them to ISO strings.
    if (typeof task.created === 'number' && task.created > 253402300799) {
        delete task.created;
        warnings.add('created');
    }
    if (typeof value.status === 'string' && STATUSES.has(value.status))
        task.status = value.status;
    else
        warnings.add('status');
    if (value.results !== undefined) {
        if (Array.isArray(value.results)) {
            task.results = value.results.slice(0, 100).flatMap((item, index) => {
                const parsed = normalize(item, 'url', `results[${index}]`, warnings);
                return typeof parsed === 'string' ? [parsed] : [];
            });
            if (value.results.length > 100)
                warnings.add('results.truncated');
        }
        else
            warnings.add('results');
    }
    if (value.result_data !== undefined) {
        if (Array.isArray(value.result_data)) {
            task.result_data = value.result_data.slice(0, 100).flatMap((item, index) => {
                const parsed = normalize(item, outputSchema, `result_data[${index}]`, warnings);
                return parsed === undefined ? [] : [parsed];
            });
            if (value.result_data.length > 100)
                warnings.add('result_data.truncated');
        }
        else {
            const parsed = normalize(value.result_data, outputSchema, 'result_data', warnings);
            if (parsed !== undefined)
                task.result_data = parsed;
        }
    }
    if (requestId && publicIdentifier(requestId))
        task.request_id = requestId;
    if (warnings.size)
        task.response_warnings = [...warnings].slice(0, 100);
    return task;
}
export function parseTaskResponse(value, taskId, requestId) {
    if (!record(value) || !taskIdentifier(value.id))
        throw new TaskResponseError('task_response_invalid', taskId, requestId);
    if (value.id !== taskId)
        throw new TaskResponseError('task_identity_mismatch', taskId, requestId);
    if (typeof value.status !== 'string' || !STATUSES.has(value.status)) {
        const raw = typeof value.status === 'string' && /^[a-z_]{1,32}$/.test(value.status) ? value.status : undefined;
        throw new TaskResponseError('task_status_unknown', taskId, requestId, raw);
    }
    return parseTaskReceipt(value, requestId);
}
export function parseBatchTasks(value, taskIds, requestId) {
    if (!record(value) || !Array.isArray(value.data))
        throw new TaskResponseError('task_response_invalid', undefined, requestId);
    const requested = new Set(taskIds.filter(taskIdentifier)), counts = new Map();
    for (const item of value.data)
        if (record(item) && typeof item.id === 'string' && requested.has(item.id))
            counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    const tasks = [], issues = [];
    for (const item of value.data) {
        const id = record(item) && typeof item.id === 'string' && requested.has(item.id) ? item.id : undefined;
        if (!id) {
            issues.push({ code: 'unexpected_task_response' });
            continue;
        }
        if (counts.get(id) > 1) {
            if (!issues.some(issue => issue.task_id === id))
                issues.push({ task_id: id, code: 'duplicate_task_response' });
            continue;
        }
        try {
            tasks.push(parseTaskResponse(item, id, requestId));
        }
        catch (error) {
            issues.push({ task_id: id, code: error instanceof TaskResponseError ? error.code : 'task_response_invalid' });
        }
    }
    const found = new Set(tasks.map(task => task.id));
    return { tasks, missing: [...requested].filter(id => !found.has(id)), issues };
}
