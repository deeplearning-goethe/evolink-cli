import { randomBytes, createHash } from 'node:crypto';
import { CliError, requireThat } from './errors.mjs';
import { ISSUER, SERVER } from './network.mjs';

// Passport discovery is independent of MCP health and protected-resource metadata.
export async function metadata(server, fetchFn) {
  const issuer = server.href === SERVER ? ISSUER : server.origin;
  const response = await fetchFn(`${issuer}/.well-known/oauth-authorization-server`);
  requireThat(response.ok, 'login_unavailable', 'Passport login discovery is unavailable. Retry login.');
  const data = await response.json();
  requireThat(data.issuer === issuer && data.code_challenge_methods_supported?.includes('S256'),
    'invalid_auth_metadata', 'Passport did not provide the expected issuer and PKCE method.');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'revocation_endpoint', ...(data.registration_endpoint ? ['registration_endpoint'] : [])]) {
    let endpoint;
    try { endpoint = new URL(data[key]); } catch { throw new CliError('invalid_auth_metadata', 'Passport did not provide valid login endpoints.'); }
    requireThat(endpoint.origin === issuer && !endpoint.username && !endpoint.password && !endpoint.hash,
      'untrusted_auth_server', 'The login endpoint is outside Passport.');
  }
  return data;
}

async function client(provider, data, fetchFn, newLogin = false) {
  let value = await provider.clientInformation();
  if (value) requireThat(value.issuer === data.issuer && typeof value.client_id === 'string' && !value.client_secret,
    'invalid_client', 'The saved public OAuth client belongs to a different service.');
  // A rolled-back Passport may no longer support media grants for this public
  // identity. Only a new login can change clients; an existing refresh cannot.
  if (newLogin && value?.client_id === 'evolink-cli' && data.evolink_cli_mcp_supported !== true) value = undefined;
  if ((!value || newLogin) && data.evolink_cli_mcp_supported === true) {
    value = { client_id: 'evolink-cli', issuer: data.issuer, token_endpoint_auth_method: 'none' };
    await provider.saveClientInformation(value);
  }
  if (!value) {
    requireThat(data.registration_endpoint, 'registration_unavailable', 'Passport does not support CLI client registration. Update the login service or retry later.');
    const response = await fetchFn(data.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(provider.clientMetadata) });
    requireThat(response.ok, 'registration_failed', 'Passport could not register this CLI login.');
    value = await response.json();
    requireThat(typeof value.client_id === 'string' && value.client_id.length > 0, 'invalid_client', 'Passport returned no public client ID.');
    requireThat(!value.client_secret && value.token_endpoint_auth_method !== 'client_secret_basic', 'invalid_client', 'The CLI requires a public OAuth client.');
    value = { client_id: value.client_id, issuer: data.issuer, token_endpoint_auth_method: 'none',
      redirect_uris: value.redirect_uris ?? provider.clientMetadata.redirect_uris };
    await provider.saveClientInformation(value);
  }
  return value;
}

async function token(provider, data, clientInfo, parameters, fetchFn) {
  const response = await fetchFn(data.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientInfo.client_id, resource: provider.server.href, ...parameters }) });
  if (!response.ok) {
    let code;
    try { code = (await response.json()).error; } catch { /* Never echo credential-bearing response bodies. */ }
    throw new CliError(code === 'invalid_grant' ? 'login_expired' : code === 'invalid_client' ? 'invalid_client' : 'login_unavailable',
      code === 'invalid_grant' ? 'This login expired. Run evolink auth login.' : 'Passport could not complete this login. Retry auth login.');
  }
  const value = await response.json();
  requireThat(typeof value.access_token === 'string' && value.access_token.length > 0 && value.token_type?.toLowerCase() === 'bearer'
    && Number.isFinite(value.expires_in) && value.expires_in > 0 && (!value.issuer || value.issuer === data.issuer)
    && (!value.scope || value.scope.split(' ').includes('mcp')), 'invalid_token_response', 'Passport returned an invalid login response.');
  const prior = await provider.tokens();
  const oldRefresh = parameters.grant_type === 'refresh_token' ? prior?.refresh_token : undefined;
  requireThat(typeof value.refresh_token === 'string' && value.refresh_token.length > 0 || oldRefresh,
    'invalid_token_response', 'Passport returned no refresh credential.');
  await provider.saveTokens({ ...value, refresh_token: value.refresh_token || oldRefresh, issuer: data.issuer });
  return 'AUTHORIZED';
}

export async function refresh(provider, fetchFn) {
  const data = await metadata(provider.server, fetchFn);
  const info = await client(provider, data, fetchFn);
  const saved = await provider.tokens();
  requireThat(saved?.issuer === data.issuer && saved.refresh_token, 'login_required', 'Run evolink auth login.');
  return token(provider, data, info, { grant_type: 'refresh_token', refresh_token: saved.refresh_token }, fetchFn);
}

export async function authorize(provider, fetchFn, authorizationCode) {
  const data = await metadata(provider.server, fetchFn);
  const info = await client(provider, data, fetchFn, !authorizationCode);
  if (authorizationCode) return token(provider, data, info, { grant_type: 'authorization_code', code: authorizationCode,
    redirect_uri: String(provider.redirectUrl), code_verifier: await provider.codeVerifier() }, fetchFn);
  const verifier = randomBytes(32).toString('base64url');
  await provider.saveCodeVerifier(verifier);
  const url = new URL(data.authorization_endpoint);
  url.search = new URLSearchParams({ client_id: info.client_id, response_type: 'code', redirect_uri: String(provider.redirectUrl),
    scope: 'mcp offline_access', resource: provider.server.href, state: provider.state(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  await provider.redirectToAuthorization(url);
  return 'REDIRECT';
}
