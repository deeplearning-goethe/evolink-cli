import { CLI_VERSION } from './version.mjs';
import { USER_AGENT, loopback } from './network.mjs';

export const PACKAGE_NAME = '@evolinkai/cli';
// The registry's dist-tags document is a few bytes and needs no login.
export const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;
export const UPGRADE_COMMAND = `npm install -g ${PACKAGE_NAME}@latest`;
export const UPDATE_CHECK_ENV = 'EVOLINK_CLI_UPDATE_CHECK';

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Numeric comparison of two release versions (negative, zero or positive); undefined when either is not a plain release. */
export function compareVersions(a, b) {
  const left = RELEASE.exec(a), right = RELEASE.exec(b);
  if (!left || !right) return undefined;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(left[i]) - Number(right[i]);
    if (difference) return difference;
  }
  return 0;
}

/** Whether a command against this resource may ask the npm registry for the latest release. Loopback test
 * resources and EVOLINK_CLI_UPDATE_CHECK=0 keep the check off. */
export function updateCheckEnabled(server, env = process.env) {
  return !loopback(server) && env[UPDATE_CHECK_ENV] !== '0';
}

/** Compare the running CLI with the latest published release. Any failure only leaves checked false: this never
 * throws and never holds a command for longer than the timeout. */
export async function updateCheck({ fetchFn = fetch, timeout = 3000, current = CLI_VERSION } = {}) {
  const result = { cli_version: current, latest_version: null, update_available: false, checked: false };
  try {
    const response = await fetchFn(DIST_TAGS_URL, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return result;
    const latest = (await response.json())?.latest;
    const comparison = typeof latest === 'string' ? compareVersions(latest, current) : undefined;
    if (comparison === undefined) return result;
    return { ...result, checked: true, latest_version: latest, update_available: comparison > 0,
      ...(comparison > 0 ? { upgrade_command: UPGRADE_COMMAND } : {}) };
  } catch { return result; }
}

/** One sentence for progress output and guidance when a newer release exists. */
export function updateAdvice(update) {
  if (!update?.update_available) return undefined;
  return `EvoLink CLI ${update.latest_version} is available; this is ${update.cli_version}. Run ${UPGRADE_COMMAND}, then evolink skills install.`;
}
