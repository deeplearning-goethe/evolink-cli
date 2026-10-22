// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { currentRequestCredentials } from '../request-context.js';
import { DEFAULT_READ_TIMEOUT_MS, monotonicNow, timeoutFromEnv } from '../services/http-policy.js';
import { READ_ONLY, errorResult, errorSummary, ok, progressReporter } from './shared.js';
import { RESULT_DELIVERY_GUIDANCE, TERMINAL_STATUSES, describeTask, setCallDeadline, waitForTask } from './task-format.js';
export const TASK_ID = /^[A-Za-z0-9._:-]{4,128}$/;
/** Codex and Cursor drop a tool call after about 60 s; the reply also needs time to travel. */
export const MAX_WAIT_SECONDS = 45;
const REPLY_MARGIN_MS = 2_000;
const PROGRESS_EVERY_SECONDS = 10;
/**
 * The monotonic deadline of one get_task call. A positive wait covers its reads, retries, pauses and polls,
 * keeping a reply margin that shrinks with short windows (a 1 s wait keeps 100 ms, not 2 s). wait_seconds 0
 * reads once within the read timeout. An embedding host's own deadline (the CLI's tasks wait) is never exceeded.
 */
export function getTaskDeadline(startedMs, waitSeconds, outerDeadline) {
    const singleRead = waitSeconds <= 0;
    const windowMs = singleRead ? timeoutFromEnv('EVOLINK_MCP_READ_TIMEOUT_MS', DEFAULT_READ_TIMEOUT_MS) : waitSeconds * 1000;
    const own = startedMs + windowMs - (singleRead ? 0 : Math.min(REPLY_MARGIN_MS, Math.round(windowMs / 10)));
    return { deadline: outerDeadline === undefined ? own : Math.min(own, outerDeadline), singleRead };
}
export function registerGetTask(server, config) {
    server.registerTool('get_task', {
        title: 'Get task status and results',
        description: [
            'Check one generation task and, while it is still running, wait up to wait_seconds (max 45) for it to finish. Free.',
            'Returns the status, progress, result links (they expire after 24 hours, so give them to the user right away), the final charge, or the error with a next step.',
            'If the task is still running when this returns, call get_task again. wait_seconds bounds the whole call, including retries; stopping a wait never cancels the task.',
            'Invalid bodies, mismatched IDs and unknown states return a query error with the original task ID and status_check unverified. Retry the free query; do not infer generation failure, zero charge or a refund. Missing optional fields are not zero. Completed resource tasks may return voice/persona IDs without links.',
            'Never call generate_image, generate_video or generate_audio again to check progress: that creates and charges a new task.',
            RESULT_DELIVERY_GUIDANCE,
        ].join(' '),
        inputSchema: {
            task_id: z.string().regex(TASK_ID).describe('task_id returned by generate_image, generate_video or generate_audio'),
            wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(30)
                .describe('How long this call may wait for the task to finish (0–45 s, default 30), including reads and retries. Use 0 for one read without waiting for the task; that read can still take up to the read timeout (15 s by default).'),
        },
        annotations: { title: 'Get task status and results', ...READ_ONLY },
    }, async ({ task_id, wait_seconds }, extra) => {
        const started = monotonicNow();
        const waitSeconds = Math.min(wait_seconds ?? 30, MAX_WAIT_SECONDS);
        const report = progressReporter(extra, waitSeconds);
        let lastReport = -PROGRESS_EVERY_SECONDS;
        try {
            const { deadline, singleRead } = getTaskDeadline(started, waitSeconds, currentRequestCredentials()?.http?.deadline);
            setCallDeadline(extra, deadline);
            const waited = await waitForTask(config, task_id, {
                deadline,
                singleRead,
                tool: 'get_task',
                signal: extra.signal,
                onPoll: async (current) => {
                    const elapsed = (monotonicNow() - started) / 1000;
                    if (elapsed - lastReport < PROGRESS_EVERY_SECONDS)
                        return;
                    lastReport = elapsed;
                    await report(elapsed, `${current.status}${current.progress !== undefined ? `, ${current.progress}%` : ''}`);
                },
            });
            const { task } = waited;
            const view = describeTask(task, waited.statusCheck);
            const waitedSeconds = Math.round((monotonicNow() - started) / 1000);
            if (waited.statusCheck === 'unverified') {
                view.lines.splice(1, 0, `Waited ${waitedSeconds} s. The last verified status was ${task.status} (read at ${waited.readAt}); a later read ${waited.ended === 'deadline' ? 'did not finish within the wait limit' : 'failed'}, so the latest status is unverified. Stopping this wait does not cancel the task.`);
                Object.assign(view.structured, { read_at: waited.readAt, wait_ended: waited.ended, waited_seconds: waitedSeconds,
                    last_read_error: errorSummary(waited.readError) });
            }
            else if (!TERMINAL_STATUSES.has(task.status)) {
                if (waitSeconds > 0)
                    view.lines.splice(1, 0, `Still running after waiting ${waitedSeconds} s (status read at ${waited.readAt}).`);
                Object.assign(view.structured, { read_at: waited.readAt,
                    ...(waitSeconds > 0 ? { waited_seconds: waitedSeconds, wait_ended: waited.ended } : {}) });
            }
            return ok(view.lines.join('\n'), view.structured, view.resources);
        }
        catch (error) {
            return errorResult(error, { phase: 'query', taskId: task_id });
        }
    });
}
