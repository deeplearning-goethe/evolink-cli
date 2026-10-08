import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { hash } from './state.mjs';
import { authFetch, ISSUER, SERVER } from './network.mjs';
import { CliError, requireThat } from './errors.mjs';

export class Vault {
  constructor(server, state) { this.account = hash({ server: server.href, home: state.home }); }
  async entry() {
    try {
      const { Entry } = await import('@napi-rs/keyring');
      return new Entry('EvoLink Media CLI', this.account, { linux: { store: 'secret-service' } });
    } catch { throw this.unavailable(); }
  }
  unavailable() { return new CliError('credential_store_unavailable', 'Secure credential storage is unavailable. On Linux, start a Secret Service keyring. For one command, an OAuth access token can be supplied through --token-stdin.'); }
  async read() {
    try {
      const value = (await this.entry()).getPassword();
      return value ? JSON.parse(value) : undefined;
    } catch (e) { if (e instanceof CliError) throw e; throw this.unavailable(); }
  }
  async write(data) {
    try { (await this.entry()).setPassword(JSON.stringify(data)); }
    catch { throw this.unavailable(); }
  }
  async remove() {
    try { const entry = await this.entry(); if (entry.getPassword()) entry.deletePassword(); }
    catch { throw this.unavailable(); }
  }
}

export class OAuthProvider {
  constructor({ server, state, vault, redirectUrl, redirect }) {
    this.server = server;
    this.stateStore = state;
    this.vault = vault;
    this.redirectUrl = redirectUrl;
    this.redirect = redirect;
    this.id = hash(server.href);
    this.oauthState = randomBytes(32).toString('base64url');
  }
  get clientMetadata() {
    return { client_name: 'EvoLink Media CLI', application_type: 'native', redirect_uris: [String(this.redirectUrl)],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'mcp offline_access' };
  }
  state() { return this.oauthState; }
  async clientInformation() { return this.stateStore.read('clients', this.id); }
  async saveClientInformation(value) {
    requireThat(!value.client_secret && value.token_endpoint_auth_method !== 'client_secret_basic', 'invalid_client', 'The CLI requires a public OAuth client.');
    await this.stateStore.write('clients', this.id, value);
  }
  async tokens() { return (await this.vault.read())?.tokens; }
  async saveTokens(tokens) {
    const issuer = this.server.href === SERVER ? ISSUER : this.server.origin;
    requireThat(tokens.issuer === issuer && tokens.token_type?.toLowerCase() === 'bearer', 'invalid_token_response', 'The login service returned an unsupported token.');
    const prior = await this.vault.read();
    await this.vault.write({ tokens, binding: this.newLogin ? randomUUID() : prior?.binding || randomUUID(),
      expires_at: Date.now() + (tokens.expires_in ?? 300) * 1000 });
  }
  async saveCodeVerifier(value) { this.verifier = value; }
  async codeVerifier() { requireThat(this.verifier, 'login_expired', 'Start login again.'); return this.verifier; }
  async redirectToAuthorization(url) {
    if (!this.redirect) throw new CliError('login_required', 'Run evolink-media auth login, then retry this command.');
    await this.redirect(url);
  }
  async invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'client') await this.stateStore.remove('clients', this.id);
    if (scope === 'all' || scope === 'tokens') await this.vault.remove();
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
  }
}

export function openBrowser(url) {
  const command = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32'
    ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url];
  const child = spawn(command[0], command.slice(1), { stdio: 'ignore', detached: true, shell: false });
  child.on('error', () => {});
  child.unref();
}

export async function callbackListener({ state, issuer, timeout = 180_000, signal }) {
  let resolveCode, rejectCode;
  const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // A timeout may happen before login reaches the await on this promise.
  code.catch(() => {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (req.method !== 'GET' || url.pathname !== '/oauth/callback' || url.searchParams.get('state') !== state || url.searchParams.get('iss') !== issuer) {
      res.writeHead(400); res.end('Invalid login callback. Return to the original browser login.'); return;
    }
    if (url.searchParams.has('error')) {
      res.writeHead(400); res.end('Login was not approved. You can close this window.');
      rejectCode(new CliError('login_denied', 'Login was not approved.')); return;
    }
    const value = url.searchParams.get('code');
    if (!value) { res.writeHead(400); res.end('Missing login code.'); return; }
    res.writeHead(200); res.end('EvoLink approval received. Return to your assistant to verify the connection.');
    resolveCode(value);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const timer = setTimeout(() => rejectCode(new CliError('login_timeout', 'Login timed out. Run auth login again.')), timeout);
  const abort = () => rejectCode(new CliError('interrupted', 'Login interrupted.', undefined, 130));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return { redirectUrl: `http://127.0.0.1:${server.address().port}/oauth/callback`, code,
    close: async () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

export class Credentials {
  constructor({ server, state, vault = new Vault(server, state), fetchFn, token }) {
    this.server = server; this.state = state; this.vault = vault;
    this.fetchFn = authFetch(server, fetchFn);
    this.token = token;
  }
  lock(fn) { return this.state.lock(`auth-${hash(this.server.href)}`, fn); }
  provider() { return new OAuthProvider({ server: this.server, state: this.state, vault: this.vault, redirectUrl: 'http://127.0.0.1:1/oauth/callback' }); }
  async access(force = false) {
    if (this.token) {
      // The hash binds quotes to this temporary credential without writing it to disk.
      return { access_token: this.token, binding: hash(this.token) };
    }
    return this.lock(async () => {
      let saved = await this.vault.read();
      requireThat(saved?.tokens, 'login_required', 'Run evolink-media auth login.');
      if (force || saved.expires_at <= Date.now() + 60_000) {
        await auth(this.provider(), { serverUrl: this.server, scope: 'mcp offline_access', fetchFn: this.fetchFn });
        saved = await this.vault.read();
      }
      const issuer = this.server.href === SERVER ? ISSUER : this.server.origin;
      requireThat(saved?.tokens?.issuer === issuer && saved.tokens.access_token, 'login_required', 'This login belongs to a different service. Run auth login.');
      requireThat(saved.binding, 'invalid_session', 'The saved session is incomplete. Run auth login.');
      return { access_token: saved.tokens.access_token, binding: saved.binding };
    });
  }
  async login({ noBrowser = false, progress = () => {}, browser = openBrowser, signal } = {}) {
    requireThat(!this.token, 'invalid_option', 'auth login cannot use --token-stdin.');
    return this.lock(async () => {
      await this.vault.read();
      const provider = this.provider();
      const listener = await callbackListener({ state: provider.oauthState, issuer: this.server.href === SERVER ? ISSUER : this.server.origin, signal });
      provider.redirectUrl = listener.redirectUrl;
      provider.redirect = async url => {
        // Validate the browser destination with the same origin policy as token requests.
        const issuer = this.server.href === SERVER ? ISSUER : this.server.origin;
        requireThat(url.origin === issuer, 'untrusted_auth_server', 'The browser login destination is outside EvoLink.');
        progress(`Open this link to sign in and approve EvoLink:\n${url.href}`);
        if (!noBrowser) browser(url.href);
      };
      try {
        let result = await auth(provider, { serverUrl: this.server, scope: 'mcp offline_access', fetchFn: this.fetchFn });
        if (result === 'REDIRECT') {
          provider.newLogin = true;
          result = await auth(provider, { serverUrl: this.server, scope: 'mcp offline_access', authorizationCode: await listener.code, fetchFn: this.fetchFn });
        }
        requireThat(result === 'AUTHORIZED', 'login_failed', 'Login could not finish.');
        return { authenticated: true, server: this.server.href, credential_storage: 'os_keyring' };
      } finally { await listener.close(); }
    });
  }
  async status() {
    if (this.token) return { authenticated: true, credential_storage: 'stdin', server: this.server.href };
    const saved = await this.vault.read();
    return { authenticated: !!saved?.tokens, server: this.server.href, credential_storage: 'os_keyring', expires_at: saved ? new Date(saved.expires_at).toISOString() : undefined };
  }
  async logout() {
    requireThat(!this.token, 'invalid_option', 'auth logout requires the stored login.');
    return this.lock(async () => {
      const saved = await this.vault.read();
      if (saved?.tokens) {
        const provider = this.provider();
        const client = await provider.clientInformation();
        const issuer = this.server.href === SERVER ? ISSUER : this.server.origin;
        requireThat(saved.tokens.issuer === issuer && client?.issuer === issuer, 'invalid_session', 'This session belongs to a different service.');
        const metadata = await this.fetchFn(`${issuer}/.well-known/oauth-authorization-server`).then(r => r.json());
        requireThat(metadata.issuer === issuer && metadata.revocation_endpoint, 'logout_failed', 'The service did not provide a session revocation endpoint.');
        const response = await this.fetchFn(metadata.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: client.client_id, token: saved.tokens.refresh_token || saved.tokens.access_token,
            token_type_hint: saved.tokens.refresh_token ? 'refresh_token' : 'access_token' }) });
        requireThat(response.ok, 'logout_failed', 'Session revocation failed. Local credentials were retained so logout can be retried.');
      }
      await this.vault.remove();
      return { authenticated: false, session_revoked: !!saved?.tokens };
    });
  }
}
