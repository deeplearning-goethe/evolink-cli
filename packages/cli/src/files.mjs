import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resultFetch, USER_AGENT, loopback } from './network.mjs';
import { CliError, requireThat } from './errors.mjs';

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

export async function upload(file, { mcp, state, server, signal, upload_path, fetchFn = fetch }) {
  const full = path.resolve(file);
  const stat = await fs.stat(full);
  requireThat(stat.isFile() && stat.size > 0 && stat.size <= 95 * 1024 * 1024, 'invalid_file', 'Uploads must be regular files between 1 byte and 95 MB.');
  const type = MIME[path.extname(full).toLowerCase()];
  requireThat(type, 'unsupported_file', 'This file format is not supported. Use JPEG, PNG, GIF, WebP, supported audio, MP4, MOV or WebM.');
  const prepared = await mcp.call('prepare_upload', { file_name: path.basename(full), ...(upload_path ? { upload_path } : {}) });
  requireThat(stat.size <= prepared.max_bytes, 'file_too_large', 'This file exceeds the upload limit.');
  const destination = new URL(prepared.upload_url);
  requireThat(destination.origin === server.origin && destination.pathname === `/uploads/${prepared.upload_id}` && !destination.username && !destination.password,
    'invalid_upload_url', 'The one-time upload address is outside the configured MCP service.');
  requireThat(destination.protocol === 'https:' || loopback(destination), 'invalid_upload_url', 'The upload URL must use HTTPS.');
  // Persist only the ID; one-time URLs and upload tokens never enter local state.
  await state.write('uploads', prepared.upload_id, { upload_id: prepared.upload_id, server: server.href, file_name: path.basename(full), size_bytes: stat.size });
  const body = createReadStream(full);
  let failure;
  try {
    const response = await fetchFn(destination, { method: 'PUT', redirect: 'error', headers: { 'Content-Type': type, 'Content-Length': String(stat.size), 'User-Agent': USER_AGENT },
      body, duplex: 'half', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(900_000)]) : AbortSignal.timeout(900_000) });
    if (!response.ok) failure = `The upload returned HTTP ${response.status}.`;
    await response.body?.cancel();
  } catch { failure = 'The upload connection was interrupted.'; }
  finally { body.destroy(); }
  try {
    const result = await mcp.call('get_upload', { upload_id: prepared.upload_id });
    if (result.state === 'done') return result;
    throw new CliError('upload_pending', failure || 'The upload is still being processed.', { upload_id: prepared.upload_id, state: result.state });
  } catch (e) {
    throw new CliError(e.code || 'upload_unknown', e.message || failure, { upload_id: prepared.upload_id, next_step: `evolink uploads get ${prepared.upload_id}` });
  }
}

export async function download(taskId, output, { mcp, server, index = 1, signal, maxBytes = 1024 ** 3, fetchFn }) {
  const task = await mcp.call('get_task', { task_id: taskId, wait_seconds: 0 });
  requireThat(task.status === 'completed', 'task_not_ready', 'Wait for the task to complete before downloading.');
  const result = task.results?.[index - 1];
  requireThat(Number.isInteger(index) && index > 0 && result?.url, 'result_not_found', 'The requested result index does not exist.');
  const target = path.resolve(output);
  const temp = `${target}.${randomUUID()}.part`;
  let bytes = 0;
  const digest = createHash('sha256');
  const guard = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxBytes) { callback(new CliError('download_too_large', 'The download exceeded the size limit.')); return; }
    digest.update(chunk); callback(null, chunk);
  } });
  const timeoutSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000);
  try {
    try { await fs.access(target); throw new CliError('file_exists', 'The output file already exists. Choose another path.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const response = await resultFetch(result.url, { testOrigin: loopback(server) ? server.origin : undefined, signal: timeoutSignal, fetchFn });
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel();
      throw new CliError('download_too_large', 'The result exceeds the download size limit.');
    }
    requireThat(response.body, 'download_failed', 'The file service returned an empty response.');
    await pipeline(Readable.fromWeb(response.body), guard, createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal: timeoutSignal });
    requireThat(bytes > 0, 'download_failed', 'The file service returned an empty file.');
    await fs.link(temp, target);
    return { task_id: taskId, result_index: index, path: target, size_bytes: bytes, sha256: digest.digest('hex'), kind: result.kind };
  } finally { await fs.unlink(temp).catch(() => {}); }
}
