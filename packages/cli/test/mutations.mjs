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
  ['balance', 'src/media.mjs', 'quote.enough_balance !== false && quote.enough_limit !== false && quote.enough_daily_limit !== false', 'true'],
  ['request-id', 'src/media.mjs', 'this.mcp.call(`generate_${kind}`, { ...quote.args, client_request_id: quote.client_request_id })', 'this.mcp.call(`generate_${kind}`, { ...quote.args, client_request_id: randomUUID() })'],
  ['journal', 'src/media.mjs', "quote.state = 'submitting';", "quote.state = 'quoted';"],
  ['login-binding', 'src/media.mjs', 'quote.binding === (await this.mcp.credentials.access()).binding', 'true'],
  ['expiry', 'src/media.mjs', 'this.now() <= quote.expires_at', 'true'],
  ['input-binding', 'src/media.mjs', 'quote.args_hash === hash(quote.args)', 'true'],
  ['callback-state', 'src/auth.mjs', "url.searchParams.get('state') !== state", 'false'],
  ['logout-retention', 'src/auth.mjs', "requireThat(response.ok, 'logout_failed'", "requireThat(true, 'logout_failed'"],
  ['download-ua', 'src/network.mjs', "headers: { 'User-Agent': USER_AGENT }, signal:", "headers: {}, signal:"],
  ['status-filter-validation', 'src/cli.mjs', 'TASK_STATUS_FILTERS.includes(options.status)', 'true'],
  ['status-pending-alias', 'src/cli.mjs', "Object.freeze(['processing', 'completed', 'failed', 'cancelled'])", "Object.freeze(['processing', 'completed', 'failed', 'cancelled', 'pending'])"],
  ['status-error-values', 'src/cli.mjs', 'allowed_values: TASK_STATUS_FILTERS', 'allowed_values: []'],
  ['status-filter-forwarding', 'src/cli.mjs', 'status: options.status, since:', 'status: undefined, since:'],
  ['task-specific-help', 'src/cli.mjs', '? TASKS_LIST_HELP : HELP', '? HELP : HELP'],
];

let killed = 0;
for (const [name, file, before, after] of mutants) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-mutant-'));
  try {
    for (const dir of ['src', 'test', 'bin', 'skills']) await fs.cp(path.join(packageRoot, dir), path.join(home, dir), { recursive: true });
    await fs.copyFile(path.join(packageRoot, 'package.json'), path.join(home, 'package.json'));
    await fs.symlink(path.join(packageRoot, 'node_modules'), path.join(home, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const target = path.join(home, file); const source = await fs.readFile(target, 'utf8');
    if (!source.includes(before)) throw new Error(`Missing mutation target: ${name}`);
    await fs.writeFile(target, source.replace(before, after));
    const tests = (name.startsWith('status-') || name === 'task-specific-help'
      ? ['task-help.test.mjs'] : ['media.test.mjs', 'auth.test.mjs', 'e2e.test.mjs']).map(n => path.join(home, 'test', n));
    const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd: home, encoding: 'utf8', timeout: 60_000 });
    const output = `${run.stdout || ''}\n${run.stderr || ''}`;
    if (run.status !== 0 && !run.error && !output.includes('SyntaxError:')) { killed++; console.log(`DETECTED ${name}`); }
    else { console.error(`SURVIVED ${name}\n${output.slice(-2000)}`); process.exitCode = 1; }
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}
console.log(`${killed}/${mutants.length} mutations detected`);
