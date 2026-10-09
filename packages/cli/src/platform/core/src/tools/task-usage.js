// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { listTasks } from '../services/api-client.js';
import { parseSince } from './list-tasks.js';
import { READ_ONLY, errorResult, failure, ok, usdOf } from './shared.js';
const empty = () => ({ tasks: 0, completed: 0, cost_reported_tasks: 0, missing_cost_tasks: 0, reported_credits: 0 });
function add(totals, task) {
    totals.tasks++;
    if (task.status !== 'completed')
        return;
    totals.completed++;
    if (typeof task.credits_used === 'number' && Number.isFinite(task.credits_used) && task.credits_used >= 0) {
        if (!Number.isFinite(totals.reported_credits + task.credits_used)) {
            throw new Error('The reported task cost total cannot be represented safely; no usage total is returned.');
        }
        totals.cost_reported_tasks++;
        totals.reported_credits += task.credits_used;
    }
    else
        totals.missing_cost_tasks++;
}
export function registerTaskUsage(server, config) {
    server.registerTool('get_task_usage', {
        title: 'Summarize reported task usage',
        description: 'Free account-wide task summary by creation time and model. Scans at most max_pages × 50 retained tasks. Reports completed-task credits and missing costs. This is not an invoice, payment/refund ledger, MCP-only usage, or a settlement budget. Retention, concurrent changes and the scan bound can make it incomplete.',
        inputSchema: {
            since: z.string().min(1).max(40).default('30d').describe('Creation time lower bound: ISO 8601, Unix seconds or relative (30d).'),
            until: z.string().min(1).max(40).optional().describe('Inclusive creation time upper bound, default now.'),
            model: z.string().min(1).max(128).optional().describe('Exact model ID.'),
            type: z.enum(['image', 'video', 'audio']).optional(),
            max_pages: z.number().int().min(1).max(20).default(5).describe('Scan bound (1–20 pages of 50 tasks, default 5).'),
        },
        annotations: { title: 'Summarize reported task usage', ...READ_ONLY },
    }, async ({ since, until, model, type, max_pages }, extra) => {
        const now = Date.now();
        const from = parseSince(since, now);
        const to = until === undefined ? now : parseSince(until, now);
        if (from === undefined || to === undefined || from > to) {
            return failure('Use a valid since/until creation-time interval, with since at or before until.', { error: { category: 'invalid_request', param: 'since/until' } });
        }
        try {
            const totals = empty();
            const models = new Map();
            const statuses = Object.create(null);
            const seen = new Set();
            let pages = 0, serverTotal = 0, changed = false, invalidRows = 0, exhausted = false;
            for (let page = 1; page <= max_pages; page++) {
                if (pages && Date.now() - now > 40_000)
                    break;
                if (extra.signal.aborted)
                    throw new Error('Stopped reading task usage. Retry this read to obtain a summary.');
                const batch = await listTasks(config, { model, type, page, pageSize: 50 }, 'get_task_usage', { timeoutMs: Math.max(1, Math.min(5_000, 40_000 - (Date.now() - now))), retries: 0 });
                if (pages && serverTotal !== batch.total)
                    changed = true;
                serverTotal = batch.total;
                pages++;
                if (batch.page !== page || batch.page_size !== 50 || batch.data.length > 50) {
                    return failure('The task pagination could not be verified; no usage total is returned.', { error: { category: 'server_error' } });
                }
                for (const task of batch.data) {
                    if (typeof task.id !== 'string' || typeof task.model !== 'string' || !Number.isSafeInteger(task.created_at) || task.created_at < 0 || typeof task.status !== 'string') {
                        invalidRows++;
                        continue;
                    }
                    if (seen.has(task.id)) {
                        changed = true;
                        continue;
                    }
                    seen.add(task.id);
                    if ((model && task.model !== model) || (type && task.type !== type)) {
                        invalidRows++;
                        continue;
                    }
                    const created = task.created_at * 1000;
                    if (created < from || created > to)
                        continue;
                    add(totals, task);
                    const group = models.get(task.model) ?? empty();
                    add(group, task);
                    models.set(task.model, group);
                    statuses[task.status] = (statuses[task.status] ?? 0) + 1;
                }
                if (page * 50 >= batch.total || batch.data.length === 0) {
                    exhausted = seen.size === batch.total;
                    break;
                }
            }
            const complete = exhausted && !changed && invalidRows === 0;
            const rounded = (value) => ({ ...value, reported_credits: Number(value.reported_credits.toFixed(6)), reported_usd_approx: usdOf(value.reported_credits) });
            const note = 'Account-wide retained tasks, grouped by creation time. Completed-task reported costs only; excludes pending reservations, payments, refunds and non-task charges. USD is approximate (68 credits ≈ $1). This is not a bill or a final spending limit.';
            return ok(`${totals.tasks} tasks in the scanned creation-time interval; ${totals.completed} completed. Reported completed-task cost: ${rounded(totals).reported_credits} credits. ${totals.missing_cost_tasks} completed tasks have no valid cost.\nCoverage: ${complete ? 'all currently retained matching tasks scanned' : 'incomplete; do not treat this as a full total'}.\n${note}`, {
                scope: 'account_retained_task_summary', as_of: new Date(now).toISOString(),
                interval: { since: new Date(from).toISOString(), until: new Date(to).toISOString(), basis: 'task_creation_time' },
                filters: { model, type }, totals: rounded(totals), by_status: statuses,
                by_model: [...models].sort(([a], [b]) => a.localeCompare(b)).map(([id, group]) => ({ model: id, ...rounded(group) })),
                coverage: { complete_for_retained_tasks: complete, historical_completeness: 'unknown', scanned_pages: pages,
                    scanned_unique_tasks: seen.size, server_total: serverTotal, max_pages, truncated: !exhausted,
                    concurrent_change_detected: changed, invalid_rows: invalidRows },
                consistent_snapshot_guaranteed: false,
                is_bill: false, final_budget_enforced: false, note,
            });
        }
        catch (error) {
            return errorResult(error);
        }
    });
}
