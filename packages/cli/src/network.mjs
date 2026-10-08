import net from 'node:net';
import dns from 'node:dns/promises';
import { CliError, requireThat } from './errors.mjs';

export const SERVER = 'https://mcp.evolink.ai/mcp';
export const ISSUER = 'https://passport.evolink.ai';
export const USER_AGENT = 'EvoLinkCLI/0.5.0';
export const loopback = url => url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);

export function serverURL(value = SERVER) {
  let url;
  try { url = new URL(value); } catch { throw new CliError('invalid_server', 'Invalid MCP server URL.'); }
  requireThat(!url.username && !url.password && !url.search && !url.hash && (url.href === SERVER || loopback(url)),
    'invalid_server', 'Use the EvoLink production MCP URL or a loopback test server.');
  return url;
}

export function authFetch(server, fetchFn = fetch) {
  const origins = new Set([server.origin, server.href === SERVER ? ISSUER : server.origin]);
  return async (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requireThat(origins.has(url.origin) && !url.username && !url.password, 'untrusted_auth_server', 'The login endpoint is outside the configured EvoLink service.');
    const headers = new Headers(options.headers);
    headers.set('User-Agent', USER_AGENT);
    return fetchFn(input, { ...options, headers, redirect: 'error', signal: options.signal || AbortSignal.timeout(30_000) });
  };
}

function privateIP(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224 || a === 100 && b >= 64 && b <= 127;
  }
  const ip = address.toLowerCase();
  if (ip.startsWith('::ffff:')) return privateIP(ip.slice(7));
  return ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip);
}

export async function publicURL(value, testOrigin) {
  let url;
  try { url = new URL(value); } catch { throw new CliError('invalid_result_url', 'The result URL is invalid.'); }
  requireThat(!url.username && !url.password && !url.hash, 'invalid_result_url', 'The result URL contains unsupported credentials or a fragment.');
  if (testOrigin && url.origin === testOrigin && loopback(url)) return url;
  requireThat(url.protocol === 'https:', 'invalid_result_url', 'Result downloads require a public HTTPS URL.');
  const addresses = await dns.lookup(url.hostname, { all: true });
  requireThat(addresses.length > 0 && addresses.every(a => !privateIP(a.address)), 'invalid_result_url', 'The result URL points to a private network.');
  return url;
}

export async function resultFetch(value, { testOrigin, signal, fetchFn = fetch } = {}) {
  let url = await publicURL(value, testOrigin);
  for (let count = 0; count < 6; count++) {
    const response = await fetchFn(url, { redirect: 'manual', headers: { 'User-Agent': USER_AGENT }, signal: signal || AbortSignal.timeout(600_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      requireThat(location, 'download_failed', 'The download redirect has no destination.');
      url = await publicURL(new URL(location, url).href, testOrigin);
      continue;
    }
    requireThat(response.ok, 'download_failed', `The file service returned HTTP ${response.status}. Check the task again for a current result link.`);
    return response;
  }
  throw new CliError('download_failed', 'The file service returned too many redirects.');
}
