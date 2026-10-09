import { prerequisites, verifyModels } from './doctor.mjs';
import { installSkill, skillStatus, validateAgent } from './skills.mjs';
import { CliError, errorView, requireThat } from './errors.mjs';
import { CLI_VERSION } from './version.mjs';

const LOGIN_ERRORS = new Set(['login_required', 'invalid_session', 'login_expired']);

export async function setup({ state, server, credentials, client, mcp = client, agent = 'all', skillHome, noBrowser = false,
  timeout = 180_000, signal, progress = () => {}, version, platform }) {
  client = mcp;
  validateAgent(agent);
  return state.lock('setup', async () => {
    const steps = [];
    let phase = 'preflight', connected = false, models = false, skills;
    const recovery = () => `evolink setup --agent ${agent}${noBrowser ? ' --no-browser' : ''}`;
    try {
      progress('Setup: checking runtime, local state and secure credential storage.');
      const preflight = await prerequisites({ state, credentials, version, platform });
      steps.push(...preflight.checks);
      const failed = preflight.checks.find(c => c.status === 'failed');
      if (failed) throw new CliError(failed.error.code, failed.error.message, failed.error.details);
      phase = 'skills';
      progress('Setup: checking and installing the bundled skill.');
      // Resolve file conflicts before asking the user to authorize a browser login.
      skills = await installSkill({ home: skillHome, agent });
      steps.push({ name: 'skills', status: 'passed', reused: !skills.updated });
      phase = 'connection';
      let needsLogin = !preflight.auth.authenticated;
      if (!needsLogin) {
        try {
          const balance = await client.call('check_balance');
          requireThat(balance.ok === true, 'connection_failed', 'Balance verification failed. Retry the connection check.');
          connected = true;
        } catch (error) {
          if (!LOGIN_ERRORS.has(error.code)) throw error;
          needsLogin = true;
        }
      }
      phase = 'login';
      if (needsLogin) {
        progress('Setup: browser approval is required. Keep this command running until login finishes.');
        await credentials.login({ noBrowser, timeout, signal, progress });
      }
      steps.push({ name: 'login', status: 'passed', reused: !needsLogin });
      phase = 'connection';
      if (!connected) {
        const balance = await client.call('check_balance');
        requireThat(balance.ok === true, 'connection_failed', 'Balance verification failed. Retry evolink balance --json.');
        connected = true;
      }
      steps.push({ name: 'connection', status: 'passed', verified: true });
      phase = 'models';
      await verifyModels(client); models = true;
      steps.push({ name: 'models', status: 'passed', verified: true });
      phase = 'skills';
      const status = await skillStatus({ home: skillHome, agent });
      requireThat(status.current, 'skill_changed', 'The skill changed during setup. Check evolink skills status before continuing.');
      progress('Setup: CLI connection, models and skill files verified. Ask your assistant to confirm skill discovery.');
      return { ok: true, setup_complete: true, cli_version: CLI_VERSION, agent, server: server.href,
        connection_verified: connected, model_discovery_verified: models, skills, steps,
        assistant_discovery: 'not_checked', next_step: skills.next_step };
    } catch (error) {
      const view = errorView(error);
      steps.push({ name: phase, status: 'failed', error: view });
      return { ok: false, setup_complete: false, cli_version: CLI_VERSION, agent, phase,
        connection_verified: connected, model_discovery_verified: models, assistant_discovery: 'not_checked',
        ...(skills ? { skills } : {}), steps, error: view, recovery: recovery() };
    }
  });
}
