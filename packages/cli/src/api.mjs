import { PlatformClient } from './platform/core/src/platform-client.js';
import { CliError, requireThat, safeMessage } from './errors.mjs';
import { API, FILES, USER_AGENT, loopback, serviceURL } from './network.mjs';
import { CLI_VERSION } from './version.mjs';

export class Api {
  constructor(credentials, { signal, apiUrl, filesUrl, fetchFn = fetch } = {}) {
    this.credentials = credentials; this.signal = signal;
    const local = loopback(credentials.server);
    this.apiUrl = serviceURL(apiUrl ?? (local ? credentials.server.origin : API), API, credentials.server);
    this.filesUrl = serviceURL(filesUrl ?? (local ? credentials.server.origin : FILES), FILES, credentials.server);
    this.platform = new PlatformClient({ channel: 'official', baseUrl: this.apiUrl.origin });
    const origins = new Set([this.apiUrl.origin, this.filesUrl.origin]);
    this.fetchFn = async (input, options = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requireThat(origins.has(url.origin) && !url.username && !url.password && !url.hash,
        'untrusted_api_server', 'The platform endpoint is outside the configured EvoLink services.');
      const authorization = new Headers(options.headers).get('authorization');
      if (url.origin === this.filesUrl.origin && url.pathname.startsWith('/api/v1/files/')) {
        requireThat(!authorization || authorization.startsWith('Bearer evup_'), 'invalid_upload_credential', 'File uploads require a short-lived upload token.');
      }
      return fetchFn(input, { ...options, redirect: 'error', credentials: 'omit' });
    };
  }
  context(access, name) {
    return { serviceChannel: { accessToken: access.access_token }, clientName: 'EvoLink CLI',
      http: { fetch: this.fetchFn, signal: this.signal, userAgent: USER_AGENT, client: 'cli', version: CLI_VERSION,
        controlBaseUrl: this.apiUrl.origin, filesBaseUrl: this.filesUrl.origin } };
  }
  async call(name, args = {}, { requireCapability = false, requiredInputs = [] } = {}) {
    if (requireCapability) requireThat(this.platform.supports(name, requiredInputs),
      'capability_unavailable', 'This CLI does not contain the requested platform capability. Update the CLI; no request was sent.',
      { tool: name, required_inputs: requiredInputs, request_sent: false });
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await this.credentials.access(attempt > 0);
      const result = await this.platform.call(name, args, this.context(access, name));
      const data = result.structuredContent;
      const text = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
      if (result.isError || data?.ok === false) {
        if (attempt === 0 && data?.error?.status === 401 && data?.charged !== 'unknown') continue;
        throw new CliError(this.signal?.aborted ? 'interrupted' : data?.error?.category || 'api_failed',
          safeMessage(data?.error?.message || text || 'The EvoLink request was refused.'), { ...data, text: safeMessage(text) }, this.signal?.aborted ? 130 : 1);
      }
      requireThat(data?.ok === true, 'unsupported_response', 'EvoLink returned no structured result. Update the CLI or reconnect.');
      return { ...data, text, _binding: access.binding };
    }
    throw new CliError('login_required', 'The login expired. Run auth login.');
  }
  async uploadFile(source, size, mime, name, uploadPath) {
    const access = await this.credentials.access();
    try { return await this.platform.upload(source, size, mime, name, this.context(access, 'upload_file'), uploadPath); }
    catch (error) { throw new CliError(this.signal?.aborted ? 'interrupted' : error.info?.category || 'upload_unknown',
      safeMessage(error.info?.message || 'The upload did not return a verified file result.'), undefined, this.signal?.aborted ? 130 : 1); }
  }
}
