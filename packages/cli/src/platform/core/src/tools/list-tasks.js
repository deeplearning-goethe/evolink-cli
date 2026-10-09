// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { listTasks, queryTasks } from '../services/api-client.js';
import { READ_ONLY, errorResult, failure, money, ok, usdOf } from './shared.js';
import { TASK_ID } from './get-task.js';
import { RESULT_DELIVERY_GUIDANCE, RESULT_DELIVERY_INSTRUCTIONS, RESULT_LINK_HOURS, resultDeliveryMarkdown, resultLinks, resultResources, taskOutputs } from './task-format.js';
const MAX_IDS = 50;
/** ISO 8601, unix seconds, or relative such as 30m, 2h, 1d. */
export function parseSince(value, now = Date.now()) {
    const trimmed = value.trim();
    const relative = /^(\d+)\s*(m|min|mins|minutes?|h|hours?|d|days?)$/i.exec(trimmed);
    if (relative) {
        const amount = Number(relative[1]);
        const unit = relative[2][0].toLowerCase();
        const factor = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
        const result = now - amount * factor;
        return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
    }
    if (/^\d{9,11}$/.test(trimmed))
        return Number(trimmed) * 1000;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function rowFromTask(task) {
    const row = { task_id: task.id, status: task.status, model: task.model, type: task.type, progress: task.progress };
    if (task.created)
        row.created_at = new Date(task.created * 1000).toISOString();
    const links = resultLinks(task);
    if (links.length > 0)
        row.results = links;
    const outputs = taskOutputs(task);
    if (outputs.length)
        row.outputs = outputs;
    if (task.status === 'completed' && links.length > 0)
        row.delivery_markdown = resultDeliveryMarkdown(task.id, links);
    const used = task.usage?.credits_used ?? task.usage?.cost?.credits;
    if (task.status === 'completed' && typeof used === 'number') {
        row.charged_credits = used;
        row.charged_usd = task.usage?.cost?.usd ?? usdOf(used);
    }
    if (task.error?.code)
        row.error_code = task.error.code;
    return row;
}
function rowLine(row) {
    const parts = [`- ${row.task_id}`, row.status === 'completed' || row.status === 'failed' ? row.status : `${row.status} ${row.progress ?? 0}%`, row.model];
    if (row.created_at)
        parts.push(row.created_at);
    if (row.charged_credits !== undefined)
        parts.push(`charged ${money(row.charged_credits)}`);
    if (row.error_code)
        parts.push(`error ${row.error_code}`);
    const lines = [parts.join(' · ')];
    for (const link of row.results ?? [])
        lines.push(`    ${link.kind}: ${link.url}`);
    return lines.join('\n');
}
export function registerListTasks(server, config) {
    server.registerTool('list_tasks', {
        title: 'List generation tasks',
        description: [
            'Read several tasks at once by task_ids (up to 50, with result links), or page through tasks by status, type and model. Free.',
            'since and until filter only the selected page by creation time. total is the server count before these time filters; an empty page does not prove a submission was absent.',
            'Use it to recover tasks after a lost connection or a timed-out submit before submitting anything again.',
            'Recent tasks cover the whole EvoLink account, newest first.',
            RESULT_DELIVERY_GUIDANCE,
        ].join(' '),
        inputSchema: {
            task_ids: z.array(z.string().regex(TASK_ID)).min(1).max(MAX_IDS).optional()
                .describe('Task IDs to read in one call (max 50).'),
            status: z.enum(['processing', 'completed', 'failed', 'cancelled']).optional()
                .describe('Without task_ids: only tasks in this state ("processing" includes queued tasks).'),
            type: z.enum(['image', 'video', 'audio']).optional()
                .describe('Without task_ids: only this kind of task.'),
            model: z.string().min(1).max(128).optional().describe('Without task_ids: exact model ID.'),
            page: z.number().int().min(1).max(100_000).optional().describe('Without task_ids: page number (default 1).'),
            since: z.string().min(1).max(40).optional()
                .describe('Without task_ids: only tasks created after this time, as ISO 8601 (2026-10-05T08:00:00Z) or relative (30m, 2h, 1d).'),
            until: z.string().min(1).max(40).optional().describe('Without task_ids: creation time upper bound, inclusive. Same formats as since.'),
            limit: z.number().int().min(1).max(MAX_IDS).default(20)
                .describe('Without task_ids: how many recent tasks to return (1–50, default 20).'),
        },
        annotations: { title: 'List generation tasks', ...READ_ONLY },
    }, async ({ task_ids, status, type, model, page: pageNumber, since, until, limit }) => {
        try {
            if (task_ids && [status, type, model, pageNumber, since, until].some(value => value !== undefined)) {
                return failure('Choose task_ids or list filters, not both.', { error: { category: 'invalid_request' } });
            }
            if (task_ids && task_ids.length > 0) {
                const unique = [...new Set(task_ids)];
                const tasks = await queryTasks(config, unique);
                const rows = tasks.map(rowFromTask);
                const found = new Set(rows.map(row => row.task_id));
                const missing = unique.filter(id => !found.has(id));
                const lines = [`${rows.length} of ${unique.length} tasks found.`, ...rows.map(rowLine)];
                if (missing.length > 0)
                    lines.push(`Not found (wrong ID, expired, or another account): ${missing.join(', ')}`);
                if (rows.some(row => row.results))
                    lines.push(`Result links expire after ${RESULT_LINK_HOURS} hours.`);
                if (rows.some(row => row.results))
                    lines.push(`Next step: ${RESULT_DELIVERY_INSTRUCTIONS}`);
                return ok(lines.join('\n'), { tasks: rows, missing }, rows.flatMap(row => resultResources(row.task_id, row.results ?? [])));
            }
            const now = Date.now();
            let sinceMs;
            if (since) {
                sinceMs = parseSince(since, now);
                if (sinceMs === undefined) {
                    return failure(`since "${since}" is not a time. Use ISO 8601 (2026-10-05T08:00:00Z) or a relative value such as 30m, 2h or 1d.`, {
                        error: { category: 'invalid_request', param: 'since' },
                    });
                }
            }
            const untilMs = until === undefined ? undefined : parseSince(until, now);
            if ((until !== undefined && untilMs === undefined) || (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs)) {
                return failure('until must be a valid time at or after since.', { error: { category: 'invalid_request', param: 'until' } });
            }
            const pageSize = limit ?? 20;
            const page = await listTasks(config, { status, type, model, page: pageNumber, pageSize });
            let items = page.data;
            if (sinceMs !== undefined)
                items = items.filter(item => item.created_at * 1000 >= sinceMs);
            if (untilMs !== undefined)
                items = items.filter(item => item.created_at * 1000 <= untilMs);
            // The list endpoint omits result links; read finished tasks in one batch to include them.
            const finished = items.filter(item => item.status === 'completed' && item.has_results).map(item => item.id).slice(0, MAX_IDS);
            const details = new Map();
            if (finished.length > 0) {
                for (const task of await queryTasks(config, finished))
                    details.set(task.id, task);
            }
            const rows = items.map(item => {
                const detailed = details.get(item.id);
                if (detailed)
                    return rowFromTask(detailed);
                const row = {
                    task_id: item.id,
                    status: item.status,
                    model: item.model,
                    type: item.type,
                    progress: item.progress,
                    created_at: new Date(item.created_at * 1000).toISOString(),
                };
                if (typeof item.credits_used === 'number' && item.status === 'completed') {
                    row.charged_credits = item.credits_used;
                    row.charged_usd = usdOf(item.credits_used);
                }
                if (item.has_error)
                    row.error_code = 'failed';
                return row;
            });
            const filters = [status && `status ${status}`, type && `type ${type}`, model && `model ${model}`, since && `since ${since}`, until && `until ${until}`].filter(Boolean).join(', ');
            const lines = [`${rows.length} recent task${rows.length === 1 ? '' : 's'} on this account${filters ? ` (${filters})` : ''}, newest first:`];
            lines.push(...(rows.length > 0 ? rows.map(rowLine) : ['(none)']));
            const nextPage = page.page * page.page_size < page.total ? page.page + 1 : null;
            lines.push(`Page ${page.page}; ${page.total} tasks before page-local time filtering.${nextPage ? ` Continue with page ${nextPage}.` : ''}`);
            if (rows.some(row => row.results))
                lines.push(`Result links expire after ${RESULT_LINK_HOURS} hours.`);
            if (rows.some(row => row.results))
                lines.push(`Next step: ${RESULT_DELIVERY_INSTRUCTIONS}`);
            return ok(lines.join('\n'), { tasks: rows, total: page.total, page: page.page, page_size: page.page_size,
                next_page: nextPage, time_filter_scope: 'selected_page', total_scope: 'server_filters_before_time_filter',
            }, rows.flatMap(row => resultResources(row.task_id, row.results ?? [])));
        }
        catch (error) {
            return errorResult(error);
        }
    });
}
