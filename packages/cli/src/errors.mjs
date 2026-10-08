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

export function safeMessage(message) {
  return String(message)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-|evup_)[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 2000);
}

export function errorView(error) {
  if (!(error instanceof CliError)) {
    return { code: 'request_failed', message: 'The operation failed. Retry free queries; use the saved quote to recover a submission.' };
  }
  return { code: error.code, message: safeMessage(error.message), ...(error.details ? { details: safeDetails(error.details) } : {}) };
}

function safeDetails(value) {
  if (typeof value === 'string') return safeMessage(value);
  if (Array.isArray(value)) return value.map(safeDetails);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !key.startsWith('_') && !/^(access_token|refresh_token|client_secret|code_verifier|authorization|upload_url)$/i.test(key))
    .map(([key, nested]) => [key, safeDetails(nested)]));
  return value;
}
