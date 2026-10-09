import net from 'node:net';
import dns from 'node:dns/promises';
import https from 'node:https';
import { Readable } from 'node:stream';
import { CliError, requireThat } from './errors.mjs';
import { CLI_VERSION } from './version.mjs';

export const SERVER = 'https://mcp.evolink.ai/mcp';
export const ISSUER = 'https://passport.evolink.ai';
export const API = 'https://api.evolink.ai';
export const FILES = 'https://files-api.evolink.ai';
export const USER_AGENT = `EvoLinkCLI/${CLI_VERSION}`;
export const loopback = url => url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);

export function serverURL(value = SERVER) {
  let url;
  try { url = new URL(value); } catch { throw new CliError('invalid_server', 'Invalid MCP server URL.'); }
  requireThat(!url.username && !url.password && !url.search && !url.hash && (url.href === SERVER || loopback(url)),
    'invalid_server', 'Use the EvoLink production MCP URL or a loopback test server.');
  return url;
}

export function authFetch(server, fetchFn = fetch) {
  const origins = new Set([server.href === SERVER ? ISSUER : server.origin]);
  return async (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requireThat(origins.has(url.origin) && !url.username && !url.password, 'untrusted_auth_server', 'The login endpoint is outside the configured EvoLink service.');
    const headers = new Headers(options.headers);
    headers.set('User-Agent', USER_AGENT);
    return fetchFn(input, { ...options, headers, redirect: 'error', signal: options.signal || AbortSignal.timeout(30_000) });
  };
}

export function serviceURL(value, production, resource) {
  let url;
  try { url = new URL(value); } catch { throw new CliError('invalid_api_url', 'Invalid platform service URL.'); }
  requireThat(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
    && (url.origin === production || loopback(resource) && loopback(url)),
    'invalid_api_url', 'Use the EvoLink production service, or an explicit loopback service with a loopback test resource.');
  return url;
}

const blocked = new net.BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3], ['100.64.0.0', 10]]) blocked.addSubnet(network, prefix, 'ipv4');
for (const address of ['::', '::1']) blocked.addAddress(address, 'ipv6');
for (const [network, prefix] of [['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(network, prefix, 'ipv6');

function privateIP(address) {
  const family = net.isIP(address);
  return !family || blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

async function resolveResult(value, testOrigin) {
  let url;
  try { url = new URL(value); } catch { throw new CliError('invalid_result_url', 'The result URL is invalid.'); }
  requireThat(!url.username && !url.password && !url.hash, 'invalid_result_url', 'The result URL contains unsupported credentials or a fragment.');
  if (testOrigin && url.origin === testOrigin && loopback(url)) return { url, addresses: [] };
  requireThat(url.protocol === 'https:', 'invalid_result_url', 'Result downloads require a public HTTPS URL.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(host);
  const addresses = family ? [{ address: host, family }] : await dns.lookup(host, { all: true });
  requireThat(addresses.length > 0 && addresses.every(a => !privateIP(a.address)), 'invalid_result_url', 'The result URL points to a private network.');
  return { url, addresses };
}

export async function publicURL(value, testOrigin) {
  return (await resolveResult(value, testOrigin)).url;
}

function pinnedFetch(url, addresses, signal) {
  // Preserve the original hostname for TLS while using only a validated IP.
  const address = addresses.find(item => item.family === 4) || addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: 'GET', agent: false, signal,
      family: address.family, headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' },
      lookup: (_host, options, callback) => options?.all
        ? callback(null, [address]) : callback(null, address.address, address.family),
    }, incoming => {
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      const status = incoming.statusCode;
      const noBody = [204, 205, 304].includes(status);
      if (noBody) incoming.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(incoming), { status, headers }));
    });
    request.once('error', reject);
    request.end();
  });
}

export async function resultFetch(value, { testOrigin, signal, fetchFn } = {}) {
  let resolved = await resolveResult(value, testOrigin);
  signal ||= AbortSignal.timeout(600_000);
  for (let count = 0; count < 6; count++) {
    const { url, addresses } = resolved;
    const response = fetchFn || !addresses.length
      ? await (fetchFn || fetch)(url, { redirect: 'manual', headers: { 'User-Agent': USER_AGENT }, signal })
      : await pinnedFetch(url, addresses, signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      requireThat(location, 'download_failed', 'The download redirect has no destination.');
      resolved = await resolveResult(new URL(location, url).href, testOrigin);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CliError('download_failed', `The file service returned HTTP ${response.status}. Check the task again for a current result link.`);
    }
    return response;
  }
  throw new CliError('download_failed', 'The file service returned too many redirects.');
}
