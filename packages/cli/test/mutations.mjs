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
  ['doctor-exit-code', 'src/cli.mjs', 'if (!view.ok) process.exitCode = 1;', 'if (!view.ok) process.exitCode = 0;'],
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
    const files = name === 'callback-state' ? ['auth.test.mjs'] : ['media.test.mjs', 'auth.test.mjs', 'e2e.test.mjs', 'acceptance.test.mjs', 'readiness.test.mjs'];
    const tests = files.map(n => path.join(home, 'test', n));
    const selection = name === 'callback-state' ? ['--test-name-pattern=callback rejects wrong state'] : [];
    const run = spawnSync(process.execPath, ['--test', ...selection, ...tests], { cwd: home, encoding: 'utf8', timeout: 60_000 });
    const output = `${run.stdout || ''}\n${run.stderr || ''}`;
    if (run.status > 0 && !run.error && /not ok \d+|✖ /.test(output) && !output.includes('SyntaxError:')) { killed++; console.log(`DETECTED ${name}`); }
    else { console.error(`${run.error || run.signal ? 'INCONCLUSIVE' : 'SURVIVED'} ${name} (status=${run.status}, signal=${run.signal}, error=${run.error?.code || 'none'})\n${output.slice(-2000)}`); process.exitCode = 1; }
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}
console.log(`${killed}/${selected.length} mutations detected`);
