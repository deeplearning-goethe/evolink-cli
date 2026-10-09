import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resultFetch, USER_AGENT, loopback } from './network.mjs';
import { CliError, requireThat, localFile, fileError, errorView } from './errors.mjs';
import { hash } from './state.mjs';
import { checkContentType, checkMediaPrefix } from './media-content.mjs';

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

export async function upload(file, { client, mcp = client, state, server, signal, upload_path, fetchFn = fetch }) {
  client = mcp;
  const full = path.resolve(file);
  const stat = await localFile(() => fs.stat(full), { file: full });
  requireThat(stat.isFile() && stat.size > 0 && stat.size <= 95 * 1024 * 1024, 'invalid_file', 'Uploads must be regular files between 1 byte and 95 MB.');
  const type = MIME[path.extname(full).toLowerCase()];
  requireThat(type, 'unsupported_file', 'This file format is not supported. Use JPEG, PNG, GIF, WebP, supported audio, MP4, MOV or WebM.');
  await localFile(() => fs.access(full, constants.R_OK), { file: full });
  if (client.uploadFile) return directUpload(full, stat.size, type, { client, state, server, upload_path });
  const prepared = await client.call('prepare_upload', { file_name: path.basename(full), ...(upload_path ? { upload_path } : {}) });
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
    const result = await client.call('get_upload', { upload_id: prepared.upload_id });
    if (result.state === 'done') return result;
    throw new CliError('upload_pending', failure || 'The upload is still being processed.', { upload_id: prepared.upload_id, state: result.state });
  } catch (e) {
    throw new CliError(e.code || 'upload_unknown', e.message || failure, { upload_id: prepared.upload_id, next_step: `evolink uploads get ${prepared.upload_id}` });
  }
}

async function directUpload(file, size, mime, { client, state, server, upload_path }) {
  const access = await client.credentials.access();
  const upload_id = `cli-up-${randomUUID()}`;
  const journal = { upload_id, backend: 'platform', server: server.href, api_origin: client.apiUrl.origin, binding: access.binding,
    file_name: path.basename(file), size_bytes: size, state: 'uploading' };
  await state.write('uploads', upload_id, journal);
  const source = createReadStream(file);
  try {
    const result = await client.uploadFile(source, size, mime, path.basename(file), upload_path, upload_id);
    const data = result?.data;
    requireThat(result?.success === true && typeof data?.file_id === 'string' && typeof data?.file_url === 'string',
      'upload_unknown', 'The file service returned no verified upload result.');
    const url = new URL(data.file_url);
    requireThat(!url.username && !url.password && !url.hash && (url.protocol === 'https:' || loopback(server) && url.origin === server.origin),
      'invalid_upload_result', 'The file service returned an invalid public reference URL.');
    journal.state = 'done';
    // Store an allowlisted receipt, never a token or a signed upload address.
    journal.result = { ok: true, upload_id, state: 'done', file_id: data.file_id, file_url: data.file_url,
      file_name: data.file_name, size_bytes: data.file_size, mime_type: data.mime_type, expires_at: data.expires_at };
    await state.write('uploads', upload_id, journal);
    return journal.result;
  } catch (error) {
    journal.state = 'outcome_unknown';
    await state.write('uploads', upload_id, journal);
    throw new CliError(error.code || 'upload_unknown', error.message || 'The upload outcome is unknown.', {
      upload_id, state: journal.state, next_step: `evolink uploads get ${upload_id}` }, error.exitCode);
  } finally { source.destroy(); }
}

export async function getUpload(id, { client, state, server }) {
  const journal = await state.read('uploads', id);
  requireThat(journal?.server === server.href, 'upload_not_found', 'No upload receipt exists for this login resource.');
  requireThat(journal.backend === 'platform', 'legacy_upload', 'This upload used an older MCP-based CLI and its upload proxy. Recover it with the original CLI version; the direct API client cannot query an old proxy slot.', { upload_id: id });
  requireThat(journal.api_origin === client.apiUrl.origin && journal.binding === (await client.credentials.access()).binding,
    'upload_session_changed', 'This receipt belongs to a different platform or login.');
  if (journal.state === 'done') return journal.result;
  let receipt;
  try { receipt = await client.uploadReceipt?.(id); }
  catch { throw new CliError('upload_unknown', 'The original upload receipt is unavailable. Keep this upload_id and retry this read later; no bytes were resent.',
    { upload_id: id, state: 'outcome_unknown', next_step: `evolink uploads get ${id}` }); }
  if (receipt?.state === 'done' && receipt.result_verified === true) {
    const data = receipt.file;
    journal.state = 'done';
    journal.result = { ok: true, upload_id: id, state: 'done', file_id: data.file_id, file_url: data.file_url,
      file_name: data.original_name ?? data.file_name, size_bytes: data.file_size, mime_type: data.mime_type, expires_at: data.expires_at };
    await state.write('uploads', id, journal);
    return journal.result;
  }
  return { ok: true, upload_id: id, state: 'outcome_unknown', result_verified: false,
    text: 'No verified completed receipt is available. The upload may still have arrived. Check your files before starting another upload; this command only reads the original receipt and never resends bytes.' };
}

export async function download(taskId, output, { client, mcp = client, server, index = 1, signal, maxBytes = 1024 ** 3, fetchFn, task: suppliedTask, beforeCommit }) {
  client = mcp;
  const target = path.resolve(output);
  const parent = await localFile(() => fs.stat(path.dirname(target)), { file: target, missing: 'output_directory_missing' });
  requireThat(parent.isDirectory(), 'path_not_directory', 'The output parent is not a directory. Choose a valid file path.');
  await localFile(() => fs.access(path.dirname(target), constants.W_OK), { file: target });
  try { await fs.lstat(target); throw new CliError('file_exists', 'The output file already exists. Choose another path.'); }
  catch (e) { if (e.code !== 'ENOENT') throw fileError(e, { file: target }); }
  const task = suppliedTask ?? await client.call('get_task', { task_id: taskId, wait_seconds: 0 });
  requireThat(task.status === 'completed', 'task_not_ready', 'Wait for the task to complete before downloading.');
  const result = task.results?.[index - 1];
  requireThat(Number.isInteger(index) && index > 0 && result?.url, 'result_not_found', 'The requested result index does not exist.');
  const temp = `${target}.${randomUUID()}.part`;
  let bytes = 0;
  let prefix = Buffer.alloc(0), inspected = false, contentType;
  const digest = createHash('sha256');
  const guard = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxBytes) { callback(new CliError('download_too_large', 'The download exceeded the size limit.')); return; }
    if (!inspected) {
      prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
      if (prefix.length === 512) {
        try { checkMediaPrefix(prefix, result.kind, contentType); inspected = true; }
        catch (error) { callback(error); return; }
      }
    }
    digest.update(chunk); callback(null, chunk);
  }, flush(callback) {
    try { if (!inspected && bytes > 0) checkMediaPrefix(prefix, result.kind, contentType); callback(); }
    catch (error) { callback(error); }
  } });
  const timeoutSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000);
  try {
    const response = await resultFetch(result.url, { testOrigin: loopback(server) ? server.origin : undefined, signal: timeoutSignal, fetchFn });
    try { contentType = checkContentType(response.headers.get('content-type'), result.kind); }
    catch (error) { await response.body?.cancel(); throw error; }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel();
      throw new CliError('download_too_large', 'The result exceeds the download size limit.');
    }
    requireThat(response.body, 'download_failed', 'The file service returned an empty response.');
    await pipeline(Readable.fromWeb(response.body), guard, createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal: timeoutSignal });
    requireThat(bytes > 0, 'download_failed', 'The file service returned an empty file.');
    const receipt = { task_id: taskId, result_index: index, path: target, size_bytes: bytes, sha256: digest.digest('hex'), kind: result.kind };
    await beforeCommit?.(receipt);
    await fs.link(temp, target);
    return receipt;
  } catch (error) { throw fileError(error, { file: target, missing: 'output_directory_missing' }); }
  finally { await fs.unlink(temp).catch(() => {}); }
}

export function downloadNames(taskId, results, template = '{task_id}-{index}.{ext}') {
  requireThat(typeof template === 'string' && template.length > 0 && template.length <= 200 && !/[\\/\x00-\x1f]/.test(template),
    'invalid_template', 'Use a filename template, without directory separators. Placeholders: {task_id}, {index}, {kind}, {ext}.');
  const names = results.map((result, index) => {
    let extension;
    try { extension = path.extname(new URL(result.url).pathname).toLowerCase(); } catch {}
    const ext = MIME[extension] ? extension.slice(1) : 'bin';
    const values = { task_id: String(taskId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128), index: String(index + 1), kind: result.kind, ext };
    const name = template.replace(/\{(task_id|index|kind|ext)\}/g, (_, key) => values[key]);
    requireThat(name.length <= 240 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..')
      && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name),
    'invalid_template', 'The template must produce portable filenames with letters, digits, dots, underscores or hyphens.');
    return name;
  });
  requireThat(new Set(names.map(name => name.toLowerCase())).size === names.length, 'duplicate_output_path', 'The template must produce a different filename for every result; include {index}.');
  return names;
}

/** Recovery checks saved file digests; it never treats an unrelated existing file as a delivered result. */
export async function downloadAll(taskId, directory, { client, mcp = client, server, state, signal, template, resume = false, fetchFn }) {
  const target = path.resolve(directory);
  const receiptId = hash({ taskId, server: server.href, target });
  return state.lock(`delivery-${receiptId}`, async () => {
    const task = await mcp.call('get_task', { task_id: taskId, wait_seconds: 0 });
    requireThat(task.status === 'completed', 'task_not_ready', 'Wait for the task to complete before downloading.');
    requireThat(Array.isArray(task.results) && task.results.length > 0 && task.results.length <= 50,
      'invalid_result_count', 'Download all requires between 1 and 50 result links. Use individual downloads for larger tasks.');
    const names = downloadNames(taskId, task.results, template);
    const sources = task.results.map(result => {
      const url = new URL(result.url);
      return hash({ kind: result.kind, origin: url.origin, path: url.pathname });
    });
    let receipt = await state.read('deliveries', receiptId);
    if (resume) {
      requireThat(receipt && receipt.task_id === taskId && receipt.directory === target && receipt.server === server.href
        && Array.isArray(receipt.files) && hash(receipt.names) === hash(names) && hash(receipt.sources) === hash(sources),
      'delivery_receipt_mismatch', 'No matching delivery receipt exists, or the task outputs/template changed. Keep the task ID; choose a new directory for a fresh download.');
    } else {
      requireThat(!receipt, 'delivery_exists', 'This task already has a delivery receipt for this directory. Use --resume to verify saved files and download the remainder.');
      receipt = { task_id: taskId, directory: target, server: server.href, names, sources, files: [] };
    }
    await localFile(() => fs.mkdir(target, { recursive: true, mode: 0o700 }), { file: target });
    requireThat((await fs.stat(target)).isDirectory(), 'path_not_directory', 'Choose an output directory.');
    await state.write('deliveries', receiptId, receipt);
    const failures = [], downloaded = [];
    for (let index = 1; index <= names.length; index++) {
      const file = path.join(target, names[index - 1]);
      try {
        requireThat(!signal?.aborted, 'interrupted', 'Stopped downloading locally. The completed EvoLink task is unchanged.');
        let saved = receipt.files.find(item => item.result_index === index);
        if (saved?.pending_commit) {
          try { await fs.lstat(file); }
          catch (error) {
            if (error.code !== 'ENOENT') throw error;
            receipt.files = receipt.files.filter(item => item.result_index !== index);
            await state.write('deliveries', receiptId, receipt);
            saved = undefined;
          }
        }
        if (saved) {
          const stat = await localFile(() => fs.lstat(file), { file });
          requireThat(saved.path === file && /^[a-f0-9]{64}$/.test(saved.sha256) && stat.isFile() && stat.size === saved.size_bytes,
            'saved_file_changed', 'A previously downloaded file changed. It will not be overwritten. Choose a new output directory.');
          const digest = createHash('sha256');
          for await (const bytes of createReadStream(file, { signal })) digest.update(bytes);
          requireThat(digest.digest('hex') === saved.sha256, 'saved_file_changed', 'A previously downloaded file changed. It will not be overwritten. Choose a new output directory.');
          if (saved.pending_commit) { saved.pending_commit = false; await state.write('deliveries', receiptId, receipt); }
          downloaded.push({ ...saved, verified_existing: true });
        } else {
          const result = await download(taskId, file, { mcp, server, index, signal, fetchFn, task, beforeCommit: async pending => {
            receipt.files.push({ ...pending, pending_commit: true });
            await state.write('deliveries', receiptId, receipt);
          } });
          Object.assign(receipt.files.find(item => item.result_index === index), result, { pending_commit: false });
          await state.write('deliveries', receiptId, receipt);
          downloaded.push(result);
        }
      } catch (error) {
        failures.push({ result_index: index, path: file, error: errorView(error) });
        if (signal?.aborted) break;
      }
    }
    const complete = downloaded.length === names.length && failures.length === 0;
    return { ok: complete, task_id: taskId, generation_status: 'completed', delivery_status: complete ? 'completed' : 'partial',
      files: downloaded, failures, result_count: names.length, receipt_id: receiptId,
      ...(signal?.aborted ? { error: { code: 'interrupted' } } : {}),
      text: `${downloaded.length}/${names.length} original files verified or downloaded.${complete ? '' : ' Delivery is incomplete. Keep this task ID; retry download --all with the same directory/template and --resume. Do not generate again.'}` };
  });
}
