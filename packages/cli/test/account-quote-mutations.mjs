import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const mutations = [
  ['server-expiry', 'src/media.mjs', 'serverExpiry ?? Infinity', 'Infinity'],
  ['account-save', 'src/media.mjs', 'backend_estimate_id: quote.account_quote.quote.estimate_id', "backend_estimate_id: 'wrong'"],
  ['account-version-fingerprint', 'src/media.mjs', 'account: quote.account_quote &&', 'account: false &&'],
  ['public-reference-no-approval', 'src/media.mjs', "quote.pricing_source === 'public_reference'", 'false'],
  ['recovery-no-new-quote', 'src/media.mjs', 'resume && account_quote ?', 'false ?'],
  ['refresh-unknown-refusal', 'src/media.mjs', "quote.state === 'quoted' && !quote.task_id", 'true'],
  ['refresh-budget-retained', 'src/media.mjs', 'this.estimate(args)', 'this.estimate({ ...args, max_cost_usd: undefined })'],
  ['refresh-account-before-submit', 'src/media.mjs', 'quote.backend_estimate_id = fresh.account_quote.quote.estimate_id', 'quote.backend_estimate_id = quote.backend_estimate_id'],
  ['quote-options-not-generated', 'src/media.mjs', '...generationArgs, client_request_id:', '...quote.args, client_request_id:'],
];
let detected = 0;
for (const [name, file, before, after] of mutations) {
  const source = await readFile(file, 'utf8');
  if (!source.includes(before)) throw new Error(`Missing mutation target: ${name}`);
  try {
    await writeFile(file, source.replace(before, after));
    const run = spawnSync(process.execPath, ['--test', 'test/account-quote.test.mjs'], { encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    if (run.status > 0 && !run.error && /not ok \d+/.test(output) && !/SyntaxError:|ERR_MODULE_NOT_FOUND/.test(output)) {
      detected++; console.log(`DETECTED ${name}`);
    } else { console.error(`SURVIVED OR INCONCLUSIVE ${name}\n${output.slice(-2000)}`); process.exitCode = 1; }
  } finally { await writeFile(file, source); }
}
console.log(`${detected}/${mutations.length} account quote mutations detected`);
