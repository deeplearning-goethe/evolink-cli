import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// fileURLToPath handles Windows drive letters and spaces.
const { fileURLToPath } = await import('node:url');
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const mutants = [
  ['approval', 'src/media.mjs', 'requireThat(confirmed || resume,', 'requireThat(true,'],
  ['fresh-price', 'src/media.mjs', 'priceFingerprint(fresh) === quote.fingerprint', 'true'],
  ['cap-direction', 'src/media.mjs', 'quote.estimate.max_usd <= cap', 'quote.estimate.max_usd >= cap'],
  ['partial-cap', 'src/media.mjs', "quote.estimate?.status === 'estimated' && Number.isFinite(quote.estimate.max_usd)", 'Number.isFinite(quote.estimate.max_usd)'],
  ['invalid-input', 'src/media.mjs', 'quote.input_valid !== false', 'true'],
  ['balance', 'src/media.mjs', 'quote.enough_balance !== false', 'true'],
  ['mcp-limit', 'src/media.mjs', 'quote.enough_limit !== false', 'true'],
  ['daily-limit', 'src/media.mjs', 'quote.enough_daily_limit !== false', 'true'],
  ['input-validation-cap', 'src/media.mjs', 'quote.input_valid === true', 'true'],
  ['estimated-price-range', 'src/media.mjs', 'Number.isFinite(max_usd) && max_usd >= 0', 'true'],
  ['request-id', 'src/media.mjs', 'this.mcp.call(`generate_${kind}`, { ...quote.args, client_request_id: quote.client_request_id })', 'this.mcp.call(`generate_${kind}`, { ...quote.args, client_request_id: randomUUID() })'],
  ['journal', 'src/media.mjs', "quote.state = 'submitting';", "quote.state = 'quoted';"],
  ['never-submitted-recovery', 'src/media.mjs', "'submission_not_started'", "'submission_already_started'"],
  ['refused-recovery', 'src/media.mjs', "quote.state !== 'refused'", 'true'],
  ['login-binding', 'src/media.mjs', 'quote.binding === (await this.mcp.credentials.access()).binding', 'true'],
  ['expiry', 'src/media.mjs', 'this.now() <= quote.expires_at', 'true'],
  ['input-binding', 'src/media.mjs', 'quote.args_hash === hash(quote.args)', 'true'],
  ['callback-state', 'src/auth.mjs', "url.searchParams.get('state') !== state", 'false'],
  ['logout-retention', 'src/auth.mjs', "requireThat(response.ok, 'logout_failed'", "requireThat(true, 'logout_failed'"],
  ['download-ua', 'src/network.mjs', "headers: { 'User-Agent': USER_AGENT }, signal }", "headers: {}, signal }"],
  ['download-private-address', 'src/network.mjs', 'addresses.every(a => !privateIP(a.address))', 'true'],
  ['download-dns-pinning', 'src/network.mjs', '? callback(null, [address])', "? callback(null, [{ address: '127.0.0.1', family: 4 }])"],
  ['download-content-type', 'src/media-content.mjs', 'generic || type.startsWith(`${kind}/`)', 'true'],
  ['download-media-header', 'src/media-content.mjs', 'kinds.includes(kind)', 'true'],
  ['quote-error-budget', 'src/media.mjs', '...(cap !== undefined ? { max_cost_usd: cap } : {})', '...{}'],
  ['doctor-prerequisites', 'src/doctor.mjs', 'runtime && storage && login', 'true'],
  ['skill-modified', 'src/skills.mjs', '!modified || replaceModified', 'true'],
  ['model-verification', 'src/doctor.mjs', 'result.models.length > 0', 'true'],
  ['setup-network-login', 'src/setup.mjs', '!LOGIN_ERRORS.has(error.code)', 'false'],
  ['callback-reuse', 'src/auth.mjs', 'if (settled)', 'if (false)'],
  ['doctor-exit-code', 'src/cli.mjs', "if (!view.ok) process.exitCode = view.error?.code === 'interrupted' ? 130 : 1;", 'if (!view.ok) process.exitCode = 0;'],
  ['status-filter-validation', 'src/cli.mjs', 'TASK_STATUS_FILTERS.includes(options.status)', 'true'],
  ['status-pending-alias', 'src/cli.mjs', "Object.freeze(['processing', 'completed', 'failed', 'cancelled'])", "Object.freeze(['processing', 'completed', 'failed', 'cancelled', 'pending'])"],
  ['status-error-values', 'src/cli.mjs', 'allowed_values: TASK_STATUS_FILTERS', 'allowed_values: []'],
  ['status-filter-forwarding', 'src/cli.mjs', 'status: options.status, since:', 'status: undefined, since:'],
  ['task-specific-help', 'src/cli.mjs', '? TASKS_LIST_HELP : reference?.help || HELP', '? HELP : reference?.help || HELP'],
  ['capability-before-call', 'src/mcp.mjs', 'if (requireCapability)', 'if (false)'],
  ['page-forwarding', 'src/cli.mjs', "key === 'page' ? Number(options[key]) : options[key]", "key === 'page' ? 1 : options[key]"],
  ['delivery-partial-status', 'src/files.mjs', 'ok: complete, task_id:', 'ok: true, task_id:'],
  ['delivery-digest-check', 'src/files.mjs', "digest.digest('hex') === saved.sha256", 'true'],
  ['delivery-duplicate-names', 'src/files.mjs', 'new Set(names.map(name => name.toLowerCase())).size === names.length', 'true'],
  ['delivery-existing-receipt', 'src/files.mjs', "requireThat(!receipt, 'delivery_exists'", "requireThat(true, 'delivery_exists'"],
  ['delivery-commit-journal', 'src/files.mjs', 'await beforeCommit?.(receipt);', 'await Promise.resolve();'],
  ['lock-crash-ticket', 'src/state.mjs', 'match[1] === hostID && dead(Number(match[2]))', 'false'],
  ['lock-error-propagation', 'src/state.mjs', "entered || error.code !== 'ENOENT'", "error.code !== 'ENOENT'"],
];

let killed = 0;
const selected = process.env.EVOLINK_MUTATION_ONLY ? mutants.filter(item => item[0] === process.env.EVOLINK_MUTATION_ONLY) : mutants;
if (!selected.length) throw new Error('Unknown mutation name');
for (const [name, file, before, after] of selected) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-mutant-'));
  try {
    for (const dir of ['src', 'test', 'bin', 'skills']) await fs.cp(path.join(packageRoot, dir), path.join(home, dir), { recursive: true });
    await fs.copyFile(path.join(packageRoot, 'package.json'), path.join(home, 'package.json'));
    await fs.symlink(path.join(packageRoot, 'node_modules'), path.join(home, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const target = path.join(home, file); const source = await fs.readFile(target, 'utf8');
    if (!source.includes(before)) throw new Error(`Missing mutation target: ${name}`);
    await fs.writeFile(target, source.replace(before, after));
    const files = name.startsWith('delivery-') || ['page-forwarding', 'capability-before-call'].includes(name) ? ['capabilities.test.mjs']
      : name === 'callback-state' ? ['auth.test.mjs']
      : name.startsWith('status-') || name === 'task-specific-help' ? ['task-help.test.mjs']
      : name.startsWith('lock-') ? ['state.test.mjs']
      : ['request-id', 'journal', 'download-ua'].includes(name) ? ['e2e.test.mjs']
      : ['media.test.mjs', 'auth.test.mjs', 'acceptance.test.mjs', 'readiness.test.mjs', 'setup.test.mjs', 'skills.test.mjs'];
    const tests = files.map(n => path.join(home, 'test', n));
    const selection = name === 'callback-state' ? ['--test-name-pattern=callback rejects wrong state'] : [];
    const run = spawnSync(process.execPath, ['--test', ...selection, ...tests], { cwd: home, encoding: 'utf8', timeout: 60_000 });
    const output = `${run.stdout || ''}\n${run.stderr || ''}`;
    if (run.status > 0 && !run.error && /not ok \d+|✖ /.test(output) && !output.includes('SyntaxError:')) { killed++; console.log(`DETECTED ${name}`); }
    else { console.error(`${run.error || run.signal ? 'INCONCLUSIVE' : 'SURVIVED'} ${name} (status=${run.status}, signal=${run.signal}, error=${run.error?.code || 'none'})\n${output.slice(-2000)}`); process.exitCode = 1; }
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}
console.log(`${killed}/${selected.length} mutations detected`);
