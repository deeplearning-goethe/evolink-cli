// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { queryTask } from '../services/api-client.js';
import { getTaskErrorInfo } from '../services/error-handler.js';
import { money, sleep, usdOf } from './shared.js';
/** Result links from the gateway stay downloadable for this long. */
export const RESULT_LINK_HOURS = 24;
/** Generation permission does not also authorize the assistant to alter the output. */
export const RESULT_DELIVERY_INSTRUCTIONS = [
    'Deliver the original EvoLink result links immediately on completion, with clear view/download labels and the 24-hour expiry notice. Use delivery_markdown as the primary reply when supplied.',
    'Do not delay delivery for inspection or post-processing. A generation request alone does not authorize local editing, compositing, repair or re-encoding; do that only when the user explicitly requests or authorizes post-processing.',
    'Report quality issues and offer options. Keep the original links and label any authorized edited version separately.',
    'Default to ordinary Markdown links for all media, including images; do not automatically add inline remote images or thumbnail placeholders. Only add an image preview when the user requests it and a supported working client preview route is available; otherwise keep the links.',
    'The server may supply small embedded MCP image thumbnails or video cover frames alongside the original links. These optional previews are not edited replacements; let the client display them and keep delivery_markdown and the original download links in the reply. Do not turn preview metadata into remote Markdown images.',
    'Use ordinary Markdown links for video/audio, never image syntax for a video URL. Inline previews depend on the client; do not promise them.',
    'When a requested local download uses Python urllib, explicitly set a truthful product User-Agent (for example EvoLinkClient/1.0) with urllib.request.Request instead of its default Python UA. Do not forward API keys or Authorization headers to media URLs. If 403/1010 persists, report it rather than regenerating or retrying blindly; client-controlled previews may need a separate fix. Downloading is optional and must not delay original-link delivery.',
].join(' ');
/** Compact tool description; the full contract is sent in server instructions and completed results. */
export const RESULT_DELIVERY_GUIDANCE = 'On completion, promptly deliver original links with the 24-hour expiry and delivery_markdown. Edit only when the user explicitly requests or authorizes post-processing. Keep original links alongside optional embedded MCP thumbnails; do not add remote-image Markdown or use image syntax for video/audio.';
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const MEDIA_EXTENSIONS = {
    png: { kind: 'image', mimeType: 'image/png' },
    jpg: { kind: 'image', mimeType: 'image/jpeg' },
    jpeg: { kind: 'image', mimeType: 'image/jpeg' },
    webp: { kind: 'image', mimeType: 'image/webp' },
    gif: { kind: 'image', mimeType: 'image/gif' },
    bmp: { kind: 'image', mimeType: 'image/bmp' },
    mp4: { kind: 'video', mimeType: 'video/mp4' },
    mov: { kind: 'video', mimeType: 'video/quicktime' },
    webm: { kind: 'video', mimeType: 'video/webm' },
    m4v: { kind: 'video', mimeType: 'video/x-m4v' },
    mp3: { kind: 'audio', mimeType: 'audio/mpeg' },
    wav: { kind: 'audio', mimeType: 'audio/wav' },
    m4a: { kind: 'audio', mimeType: 'audio/mp4' },
    flac: { kind: 'audio', mimeType: 'audio/flac' },
    ogg: { kind: 'audio', mimeType: 'audio/ogg' },
    aac: { kind: 'audio', mimeType: 'audio/aac' },
};
/** Infer metadata from the path only: a signed query or fragment is not a file extension. */
function mediaOfUrl(url) {
    try {
        const extension = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1].toLowerCase();
        return extension && Object.prototype.hasOwnProperty.call(MEDIA_EXTENSIONS, extension) ? MEDIA_EXTENSIONS[extension] : undefined;
    }
    catch {
        return undefined;
    }
}
function kindOfUrl(url, taskType, hint) {
    const media = mediaOfUrl(url);
    if (media)
        return media.kind;
    if (hint)
        return hint;
    if (taskType.includes('image'))
        return 'image';
    if (taskType.includes('video'))
        return 'video';
    if (taskType.includes('audio') || taskType.includes('music'))
        return 'audio';
    return 'file';
}
export function resultLinks(task) {
    const seen = new Set();
    const links = [];
    const add = (url, kind) => {
        if (typeof url !== 'string' || !/^https?:\/\//.test(url) || seen.has(url))
            return;
        seen.add(url);
        links.push({ url, kind: kindOfUrl(url, task.type ?? '', kind) });
    };
    for (const url of task.results ?? [])
        add(url);
    if (task.result_data) {
        const items = Array.isArray(task.result_data) ? task.result_data : [task.result_data];
        for (const item of items) {
            if (!item || typeof item !== 'object')
                continue;
            add(item.video_url, 'video');
            add(item.image_url, 'image');
            add(item.audio_url, 'audio');
        }
    }
    return links;
}
/** Return reusable public result fields without forwarding provider metadata or account details. */
export function taskOutputs(task) {
    const items = Array.isArray(task.result_data) ? task.result_data : task.result_data ? [task.result_data] : [];
    const identifiers = new Set(['voice', 'voice_id', 'persona_id', 'result_id', 'id']);
    const textFields = new Set(['title', 'tags']);
    const urls = new Set(['video_url', 'image_url', 'audio_url', 'stream_audio_url']);
    return items.slice(0, 100).flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return [];
        const output = {};
        for (const [key, value] of Object.entries(item)) {
            if (identifiers.has(key) && typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value))
                output[key] = value;
            else if (textFields.has(key) && typeof value === 'string')
                output[key] = value.slice(0, 1000);
            else if (urls.has(key) && typeof value === 'string' && /^https?:\/\//.test(value))
                output[key] = value;
            else if ((key === 'duration' || key === 'seed') && typeof value === 'number' && Number.isFinite(value) && value >= 0)
                output[key] = value;
        }
        return Object.keys(output).length ? [output] : [];
    });
}
/** Typed links complement the text fallback; they do not guarantee a client preview.
 * Never fetch or transform media here, and never wrap a video URL in ImageContent.
 * Unknown extensions deliberately omit MIME instead of guessing a container.
 */
export function resultResources(taskId, links) {
    return links.map((link, index) => {
        const media = mediaOfUrl(link.url);
        return {
            type: 'resource_link',
            uri: link.url,
            name: `View/download original ${link.kind} ${index + 1} (${taskId})`,
            description: `Original EvoLink generated ${link.kind}. View or download; result links expire after ${RESULT_LINK_HOURS} hours. Inline preview depends on the client.`,
            ...(media ? { mimeType: media.mimeType } : {}),
        };
    });
}
/** A ready-to-send reply avoids triggering a client's remote-image fallback by default.
 * Angle brackets keep parentheses in signed URLs inside the link destination.
 * Resource URIs remain untouched; encode only characters unsafe in a Markdown destination.
 */
export function resultDeliveryMarkdown(taskId, links) {
    return [
        `EvoLink task ${taskId} completed.`,
        ...links.map((link, index) => {
            const destination = link.url.replace(/[\u0000-\u0020<>\\]/g, char => encodeURIComponent(char));
            return `[View/download original ${link.kind} ${index + 1}](<${destination}>)`;
        }),
        `Result links expire after ${RESULT_LINK_HOURS} hours; save them promptly.`,
    ].join('\n\n');
}
/** One task as text lines and the same facts as structured content. */
export function describeTask(task) {
    const status = task.status ?? 'pending';
    const links = resultLinks(task);
    const lines = [
        `Task ${task.id}: ${status}${status === 'completed' || status === 'failed' ? '' : ` (${task.progress ?? 0}%)`}`,
        `Model: ${task.model}`,
    ];
    const structured = {
        task_id: task.id,
        status,
        progress: task.progress ?? 0,
        model: task.model,
        type: task.type,
    };
    const outputs = taskOutputs(task);
    if (outputs.length) {
        structured.outputs = outputs;
        lines.push(`Public output metadata: ${JSON.stringify(outputs)}`);
    }
    if (links.length > 0) {
        lines.push(`Results (download links expire after ${RESULT_LINK_HOURS} hours; save them now):`);
        for (const link of links)
            lines.push(`- ${link.kind}: ${link.url}`);
        structured.results = links;
        structured.links_expire_after_hours = RESULT_LINK_HOURS;
    }
    const used = task.usage?.credits_used ?? task.usage?.cost?.credits;
    if (status === 'completed' && typeof used === 'number') {
        lines.push(`Charged: ${money(used)}`);
        structured.charged_credits = used;
        structured.charged_usd = task.usage?.cost?.usd ?? usdOf(used);
    }
    const reserved = task.usage?.credits_reserved;
    if (status !== 'completed' && status !== 'failed' && typeof reserved === 'number' && reserved > 0) {
        lines.push(`Reserved: ${money(reserved)} (the final charge is settled when the task finishes)`);
        structured.reserved_credits = reserved;
        structured.reserved_usd = usdOf(reserved);
    }
    if (typeof task.duration === 'number' && task.duration > 0 && TERMINAL_STATUSES.has(status)) {
        lines.push(`Took: ${task.duration} s`);
        structured.took_seconds = task.duration;
    }
    if (status === 'failed' || status === 'cancelled') {
        const code = task.error?.code ?? (status === 'cancelled' ? 'request_cancelled' : 'unknown_error');
        const info = getTaskErrorInfo(code);
        const suggestion = task.error?.suggestion ? `${info.suggestion} ${task.error.suggestion}` : info.suggestion;
        lines.push(`Error: ${code}${task.error?.message ? ` — ${task.error.message}` : ''}`);
        lines.push('Charge: failed tasks are refunded.');
        lines.push(`Next step: ${info.retryable ? 'You can retry with a new generate call.' : 'Change the input before retrying.'} ${suggestion}`);
        structured.error = { code, message: task.error?.message, retryable: info.retryable, suggestion };
        structured.refunded = true;
    }
    else if (status === 'completed') {
        if (links.length > 0) {
            const delivery = resultDeliveryMarkdown(task.id, links);
            structured.delivery_markdown = delivery;
            lines.push(`Suggested reply (plain links; no automatic inline previews):\n${delivery}`);
        }
        lines.push(links.length > 0
            ? `Next step: ${RESULT_DELIVERY_INSTRUCTIONS}`
            : 'Next step: the task completed but returned no result links. Tell the user; use get_task or list_tasks to recover them. Do not generate again automatically.');
    }
    else {
        const eta = task.task_info?.estimated_time;
        if (eta) {
            lines.push(`Estimated time left: ~${eta} s`);
            structured.estimated_seconds = eta;
        }
        lines.push(`Next step: call get_task with task_id "${task.id}" again (it can wait up to 45 s). Do not call generate again to check progress: that starts and charges a new task.`);
    }
    if (task.request_id) {
        lines.push(`Request ID: ${task.request_id}`);
        structured.request_id = task.request_id;
    }
    return { lines, structured, resources: resultResources(task.id, links) };
}
let pollIntervalOverrideMs;
/** Tests only: shorten the pause between task reads. */
export function setPollIntervalForTests(ms) {
    pollIntervalOverrideMs = ms;
}
/** Pause between task reads: each read of an unfinished task makes the gateway ask the provider. */
export function pollIntervalMs(type) {
    if (pollIntervalOverrideMs !== undefined)
        return pollIntervalOverrideMs;
    if (type?.includes('video'))
        return 8_000;
    if (type?.includes('audio') || type?.includes('music'))
        return 6_000;
    return 3_000;
}
/** Reads a task until it finishes or the deadline passes, pacing reads by task type. */
export async function waitForTask(config, taskId, options) {
    let task = options.initial ?? await queryTask(config, taskId, options.tool);
    while (!TERMINAL_STATUSES.has(task.status) && !options.signal?.aborted) {
        const interval = pollIntervalMs(task.type);
        if (Date.now() + interval > options.deadline)
            break;
        await options.onPoll?.(task);
        await sleep(interval, options.signal);
        if (options.signal?.aborted)
            break;
        task = await queryTask(config, taskId, options.tool);
    }
    return task;
}
