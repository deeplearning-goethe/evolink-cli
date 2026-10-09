// Legacy transport fixture for CLI 0.6.0 state compatibility tests only.
import { CLI_VERSION } from '../src/version.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CliError, requireThat, safeMessage } from '../src/errors.mjs';

export class Mcp {
  constructor(credentials, { signal } = {}) { this.credentials = credentials; this.signal = signal; }
  async call(name, args = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await this.credentials.access(attempt > 0);
      const client = new Client({ name: 'EvoLink CLI', version: CLI_VERSION });
      const headers = { Authorization: `Bearer ${access.access_token}` };
      const transport = new StreamableHTTPClientTransport(this.credentials.server, { requestInit: { headers }, fetch: this.credentials.fetchFn });
      // The hosted service is stateless and does not expose an SSE GET stream.
      transport.onerror = () => {};
      try {
        await client.connect(transport, { signal: this.signal, timeout: 30_000 });
        const result = await client.callTool({ name, arguments: args }, undefined, { signal: this.signal, timeout: 75_000 });
        const data = result.structuredContent;
        const text = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        if (result.isError || data?.ok === false) {
          throw new CliError(data?.error?.category || 'tool_failed', safeMessage(data?.error?.message || text || 'The EvoLink tool refused this request.'),
            { ...data, text: safeMessage(text) });
        }
        requireThat(data?.ok === true, 'unsupported_response', 'EvoLink returned no structured result. Update the CLI or reconnect.');
        return { ...data, text, _binding: access.binding };
      } catch (e) {
        if (attempt === 0 && (e.code === 401 || e.constructor.name === 'UnauthorizedError')) continue;
        if (this.signal?.aborted) throw new CliError('interrupted', 'Stopped waiting locally. Submitted tasks continue on EvoLink.', undefined, 130);
        if (e instanceof CliError) throw e;
        throw new CliError('connection_failed', 'Could not complete the EvoLink request. For a submitted task, recover using the saved quote and request ID.');
      } finally { await client.close().catch(() => {}); }
    }
    throw new CliError('login_required', 'The login expired. Run auth login.');
  }
}
