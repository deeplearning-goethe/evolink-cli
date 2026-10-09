export class CliError extends Error {
  constructor(code, message, details, exitCode = 1) {
    super(message);
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export function requireThat(condition, code, message, details) {
  if (!condition) throw new CliError(code, message, details);
}

export function fileError(error, { file, missing = 'file_not_found' } = {}) {
  if (error instanceof CliError) return error;
  const messages = {
    ENOENT: [missing, missing === 'output_directory_missing' ? 'The output directory does not exist. Create it or choose an existing directory.' : 'The local file does not exist. Check the path.'],
    ENOTDIR: ['path_not_directory', 'A parent path is not a directory. Choose a valid file path.'],
    EACCES: ['file_permission_denied', 'Permission to access the local file or directory was denied. Choose a location you can read or write.'],
    EPERM: ['file_permission_denied', 'Permission to access the local file or directory was denied. Choose a location you can read or write.'],
    EROFS: ['filesystem_read_only', 'The filesystem is read-only. Choose a writable location.'],
    ENOSPC: ['disk_full', 'The filesystem has no free space. Free space or choose another disk, then retry.'],
    EDQUOT: ['disk_full', 'The filesystem quota is exhausted. Free space or choose another disk, then retry.'],
    EEXIST: ['file_exists', 'The output file already exists. Choose another path.'],
    EISDIR: ['invalid_file', 'The path is a directory. Choose a regular file.'],
  };
  const mapped = messages[error?.code];
  return mapped ? new CliError(...mapped, file ? { path: file } : undefined) : error;
}

export async function localFile(action, context) {
  try { return await action(); }
  catch (error) { throw fileError(error, context); }
}

export function safeMessage(message) {
  return String(message)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-|evup_)[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/([?&](?:token|access_token|refresh_token|api_key|key|client_secret|code|code_verifier)=)[^\s&#"'<>]+/gi, '$1[redacted]')
    .slice(0, 2000);
}

export function errorView(error) {
  error = fileError(error);
  if (!(error instanceof CliError)) {
    return { code: 'request_failed', message: 'The operation failed. Retry free queries; use the saved quote to recover a submission.' };
  }
  return { code: error.code, message: safeMessage(error.message), ...(error.details ? { details: safeDetails(error.details) } : {}) };
}

function safeDetails(value) {
  if (typeof value === 'string') return safeMessage(value);
  if (Array.isArray(value)) return value.map(safeDetails);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !key.startsWith('_') && !/^(access_token|refresh_token|client_secret|code_verifier|authorization|upload_url|api_key|apiKey|x-api-key|x-goog-api-key|token|secret|password)$/i.test(key))
    .map(([key, nested]) => [key, safeDetails(nested)]));
  return value;
}
