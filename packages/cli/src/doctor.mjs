import * as fs from 'node:fs/promises';
import path from 'node:path';
import { CliError, errorView, requireThat } from './errors.mjs';

export async function doctor({ state, server, credentials, mcp, version = process.version, platform = process.platform, remote = !!process.env.SSH_CONNECTION }) {
  const checks = [];
  async function check(name, action) {
    try { const details = await action(); checks.push({ name, status: 'passed', ...details }); return details; }
    catch (error) { checks.push({ name, status: 'failed', error: errorView(error) }); }
  }
  const runtime = await check('runtime', async () => {
    requireThat(Number(version.replace(/^v/, '').split('.')[0]) >= 22, 'unsupported_runtime', 'Install Node.js 22 or newer before using this CLI.');
    return { version, platform };
  });
  const storage = await check('local_state', async () => {
    await fs.mkdir(state.home, { recursive: true, mode: 0o700 });
    const probe = await fs.mkdtemp(path.join(state.home, '.doctor-'));
    try { await fs.writeFile(path.join(probe, 'probe'), 'EvoLink diagnostic', { mode: 0o600 }); }
    finally { await fs.rm(probe, { recursive: true, force: true }); }
    return { writable: true };
  });
  const auth = await check('credential_storage', () => credentials.status());
  const login = auth?.authenticated === true;
  if (auth) checks.push(login ? { name: 'login', status: 'passed' } : {
    name: 'login', status: 'failed', error: errorView(new CliError('login_required', 'Run evolink auth login, finish browser approval, then run doctor again.')),
  });
  else checks.push({ name: 'login', status: 'skipped', reason: 'Credential storage must be available before checking the saved login.' });
  let connected = false;
  if (runtime && storage && login) {
    connected = !!await check('connection', async () => {
      const result = await mcp.call('check_balance');
      requireThat(result.ok === true, 'connection_failed', 'Balance verification failed. Retry evolink balance --json.');
      return { verified: true };
    });
  } else checks.push({ name: 'connection', status: 'skipped', reason: 'Fix the failed prerequisite checks before verifying the account connection.' });
  const guidance = [];
  if (platform === 'linux') guidance.push('Linux needs an unlocked Secret Service keyring in the current D-Bus session. Run login and later commands in that same session; tokens are never saved to plaintext files.');
  if (remote) guidance.push('SSH login redirects the browser to 127.0.0.1 on the CLI host. Use SSH local port forwarding for the callback port printed in the authorization link, or run the CLI on your local computer. --no-browser only prints the link; it does not forward the callback.');
  return { ok: connected, node: version, server: server.href, ...(auth ? { auth } : {}), connection_verified: connected, checks, guidance };
}
