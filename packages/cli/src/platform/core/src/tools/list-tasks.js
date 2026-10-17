// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { listTasks, queryTasks } from '../services/api-client.js';
import { publicTaskErrorCode } from '../services/error-handler.js';
import { parseBatchTasks } from '../services/task-response.js';
import { DASHBOARD_CHECK_GUIDANCE, READ_ONLY, dashboardCheck, errorResult, failure, money, ok, usdOf } from './shared.js';
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
    if (task.response_warnings?.length)
        row.response_warnings = task.response_warnings;
    if (task.created !== undefined)
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
    // The same user-facing code as get_task, never an upstream channel code.
    if (task.status === 'failed' || task.error?.code)
        row.error_code = publicTaskErrorCode(task.error?.code);
    return row;
}
function rowLine(row) {
    const parts = [`- ${row.task_id}`, `${row.status}${!['completed', 'failed'].includes(row.status) && row.progress !== undefined ? ` ${row.progress}%` : ''}`];
    if (row.model)
        parts.push(row.model);
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
            'partial means some rows or details could not be verified. Retain verified tasks and the base page, disclose incomplete coverage and query the original missing or details_missing IDs. Missing costs are not zero; do not regenerate to repair a read.',
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
                const rows = tasks.tasks.map(rowFromTask);
                const missing = tasks.missing;
                const lines = [`${rows.length} of ${unique.length} tasks found.`, ...rows.map(rowLine)];
                if (missing.length > 0)
                    lines.push(`Not verified or absent from this response: ${missing.join(', ')}. This does not prove the tasks were never submitted. Query these original IDs again; do not generate again.`);
                if (tasks.issues.length)
                    lines.push('Some task responses were invalid or conflicting and were omitted. Verified tasks are retained.');
                if (rows.some(row => row.response_warnings))
                    lines.push('Some optional fields were omitted; missing values do not mean zero. See response_warnings.');
                const websiteCheck = missing.length > 0 || tasks.issues.length > 0 || rows.some(row => row.response_warnings || ['failed', 'cancelled'].includes(row.status));
                if (websiteCheck)
                    lines.push(DASHBOARD_CHECK_GUIDANCE);
                if (rows.some(row => row.results))
                    lines.push(`Result links expire after ${RESULT_LINK_HOURS} hours.`);
                if (rows.some(row => row.results))
                    lines.push(`Next step: ${RESULT_DELIVERY_INSTRUCTIONS}`);
                return ok(lines.join('\n'), { tasks: rows, missing, partial: missing.length > 0 || tasks.issues.length > 0, issues: tasks.issues,
                    ...(websiteCheck ? dashboardCheck() : {}),
                }, rows.flatMap(row => resultResources(row.task_id, row.results ?? [])));
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
            // Compact rows have the same identity/state boundary, but do not need detail-only fields.
            const compact = parseBatchTasks({ data: page.data.map(item => item && typeof item === 'object'
                    ? { ...item, created: item.created_at, usage: { credits_used: item.credits_used } } : item) }, page.data.flatMap(item => item && typeof item.id === 'string' ? [item.id] : []));
            let items = compact.tasks;
            const issues = [...compact.issues];
            if (sinceMs !== undefined || untilMs !== undefined) {
                items = items.filter(item => {
                    if (item.created === undefined) {
                        issues.push({ task_id: item.id, code: 'task_creation_time_unverified' });
                        return false;
                    }
                    return (sinceMs === undefined || item.created * 1000 >= sinceMs) && (untilMs === undefined || item.created * 1000 <= untilMs);
                });
            }
            // The list endpoint omits result links and error codes; read those tasks in one batch to include them.
            const finished = items.filter(item => item.status === 'completed' && page.data.some(raw => raw?.id === item.id && raw.has_results === true) || item.status === 'failed')
                .map(item => item.id).slice(0, MAX_IDS);
            const details = new Map();
            let detailsMissing = [];
            if (finished.length > 0) {
                try {
                    const batch = await queryTasks(config, finished);
                    for (const task of batch.tasks)
                        details.set(task.id, task);
                    detailsMissing = batch.missing;
                    issues.push(...batch.issues);
                }
                catch {
                    detailsMissing = finished;
                    issues.push({ code: 'task_details_unavailable' });
                }
            }
            const rows = items.map(item => {
                const detailed = details.get(item.id);
                if (detailed)
                    return rowFromTask(detailed);
                const row = rowFromTask(item);
                // Compact pages do not establish a detailed execution error code.
                delete row.error_code;
                if (detailsMissing.includes(item.id))
                    row.details_available = false;
                return row;
            });
            const filters = [status && `status ${status}`, type && `type ${type}`, model && `model ${model}`, since && `since ${since}`, until && `until ${until}`].filter(Boolean).join(', ');
            const lines = [`${rows.length} recent task${rows.length === 1 ? '' : 's'} on this account${filters ? ` (${filters})` : ''}, newest first:`];
            lines.push(...(rows.length > 0 ? rows.map(rowLine) : ['(none)']));
            if (issues.length || detailsMissing.length)
                lines.push(`Partial response: verified base rows were retained; some rows or details could not be verified. Missing details: ${detailsMissing.join(', ') || 'none'}. Query the original IDs again; do not infer zero usage or generate again.`);
            if (rows.some(row => row.response_warnings))
                lines.push('Some optional fields were omitted; missing values do not mean zero. See response_warnings.');
            const websiteCheck = issues.length > 0 || detailsMissing.length > 0 || rows.some(row => row.response_warnings || ['failed', 'cancelled'].includes(row.status));
            if (websiteCheck)
                lines.push(DASHBOARD_CHECK_GUIDANCE);
            const nextPage = page.page * page.page_size < page.total ? page.page + 1 : null;
            lines.push(`Page ${page.page}; ${page.total} tasks before page-local time filtering.${nextPage ? ` Continue with page ${nextPage}.` : ''}`);
            if (rows.some(row => row.results))
                lines.push(`Result links expire after ${RESULT_LINK_HOURS} hours.`);
            if (rows.some(row => row.results))
                lines.push(`Next step: ${RESULT_DELIVERY_INSTRUCTIONS}`);
            return ok(lines.join('\n'), { tasks: rows, total: page.total, page: page.page, page_size: page.page_size,
                next_page: nextPage, time_filter_scope: 'selected_page', total_scope: 'server_filters_before_time_filter',
                partial: issues.length > 0 || detailsMissing.length > 0, issues, details_missing: detailsMissing,
                ...(websiteCheck ? dashboardCheck() : {}),
            }, rows.flatMap(row => resultResources(row.task_id, row.results ?? [])));
        }
        catch (error) {
            const result = errorResult(error, { phase: 'query' });
            if (task_ids) {
                result.structuredContent = { ...result.structuredContent, requested_task_ids: [...new Set(task_ids)],
                    phase: 'query', status_check: 'unverified' };
            }
            return result;
        }
    });
}
