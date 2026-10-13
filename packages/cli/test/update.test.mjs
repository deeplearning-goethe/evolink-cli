import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { State } from '../src/state.mjs';
import { main } from '../src/cli.mjs';
import { doctor } from '../src/doctor.mjs';
import { installSkill } from '../src/skills.mjs';
import { Credentials } from '../src/auth.mjs';
import { CliError } from '../src/errors.mjs';
import { serverURL, USER_AGENT } from '../src/network.mjs';
import { CLI_VERSION } from '../src/version.mjs';
import { abandonedUpdateChecks, checkForUpdate, compareVersions, parseVersion, updateAdvice, updateCheckDisabled, updateMessage, updateNotice,
  UPDATE_CHECK_ENV, UPDATE_COMMAND, UPDATE_INTERVAL, UPDATE_URL } from '../src/update.mjs';
import { fixture } from './fixture.mjs';
import { Mcp } from './legacy-mcp.mjs';

// Reproduce a run with EVOLINK_TEST_SEED=<seed>.
const SEED = Number(process.env.EVOLINK_TEST_SEED || 20261013);
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-13T00:00:00.000Z');
const iso = time => new Date(time).toISOString();
const LOOPBACK = serverURL('http://127.0.0.1:1/mcp');

function generator(seed) {
  let value = seed >>> 0;
  return () => (value = (Math.imul(value, 1664525) + 1013904223) >>> 0);
}
function shuffle(items, seed) {
  const next = generator(seed);
  for (let i = items.length - 1; i > 0; i--) { const j = next() % (i + 1); [items[i], items[j]] = [items[j], items[i]]; }
  return items;
}
async function temporary(t, prefix = 'evolink-update-') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}
// The cache logic without fsync-bound file writes; real State is covered by the notice, read-only and main tests.
function memoryState({ value, writable = true } = {}) {
  let stored = value;
  return {
    get value() { return stored; },
    async read() {
      if (stored === 'corrupt') throw new CliError('state_unreadable', 'Local state is unreadable.');
      return stored === undefined ? undefined : structuredClone(stored);
    },
    async write(group, id, data) {
      if (!writable) throw Object.assign(new Error('read-only state'), { code: 'EACCES' });
      stored = structuredClone(data);
    },
  };
}
// A fake npm registry that records each request.
function registry(behaviour) {
  const calls = [];
  const json = body => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    if (behaviour.kind === 'version') return json({ latest: behaviour.version, next: '99.0.0-beta.1' });
    if (behaviour.kind === 'status') return new Response('{"error":"unavailable"}', { status: behaviour.status });
    if (behaviour.kind === 'body') return json(behaviour.body);
    if (behaviour.kind === 'network') throw new TypeError('fetch failed');
    return new Promise(() => {}); // Never answers and ignores the abort signal.
  };
  return { calls, fetchFn };
}
const BEHAVIOURS = {
  newer: { kind: 'version', version: '1.6.0' },
  same: { kind: 'version', version: '1.5.0' },
  older: { kind: 'version', version: '1.4.9' },
  prerelease: { kind: 'version', version: '1.6.0-rc.1' },
  http: { kind: 'status', status: 503 },
  invalid: { kind: 'body', body: 'not json' },
  missing: { kind: 'body', body: { next: '1.6.0' } },
  oversized: { kind: 'body', body: { latest: '1.6.0', padding: 'x'.repeat(20_000) } },
  network: { kind: 'network' },
  hang: { kind: 'hang' },
};
const REGISTRY_LATEST = { newer: '1.6.0', same: '1.5.0', older: '1.4.9' };
// Independent reference for stable versions.
function newer(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

test('versions follow semantic-version precedence and reject malformed input', () => {
  const ordered = ['0.0.1', '0.9.0', '0.9.1', '0.9.2', '0.9.10', '0.10.0', '0.99.99', '1.0.0-0', '1.0.0-1', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta',
    '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '10.0.0'];
  for (let i = 0; i < ordered.length; i++) for (let j = 0; j < ordered.length; j++) {
    assert.equal(compareVersions(ordered[i], ordered[j]), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
  }
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-rc.1+exp.sha', '1.0.0-rc.1'), 0);
  for (const value of ['', '1', '1.0', '01.0.0', '1.00.0', 'v1.0.0', '1.0.0-', '1.0.0-01', '1.0.0+', '1.0.0 ', ' 1.0.0', 'latest', 'next',
    '1.0.0-a..b', '1234567890123456.0.0', `1.0.0-${'a'.repeat(130)}`, null, undefined, 1, {}]) {
    assert.equal(parseVersion(value), undefined, String(value));
    assert.equal(compareVersions(value, '1.0.0'), undefined); assert.equal(compareVersions('1.0.0', value), undefined);
  }
});

test(`seeded version triples keep precedence antisymmetric, transitive and core-first (seed ${SEED})`, () => {
  const next = generator(SEED);
  const pick = list => list[next() % list.length];
  const identifiers = ['0', '1', '2', '10', 'alpha', 'beta', 'rc', 'x-1', '1a'];
  const make = () => `${pick([0, 1, 2, 10])}.${pick([0, 1, 9, 10])}.${pick([0, 1, 2])}` +
    (next() % 2 ? '' : `-${Array.from({ length: 1 + next() % 3 }, () => pick(identifiers)).join('.')}`) + (next() % 5 ? '' : '+build');
  for (let i = 0; i < 3000; i++) {
    const [a, b, c] = [make(), make(), make()];
    const ab = compareVersions(a, b), bc = compareVersions(b, c), ac = compareVersions(a, c);
    assert.ok([ab, bc, ac].every(v => [-1, 0, 1].includes(v)), `${a} ${b} ${c}`);
    assert.ok(ab === -compareVersions(b, a), `${a} ${b}`);
    assert.equal(compareVersions(a, a), 0);
    if (ab <= 0 && bc <= 0) assert.ok(ac <= 0, `${a} <= ${b} <= ${c}`);
    const coreA = a.split(/[-+]/)[0], coreB = b.split(/[-+]/)[0];
    if (coreA !== coreB) assert.equal(ab, newer(coreA, coreB) ? 1 : -1, `${a} ${b}`);
    else if (a.includes('-') !== b.includes('-')) assert.equal(ab, a.includes('-') ? -1 : 1, `${a} ${b}`);
  }
});

test('every switch, convention and server combination is honored in priority order', { timeout: 30_000 }, async () => {
  assert.equal(UPDATE_CHECK_ENV, 'EVOLINK_CLI_UPDATE_CHECK');
  assert.equal(updateCheckDisabled({}, serverURL()), undefined);
  assert.equal(updateCheckDisabled({}, LOOPBACK), 'loopback_server');
  assert.equal(updateCheckDisabled({ EVOLINK_CLI_UPDATE_CHECK: '0' }, serverURL()), 'EVOLINK_CLI_UPDATE_CHECK');
  assert.equal(updateCheckDisabled({ EVOLINK_CLI_UPDATE_CHECK: '1' }, serverURL()), undefined);
  assert.equal(updateCheckDisabled({ NO_UPDATE_NOTIFIER: '' }, serverURL()), 'NO_UPDATE_NOTIFIER');
  const values = [undefined, '', '0', 'false', 'FALSE', ' no ', 'off', '1', 'true', 'yes', 'anything'];
  const off = value => value !== undefined && ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
  const on = value => value !== undefined && value.trim() !== '' && !off(value);
  // NO_UPDATE_NOTIFIER follows the update-notifier convention: present with any value means off.
  const expected = (env, server) => off(env.EVOLINK_CLI_UPDATE_CHECK) ? 'EVOLINK_CLI_UPDATE_CHECK' : env.NO_UPDATE_NOTIFIER !== undefined ? 'NO_UPDATE_NOTIFIER'
    : on(env.CI) ? 'CI' : server === LOOPBACK ? 'loopback_server' : undefined;
  const combinations = values.flatMap(a => values.flatMap(b => values.flatMap(c => [undefined, serverURL(), LOOPBACK].map(server =>
    ({ env: Object.fromEntries(Object.entries({ EVOLINK_CLI_UPDATE_CHECK: a, NO_UPDATE_NOTIFIER: b, CI: c }).filter(([, value]) => value !== undefined)), server })))));
  assert.equal(combinations.length, 3993);
  for (const { env, server } of combinations) assert.equal(updateCheckDisabled(env, server), expected(env, server), JSON.stringify(env));
  for (const { env, server } of shuffle(combinations, SEED).slice(0, 80)) {
    const state = memoryState(), fake = registry(BEHAVIOURS.newer);
    const result = await checkForUpdate({ state, server, env, fetchFn: fake.fetchFn, now: () => T0, current: '1.5.0', timeout: 500 });
    const reason = expected(env, server);
    assert.equal(result.status, reason ? 'disabled' : 'available'); assert.equal(result.reason, reason);
    assert.equal(result.update_available, !reason);
    assert.equal(fake.calls.length, reason ? 0 : 1);
    assert.equal(state.value === undefined, !!reason);
  }
});

test(`cache state, registry answer, writable state and forced checks combine into one bounded check (seed ${SEED})`, { timeout: 60_000 }, async () => {
  const caches = {
    none: () => undefined,
    corrupt: () => 'corrupt',
    fresh: latest => ({ checked_at: iso(T0 - HOUR), latest_version: latest }),
    stale: latest => ({ checked_at: iso(T0 - 25 * HOUR), latest_version: latest }),
    boundary: latest => ({ checked_at: iso(T0 - UPDATE_INTERVAL), latest_version: latest }),
    future: latest => ({ checked_at: iso(T0 + 48 * HOUR), latest_version: latest }),
    foreign: latest => ({ package: 'another-package', checked_at: iso(T0 - HOUR), latest_version: latest }),
  };
  const combinations = [];
  for (const cache of Object.keys(caches)) for (const cached of ['none', 'corrupt'].includes(cache) ? [undefined] : ['2.0.0', '1.0.0']) {
    for (const behaviour of Object.keys(BEHAVIOURS)) for (const force of [false, true]) for (const writable of [true, false]) {
      combinations.push({ cache, cached, behaviour, force, writable });
    }
  }
  assert.equal(combinations.length, 480);
  for (const { cache, cached, behaviour, force, writable } of shuffle(combinations, SEED)) {
    const label = `${cache}/${cached}/${behaviour}/force=${force}/writable=${writable}`;
    const value = caches[cache](cached);
    const initial = value === undefined || typeof value === 'string' ? value
      : { schema_version: 1, package: '@evolinkai/cli', latest_checked_at: value.checked_at, ...value };
    const state = memoryState({ value: initial, writable }), fake = registry(BEHAVIOURS[behaviour]);
    const started = Date.now();
    const result = await checkForUpdate({ state, server: serverURL(), env: {}, fetchFn: fake.fetchFn, now: () => T0, current: '1.5.0', force, timeout: 40 });
    assert.ok(Date.now() - started < 1500, label);
    // Ordinary commands stop when they cannot record the attempt; setup, doctor and login ask anyway.
    const due = force || cache !== 'fresh';
    const fetches = due && (writable || force);
    const fetched = fetches ? REGISTRY_LATEST[behaviour] : undefined;
    const usable = ['fresh', 'stale', 'boundary', 'future'].includes(cache) ? cached : undefined;
    const latest = due && !fetches ? undefined : fetched ?? usable;
    const status = latest === undefined ? 'unknown' : newer(latest, '1.5.0') ? 'available' : 'current';
    assert.equal(fake.calls.length, fetches ? 1 : 0, label);
    if (fetches) {
      const [{ url, options }] = fake.calls;
      assert.equal(url, UPDATE_URL); assert.equal(options.redirect, 'error');
      assert.equal(options.headers['User-Agent'], USER_AGENT); assert.ok(options.signal instanceof AbortSignal);
    }
    assert.equal(result.status, status, label);
    if (due && !fetches) assert.equal(result.reason, 'state_unavailable', label);
    assert.equal(result.update_available, status === 'available', label);
    assert.equal(result.latest_version, latest ?? null, label);
    assert.equal(result.current_version, '1.5.0'); assert.equal(result.command, UPDATE_COMMAND);
    assert.equal(updateAdvice(result), status === 'available' ? updateMessage(result) : undefined, label);
    if (!writable) assert.deepEqual(state.value, initial, label);
    else if (fetches) {
      // A damaged or foreign record is replaced by a clean one.
      assert.equal(state.value.package, '@evolinkai/cli', label);
      assert.equal(state.value.checked_at, iso(T0), label);
      assert.equal(state.value.latest_version, fetched ?? usable, label);
      if (fetched) assert.equal(state.value.latest_checked_at, iso(T0), label);
    } else assert.deepEqual(state.value, initial, label);
  }
});

// Explicit timeouts: a mutant that removes the deadline must fail here, not hang the test process.
test('a forced check reports a newer release, stays quiet otherwise, never throws and counts abandoned requests', { timeout: 10_000 }, async () => {
  const check = (fetchFn, current = '0.9.2') => checkForUpdate({ state: memoryState(), server: serverURL(), env: {}, fetchFn, now: () => T0, current, force: true, timeout: 50 });
  const reply = (status, body) => async (url, init) => {
    assert.equal(url, UPDATE_URL); assert.equal(init.redirect, 'error'); assert.match(init.headers['User-Agent'], /^EvoLinkCLI\//);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const initial = abandonedUpdateChecks();
  const available = await check(reply(200, { latest: '0.9.3' }));
  assert.deepEqual(available, { status: 'available', update_available: true, current_version: '0.9.2', latest_version: '0.9.3',
    checked_at: iso(T0), command: UPDATE_COMMAND });
  assert.match(updateAdvice(available), /0\.9\.3.*0\.9\.2.*npm install -g @evolinkai\/cli@latest.*skills install/);
  for (const current of ['0.9.3', '0.9.4', '1.0.0']) {
    const same = await check(reply(200, { latest: '0.9.3' }), current);
    assert.equal(same.status, 'current', current); assert.equal(same.update_available, false); assert.equal(updateAdvice(same), undefined);
  }
  const unknown = { status: 'unknown', update_available: false, current_version: '0.9.2', latest_version: null, reason: 'registry_unavailable', command: UPDATE_COMMAND };
  for (const fetchFn of [reply(500, {}), reply(200, { latest: 'next' }), reply(200, { latest: '0.9.4-beta.1' }), reply(200, {}), reply(200, []),
    reply(200, { latest: '0.9.4', padding: 'x'.repeat(20_000) }), async () => { throw new Error('offline'); }]) {
    assert.deepEqual(await check(fetchFn), unknown);
  }
  assert.equal(abandonedUpdateChecks(), initial, 'Answered or failed requests are not abandoned');
  // A prerelease or failed answer never replaces the last verified stable release.
  const verified = memoryState({ value: { schema_version: 1, package: '@evolinkai/cli', checked_at: iso(T0 - HOUR), latest_version: '0.9.3', latest_checked_at: iso(T0 - HOUR) } });
  const kept = await checkForUpdate({ state: verified, server: serverURL(), env: {}, fetchFn: reply(200, { latest: '0.9.4-beta.1' }), now: () => T0, current: '0.9.2', force: true, timeout: 50 });
  assert.equal(kept.status, 'available'); assert.equal(kept.latest_version, '0.9.3'); assert.equal(kept.reason, 'registry_unavailable');
  assert.equal(verified.value.latest_version, '0.9.3');
  // A real request keeps the event loop alive until the deadline fires; this stand-in does the same with a timer.
  const hanging = async (url, init) => new Promise((resolve, reject) => {
    const socket = setTimeout(() => {}, 2000);
    init.signal.addEventListener('abort', () => { clearTimeout(socket); reject(init.signal.reason); });
  });
  const started = Date.now();
  assert.deepEqual(await check(hanging), unknown);
  assert.deepEqual(await check(() => new Promise(() => {})), unknown, 'The deadline does not depend on the transport');
  assert.ok(Date.now() - started < 1000);
  assert.equal(abandonedUpdateChecks(), initial + 2, 'The entry point exits instead of waiting for abandoned sockets');
  assert.equal(updateAdvice(undefined), undefined);
});

test('notices repeat a release at most once per interval and announce a newer release after the next check', { timeout: 10_000 }, async t => {
  const home = await temporary(t), state = new State(path.join(home, 'notices'));
  let latest = '1.6.0';
  const calls = [];
  const fetchFn = async () => { calls.push(latest); return new Response(JSON.stringify({ latest })); };
  const notice = (at, current = '1.5.0', target = state, signal) => updateNotice({ state: target, env: {}, fetchFn, now: () => T0 + at, current, timeout: 500, signal });
  const message = version => updateMessage({ latest_version: version, current_version: '1.5.0' });
  assert.equal(await notice(0), message('1.6.0'));
  assert.equal(await notice(HOUR), undefined);
  latest = '1.7.0';
  assert.equal(await notice(2 * HOUR), undefined, 'The cached answer is reused within the interval');
  assert.deepEqual(calls, ['1.6.0']);
  assert.equal(await notice(24 * HOUR), message('1.7.0'));
  assert.equal(await notice(25 * HOUR), undefined);
  assert.equal(await notice(48 * HOUR), message('1.7.0'), 'The same release is announced again after the interval');
  assert.equal(await notice(49 * HOUR, '1.7.0'), undefined, 'An upgraded CLI is not reminded');
  assert.equal(calls.length, 3);
  assert.match(message('1.6.0'), /^EvoLink CLI 1\.6\.0 is available \(installed 1\.5\.0\)\. Update with npm install -g @evolinkai\/cli@latest, then run evolink skills install\.$/);
  // An interrupted command prints nothing, so the release is still announced by the next command.
  const interrupted = new State(path.join(home, 'interrupted'));
  await checkForUpdate({ state: interrupted, env: {}, fetchFn, now: () => T0, current: '1.5.0' });
  assert.equal(await notice(HOUR, '1.5.0', interrupted, AbortSignal.abort()), undefined);
  assert.equal(await notice(2 * HOUR, '1.5.0', interrupted), message('1.7.0'));
});

test('an unwritable state directory keeps ordinary commands offline but not forced checks', { timeout: 10_000 }, async t => {
  const home = await temporary(t), file = path.join(home, 'file');
  await fs.writeFile(file, 'not a directory');
  const state = new State(path.join(file, 'state')), fake = registry(BEHAVIOURS.newer);
  const ordinary = await checkForUpdate({ state, env: {}, fetchFn: fake.fetchFn, now: () => T0, current: '1.5.0' });
  assert.equal(ordinary.status, 'unknown'); assert.equal(ordinary.reason, 'state_unavailable');
  assert.equal(await updateNotice({ state, env: {}, fetchFn: fake.fetchFn, now: () => T0, current: '1.5.0' }), undefined);
  assert.equal(fake.calls.length, 0);
  const forced = await checkForUpdate({ state, env: {}, fetchFn: fake.fetchFn, now: () => T0, current: '1.5.0', force: true });
  assert.equal(forced.status, 'available'); assert.equal(forced.latest_version, '1.6.0');
  assert.equal(fake.calls.length, 1);
});

test('main prints the notice on stderr after valid commands only, keeps stdout and exit status, and honors opt-out', { timeout: 30_000 }, async t => {
  const home = await temporary(t);
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  const latest = registry({ kind: 'version', version: '99.0.0' });
  const run = async (argv, { env = {}, fetchFn = latest.fetchFn, at = 0, state = new State(path.join(home, 'main')), stdin = process.stdin } = {}) => {
    const out = { stdout: '', stderr: '' };
    process.exitCode = undefined;
    await main(argv, { stdout: { write: s => { out.stdout += s; } }, stderr: { write: s => { out.stderr += s; } }, stdin },
      { env, fetchFn, now: () => T0 + at, timeout: 200, updateState: state });
    return { ...out, code: process.exitCode ?? 0 };
  };
  const message = `${updateMessage({ latest_version: '99.0.0', current_version: CLI_VERSION })}\n`;
  assert.deepEqual(await run(['--version']), { stdout: `${CLI_VERSION}\n`, stderr: message, code: 0 });
  assert.deepEqual(await run(['--version'], { at: HOUR }), { stdout: `${CLI_VERSION}\n`, stderr: '', code: 0 });
  assert.equal(latest.calls.length, 1);
  const json = await run(['--version', '--json'], { state: new State(path.join(home, 'json')) });
  assert.deepEqual(JSON.parse(json.stdout), { schema_version: 1, ok: true, version: CLI_VERSION });
  assert.equal(json.stdout.trim().split('\n').length, 1); assert.equal(json.stderr, message);
  // A validated command that fails locally still reports its own error first, on stdout in JSON mode.
  const failed = await run(['estimate', '--json'], { state: new State(path.join(home, 'failed')) });
  assert.equal(failed.code, 1); assert.equal(JSON.parse(failed.stdout).error.code, 'missing_model'); assert.equal(failed.stderr, message);
  const quiet = registry({ kind: 'version', version: '99.0.0' });
  for (const argv of [[], ['--help'], ['--help', '--json'], ['tasks', 'list', '--help'], ['balance', '--help', '--json'], ['nope'], ['--bogus'],
    ['doctor', '--replace-modified', '--json'], ['estimate', '--server', 'http://127.0.0.1:9/mcp', '--json'],
    ['balance', '--api-url', 'https://service.invalid', '--json'], ['auth', 'status', '--token-stdin', '--json']]) {
    const result = await run(argv, { fetchFn: quiet.fetchFn, state: new State(path.join(home, 'quiet')), stdin: Readable.from(['fixture-status-token']) });
    assert.ok(!result.stderr.includes('is available'), argv.join(' '));
    if (argv[0] === 'auth') assert.equal(JSON.parse(result.stdout).credential_storage, 'stdin');
    if (argv.includes('--api-url')) assert.equal(JSON.parse(result.stdout).error.code, 'invalid_api_url');
  }
  assert.equal(quiet.calls.length, 0, 'Help, invalid commands, loopback test resources and auth status do not contact the registry');
  for (const env of [{ EVOLINK_CLI_UPDATE_CHECK: '0' }, { EVOLINK_CLI_UPDATE_CHECK: 'off' }, { NO_UPDATE_NOTIFIER: '1' }, { CI: 'true' }]) {
    const optedOut = registry({ kind: 'version', version: '99.0.0' });
    const result = await run(['--version'], { env, fetchFn: optedOut.fetchFn, state: new State(path.join(home, JSON.stringify(env).replace(/\W/g, ''))) });
    assert.deepEqual(result, { stdout: `${CLI_VERSION}\n`, stderr: '', code: 0 });
    assert.equal(optedOut.calls.length, 0);
  }
  const silent = registry(BEHAVIOURS.hang), started = Date.now();
  assert.deepEqual(await run(['--version'], { fetchFn: silent.fetchFn, state: new State(path.join(home, 'hang')) }), { stdout: `${CLI_VERSION}\n`, stderr: '', code: 0 });
  assert.ok(Date.now() - started < 2000, 'An unresponsive registry delays the command by at most the timeout');
});

test(`plain doctor reports update and installed-skill findings as guidance without changing ok (seed ${SEED})`, { timeout: 60_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const home = await temporary(t, 'evolink-update-doctor-');
  const state = new State(path.join(home, 'state'));
  const credentials = new Credentials({ state, server: f.server, token: 'fixture-update-token' });
  const mcp = new Mcp(credentials);
  const skillHomes = {};
  for (const kind of ['not_installed', 'current', 'outdated', 'needs_attention']) {
    skillHomes[kind] = path.join(home, kind);
    await fs.mkdir(skillHomes[kind], { recursive: true });
    if (kind === 'not_installed') continue;
    const installed = await installSkill({ home: skillHomes[kind] });
    if (kind === 'current') continue;
    const manifest = path.join(path.dirname(installed.installations[0].path), '.evolink-cli.json');
    const metadata = JSON.parse(await fs.readFile(manifest, 'utf8'));
    await fs.writeFile(manifest, JSON.stringify({ ...metadata, cli_version: '0.4.0' }));
    if (kind === 'needs_attention') await fs.appendFile(installed.installations[1].path, '\nPersonal instruction.');
  }
  const updates = {
    available: { env: {}, behaviour: { kind: 'version', version: '99.0.0' } },
    current: { env: {}, behaviour: { kind: 'version', version: CLI_VERSION } },
    unknown: { env: {}, behaviour: { kind: 'network' } },
    disabled: { env: { EVOLINK_CLI_UPDATE_CHECK: '0' }, behaviour: { kind: 'version', version: '99.0.0' } },
  };
  const loggedOut = { status: async () => ({ authenticated: false }) };
  const combinations = Object.keys(updates).flatMap(update => Object.keys(skillHomes).flatMap(skills => [true, false].map(login => ({ update, skills, login }))));
  assert.equal(combinations.length, 32);
  for (const { update, skills, login } of shuffle(combinations, SEED)) {
    const label = `${update}/${skills}/login=${login}`;
    const fake = registry(updates[update].behaviour);
    const result = await doctor({ state, server: f.server, credentials: login ? credentials : loggedOut, mcp, platform: 'darwin', remote: false,
      skillHome: skillHomes[skills], update: () => checkForUpdate({ state: memoryState(), env: updates[update].env, fetchFn: fake.fetchFn, now: () => T0, force: true, timeout: 500 }) });
    assert.equal(result.ok, login, label);
    assert.equal(result.checks.length, 6, label);
    assert.equal(result.update.status, update, label);
    assert.equal(result.update.update_available, update === 'available', label);
    assert.equal(result.update.current_version, CLI_VERSION); assert.equal(result.update.command, UPDATE_COMMAND);
    assert.equal(fake.calls.length, update === 'disabled' ? 0 : 1, label);
    assert.equal(result.guidance.includes(updateMessage({ latest_version: '99.0.0', current_version: CLI_VERSION })), update === 'available', label);
    assert.equal(result.skills.status, skills, label);
    assert.equal(result.skills.installations.length, skills === 'not_installed' ? 0 : 4, label);
    assert.equal(result.guidance.some(g => g.startsWith('Installed evolink-cli skill files are older')), skills === 'outdated', label);
    assert.equal(result.guidance.some(g => g.includes('has local changes or conflicts')), skills === 'needs_attention', label);
  }
  // A selected agent keeps the strict skill check and does not add the installed-skill summary.
  const selected = await doctor({ state, server: f.server, credentials, mcp, platform: 'darwin', remote: false, agent: 'codex',
    skillHome: skillHomes.outdated, update: () => checkForUpdate({ state: memoryState(), force: true, env: { CI: 'true' } }) });
  assert.equal(selected.ok, false); assert.equal(selected.skills, undefined);
  assert.equal(selected.checks.find(c => c.name === 'skills').status, 'failed');
  assert.equal(selected.update.status, 'disabled'); assert.equal(selected.update.reason, 'CI');
});
