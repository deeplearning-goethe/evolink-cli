import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const file = 'src/media.mjs';
const mutations = [
  ['rules-save', 'pricing_quote: quote.pricing_quote', 'pricing_quote: undefined'],
  ['rules-fingerprint', 'rules: quote.pricing_quote &&', 'rules: false &&'],
  ['rules-exact-budget', '!rulesBudgetExceeded(quote.pricing_quote.total_uc, cap)', 'quote.estimate.max_usd <= cap'],
  ['recovery-original-approval', 'resume && (account_quote || pricing_quote) ?', 'false ?'],
  ['recovery-refusal-evidence', "!resume && e.details?.charged === 'no'", "e.details?.charged === 'no'"],
  ['refresh-budget-retained', 'this.estimate(args)', 'this.estimate({ ...args, max_cost_usd: undefined })'],
  ['refresh-started-refusal', "quote.state === 'quoted' && !quote.task_id", 'true'],
  ['no-automatic-saved-cap', '...(max_cost_usd !== undefined ? { max_cost_usd } : {})', '...{ max_cost_usd: max_cost_usd ?? quote.estimate.max_usd }'],
  ['no-automatic-displayed-cap', "...(max_cost_usd !== undefined ? { max_cost_usd, cap_source: 'user' } : {})", "...{ max_cost_usd: max_cost_usd ?? quote.estimate.max_usd, cap_source: 'quote' }"],
  ['explicit-budget-saved', '...(max_cost_usd !== undefined ? { max_cost_usd } : {})', '...{}'],
];
const original = await readFile(file, 'utf8'); let detected = 0;
for (const [name, before, after] of mutations) {
  if (!original.includes(before)) throw new Error(`Missing target ${name}`);
  try {
    await writeFile(file, original.replace(before, after));
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/account-quote.test.mjs'], { encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    if (r.status > 0 && !r.error && /not ok \d+/.test(output) && !/SyntaxError:|ERR_MODULE_NOT_FOUND/.test(output)) { detected++; console.log(`DETECTED ${name}`); }
    else { console.error(`SURVIVED OR INCONCLUSIVE ${name}\n${output.slice(-2500)}`); process.exitCode = 1; }
  } finally { await writeFile(file, original); }
}
console.log(`${detected}/${mutations.length} CLI pricing rules mutations detected`);
