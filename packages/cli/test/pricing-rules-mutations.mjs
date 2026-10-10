import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const mutants = [
  ['anonymous-credential-access', 'src/api.mjs', "if (name === 'get_pricing_rules')", 'if (false)'],
  ['dispatch-wrong-operation', 'src/cli.mjs', "if (action === 'pricing') return client.call('get_pricing_rules'", "if (action === 'pricing') return client.call('estimate_cost'"],
  ['rules-are-not-quote', 'src/platform/core/src/tools/get-pricing-rules.js', 'quote_established: false', 'quote_established: true'],
  ['no-final-cap', 'src/platform/core/src/tools/get-pricing-rules.js', 'final_budget_enforced: false', 'final_budget_enforced: true'],
];
let detected = 0;
for (const [name, file, before, after] of mutants) {
  const target = root + file, source = await readFile(target, 'utf8');
  if (!source.includes(before)) throw new Error(`Missing mutation target: ${name}`);
  try {
    await writeFile(target, source.replace(before, after));
    const run = spawnSync(process.execPath, ['--test', 'test/pricing-rules.test.mjs'], { cwd: root, encoding: 'utf8', timeout: 45000 });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    if (run.status > 0 && !run.error && /not ok \d+/.test(output) && !/SyntaxError:|ERR_MODULE_NOT_FOUND/.test(output)) {
      detected++; console.log(`DETECTED ${name}`);
    } else { console.error(`SURVIVED OR INCONCLUSIVE ${name}\n${output.slice(-2000)}`); process.exitCode = 1; }
  } finally { await writeFile(target, source); }
}
console.log(`${detected}/${mutants.length} CLI pricing-rule mutations detected`);
