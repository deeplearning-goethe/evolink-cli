import { CliError, requireThat } from './errors.mjs';
import { USER_AGENT, loopback } from './network.mjs';
import { CLI_VERSION } from './version.mjs';

export const UPDATE_PACKAGE = '@evolinkai/cli';
// The registry's dist-tags document is a few bytes and needs no login.
export const UPDATE_URL = 'https://registry.npmjs.org/-/package/@evolinkai%2Fcli/dist-tags';
export const UPDATE_COMMAND = 'npm install -g @evolinkai/cli@latest';
export const UPDATE_CHECK_ENV = 'EVOLINK_CLI_UPDATE_CHECK';
export const UPDATE_INTERVAL = 24 * 60 * 60 * 1000;
export const UPDATE_TIMEOUT = 3_000;
const CLOCK_SKEW = 5 * 60 * 1000;
const MAX_BODY = 16 * 1024;
const CACHE = ['update-check', 'npm'];
const OFF = ['0', 'false', 'no', 'off'];
// Numeric parts stay within exact Number precision.
const NUMBER = '0|[1-9]\\d{0,14}';
const IDENTIFIER = `(?:${NUMBER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(`^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

export function parseVersion(value) {
  const match = typeof value === 'string' && value.length <= 128 ? SEMVER.exec(value) : null;
  return match ? { core: match.slice(1, 4).map(Number), prerelease: match[4] ? match[4].split('.') : [] } : undefined;
}
const stable = value => parseVersion(value)?.prerelease.length === 0;

// Semantic Versioning 2.0.0 precedence; build metadata is ignored. Invalid input returns undefined.
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) return undefined;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  if (!a.prerelease.length || !b.prerelease.length) return Math.sign(b.prerelease.length - a.prerelease.length);
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x), yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

const normalized = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
/** Why update checks are off, if they are: EVOLINK_CLI_UPDATE_CHECK=0, NO_UPDATE_NOTIFIER with any value (the
 * update-notifier convention), a CI variable that is not 0/false, or a loopback test resource. */
export function updateCheckDisabled(env = process.env, server) {
  if (OFF.includes(normalized(env[UPDATE_CHECK_ENV]))) return UPDATE_CHECK_ENV;
  if (env.NO_UPDATE_NOTIFIER !== undefined) return 'NO_UPDATE_NOTIFIER';
  if (normalized(env.CI) && !OFF.includes(normalized(env.CI))) return 'CI';
  if (server && loopback(server)) return 'loopback_server';
  return undefined;
}

async function readLimited(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    requireThat(size <= MAX_BODY, 'update_check_failed', 'The npm registry response was too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

let abandoned = 0;
/** Requests given up at the deadline or on interrupt. fetch keeps their sockets open after the abort (10 seconds
 * without an answer, minutes through a proxy that never answers CONNECT), so the entry point exits instead. */
export const abandonedUpdateChecks = () => abandoned;

export async function fetchLatestVersion({ fetchFn = fetch, timeout = UPDATE_TIMEOUT, signal } = {}) {
  requireThat(!signal?.aborted, 'interrupted', 'The update check was interrupted.');
  const controller = new AbortController();
  let timer, stop, settled = false;
  // The deadline does not depend on the transport honoring its abort signal.
  const deadline = new Promise((_, reject) => {
    stop = () => {
      if (!settled) abandoned++;
      controller.abort(); reject(new CliError('update_check_failed', 'The npm registry did not answer in time.'));
    };
    timer = setTimeout(stop, timeout);
    signal?.addEventListener('abort', stop, { once: true });
  });
  const request = async () => {
    const response = await fetchFn(UPDATE_URL, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CliError('update_check_failed', `The npm registry returned HTTP ${response.status}.`);
    }
    let latest;
    try { latest = JSON.parse(await readLimited(response))?.latest; }
    catch (error) { if (error instanceof CliError) throw error; }
    requireThat(stable(latest), 'update_check_failed', 'The npm registry returned no stable latest version.');
    return latest;
  };
  try { return await Promise.race([deadline, request().finally(() => { settled = true; })]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}

// Damaged or foreign records are ignored; they only delay a notice until the next check.
function record(value) {
  const base = { schema_version: 1, package: UPDATE_PACKAGE };
  if (value?.schema_version !== 1 || value.package !== UPDATE_PACKAGE) return base;
  return Object.assign(base, ...['checked_at', 'latest_version', 'latest_checked_at', 'notified_version', 'notified_at']
    .filter(key => typeof value[key] === 'string').map(key => ({ [key]: value[key] })));
}
async function readRecord(state) {
  try { return record(await state.read(...CACHE)); } catch { return record(); }
}
// Read again just before writing: another command may have recorded a newer answer or notice meanwhile.
// A damaged record reads as empty, so the write also repairs it.
async function saveRecord(state, fields) {
  await state.write(...CACHE, { ...(await readRecord(state)), ...fields });
}
function recent(value, time) {
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= time + CLOCK_SKEW && time - at < UPDATE_INTERVAL;
}

/** Compare the running CLI with the latest stable npm release. Never throws, and never waits longer than the
 * timeout. Without force, a registry answer from the last 24 hours is reused. */
export async function checkForUpdate({ state, server, env = process.env, fetchFn, now = Date.now, current = CLI_VERSION, force = false, timeout, signal } = {}) {
  const view = (status, latest, extra) => ({ status, update_available: status === 'available', current_version: current,
    latest_version: latest ?? null, ...extra, command: UPDATE_COMMAND });
  const disabled = updateCheckDisabled(env, server);
  if (disabled) return view('disabled', null, { reason: disabled });
  const time = now();
  let saved = await readRecord(state), failed = false;
  if (force || !recent(saved.checked_at, time)) {
    // Record the attempt before the request: offline and concurrent runs wait for the next interval, and an
    // unwritable state directory never leads to repeated network checks. setup, doctor and login always ask.
    const checked_at = new Date(time).toISOString();
    try { await saveRecord(state, { checked_at }); }
    catch { if (!force) return view('unknown', null, { reason: 'state_unavailable' }); }
    try {
      saved = { ...saved, latest_version: await fetchLatestVersion({ fetchFn, timeout, signal }), latest_checked_at: checked_at };
      await saveRecord(state, { checked_at, latest_version: saved.latest_version, latest_checked_at: checked_at }).catch(() => {});
    } catch { failed = true; }
  }
  // A failed request keeps the last verified registry answer.
  const latest = stable(saved.latest_version) ? saved.latest_version : undefined;
  if (!latest) return view('unknown', null, { reason: 'registry_unavailable' });
  return view(compareVersions(latest, current) > 0 ? 'available' : 'current', latest,
    { ...(saved.latest_checked_at ? { checked_at: saved.latest_checked_at } : {}), ...(failed ? { reason: 'registry_unavailable' } : {}) });
}

export const updateMessage = ({ latest_version, current_version }) =>
  `EvoLink CLI ${latest_version} is available (installed ${current_version}). Update with ${UPDATE_COMMAND}, then run evolink skills install.`;

/** One sentence for progress output and guidance when a newer release exists. */
export const updateAdvice = update => update?.update_available ? updateMessage(update) : undefined;

/** One stderr line for other commands, at most once per interval for the same release. */
export async function updateNotice(options) {
  const result = await checkForUpdate(options);
  if (result.status !== 'available' || options.signal?.aborted) return undefined;
  const time = (options.now || Date.now)();
  const saved = await readRecord(options.state);
  if (saved.notified_version === result.latest_version && recent(saved.notified_at, time)) return undefined;
  try { await saveRecord(options.state, { notified_version: result.latest_version, notified_at: new Date(time).toISOString() }); }
  catch { return undefined; }
  return updateMessage(result);
}
