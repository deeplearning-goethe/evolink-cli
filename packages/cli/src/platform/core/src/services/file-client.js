// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { currentRequestCredentials } from '../request-context.js';
import { getApiKey } from '../config.js';
import { ApiHttpError } from './api-client.js';
import { classifyGatewayError, formatGatewayError } from './error-handler.js';
import { DEFAULT_WRITE_TIMEOUT_MS, evoHeaders, fetchWithTimeout, newRunId, parseRetryAfter, readJsonBody, responseRequestId, timeoutFromEnv, } from './http-policy.js';
const DEFAULT_FILES_API_BASE_URL = 'https://files-api.evolink.ai';
/**
 * EVOLINK_FILES_BASE_URL points uploads at a staging files-api. HTTPS is
 * required except for loopback development hosts.
 */
export function filesApiBaseUrl() {
    const override = (currentRequestCredentials()?.http?.filesBaseUrl ?? process.env.EVOLINK_FILES_BASE_URL ?? '').trim().replace(/\/+$/, '');
    if (!override)
        return DEFAULT_FILES_API_BASE_URL;
    let parsed;
    try {
        parsed = new URL(override);
    }
    catch {
        throw new Error(`EVOLINK_FILES_BASE_URL is not a valid URL: ${override}`);
    }
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
        throw new Error('EVOLINK_FILES_BASE_URL must use HTTPS (or HTTP on localhost).');
    }
    return override;
}
function requestHeaders(tool, auth) {
    const runId = newRunId();
    return {
        'Authorization': `Bearer ${auth?.bearer ?? getApiKey()}`,
        ...evoHeaders(tool),
        'Idempotency-Key': runId,
        'X-Evo-Run-Id': runId,
    };
}
function apiError(status, data, headers) {
    const retryAfterMs = parseRetryAfter(headers.get('retry-after'));
    const info = classifyGatewayError(status, data, retryAfterMs, responseRequestId(headers));
    return new ApiHttpError(status, formatGatewayError(info), retryAfterMs, info.request_id, info);
}
async function parseResponse(response) {
    const data = await readJsonBody(response);
    if (!response.ok)
        throw apiError(response.status, data, response.headers);
    const body = data;
    if (body.success === false) {
        const status = typeof body.code === 'number' && body.code >= 400 && body.code < 600 ? body.code : 400;
        throw apiError(status, data, response.headers);
    }
    const requestId = responseRequestId(response.headers);
    if (!body.request_id && requestId)
        body.request_id = requestId;
    return body;
}
async function jsonUpload(path, body, auth) {
    const response = await fetchWithTimeout(`${filesApiBaseUrl()}${path}`, {
        method: 'POST',
        headers: { ...requestHeaders('upload_file', auth), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, timeoutFromEnv('EVOLINK_MCP_WRITE_TIMEOUT_MS', DEFAULT_WRITE_TIMEOUT_MS));
    return parseResponse(response);
}
export async function fileBase64Upload(base64Data, uploadPath, fileName, auth) {
    const body = { base64_data: base64Data };
    if (uploadPath)
        body.upload_path = uploadPath;
    if (fileName)
        body.file_name = fileName;
    return jsonUpload('/api/v1/files/upload/base64', body, auth);
}
function multipartField(name, value) {
    return Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
}
function safeDispositionValue(value) {
    return value.replaceAll(/["\r\n]/g, '_');
}
/**
 * Streams a file to files-api as multipart/form-data without holding it in
 * memory. With a known size the request carries Content-Length; otherwise it
 * is sent chunked.
 */
export async function fileStreamUploadFrom(source, size, mime, originalName, options = {}) {
    const boundary = `----evolink-${randomUUID()}`;
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeDispositionValue(originalName)}"\r\nContent-Type: ${mime}\r\n\r\n`);
    const fields = [];
    if (options.uploadPath)
        fields.push(multipartField('uploadPath', options.uploadPath));
    if (options.fileName)
        fields.push(multipartField('fileName', options.fileName));
    const tailParts = [Buffer.from('\r\n')];
    for (const field of fields) {
        tailParts.push(Buffer.from(`--${boundary}\r\n`), field);
    }
    tailParts.push(Buffer.from(`--${boundary}--\r\n`));
    const suffix = Buffer.concat(tailParts);
    async function* multipartBody() {
        yield prefix;
        for await (const chunk of source) {
            yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        }
        yield suffix;
    }
    const headers = requestHeaders(options.tool ?? 'upload_file', options.auth);
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    if (size !== undefined)
        headers['Content-Length'] = String(prefix.length + size + suffix.length);
    const init = {
        method: 'POST',
        headers,
        body: Readable.from(multipartBody()),
        duplex: 'half',
        signal: options.signal,
    };
    const response = await fetchWithTimeout(`${filesApiBaseUrl()}/api/v1/files/upload/stream`, init, options.timeoutMs ?? timeoutFromEnv('EVOLINK_MCP_WRITE_TIMEOUT_MS', DEFAULT_WRITE_TIMEOUT_MS));
    return parseResponse(response);
}
export async function fileStreamUpload(filePath, fileSize, mime, originalName, uploadPath, fileName, auth) {
    return fileStreamUploadFrom(createReadStream(filePath), fileSize, mime, originalName, { uploadPath, fileName, auth });
}
export async function fileUrlUpload(fileUrl, uploadPath, fileName, auth) {
    const body = { file_url: fileUrl };
    if (uploadPath)
        body.upload_path = uploadPath;
    if (fileName)
        body.file_name = fileName;
    return jsonUpload('/api/v1/files/upload/url', body, auth);
}
