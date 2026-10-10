import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const mutants = [
  ['anonymous-credential-access', 'src/api.mjs', "if (name === 'get_pricing_rules')", 'if (false)'],
  ['dispatch-wrong-operation', 'src/cli.mjs', "if (action === 'pricing') return client.call('get_pricing_rules'", "if (action === 'pricing') return client.call('estimate_cost'"],
  ['rules-are-not-quote', 'src/platform/core/src/tools/get-pricing-rules.js', 'quote_established: false', 'quote_established: true'],
  ['no-final-cap', 'src/platform/core/src/tools/get-pricing-rules.js', 'final_budget_enforced: false', 'final_budget_enforced: true'],
  ['signed-parameter-bounds', 'src/platform/core/src/services/pricing-rules-client.js', 'minimum: signedDecimal.optional()', 'minimum: decimal.optional()'],
  ['parameter-values-preserved', 'src/platform/core/src/services/pricing-rules-client.js', 'values: z.array(z.union([z.string(), z.number(), z.boolean()])).max(100).optional(),', ''],
  ['lookup-key-preserved', 'src/platform/core/src/services/pricing-rules-client.js', 'key: ExpressionSchema.optional(),', ''],
  ['lookup-table-preserved', 'src/platform/core/src/services/pricing-rules-client.js', 'values: LookupValues.optional(),', ''],
  ['published-media-depth', 'src/platform/core/src/services/pricing-rules-client.js', 'MAX_JSON_DEPTH = 64', 'MAX_JSON_DEPTH = 24'],
  ['component-label-preserved', 'src/platform/core/src/services/pricing-rules-client.js', 'label_key: z.string().min(1).max(100).optional(),', ''],
];
let detected = 0;
for (const [name, file, before, after] of mutants) {
  const target = root + file, source = await readFile(target, 'utf8');
  if (!source.includes(before)) throw new Error(`Missing mutation target: ${name}`);
  try {
    await writeFile(target, source.replace(before, after));
    // Full-response assertion diffs can exceed the subprocess default buffer.
    const run = spawnSync(process.execPath, ['--test', 'test/pricing-rules.test.mjs'],
      { cwd: root, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    if (run.status > 0 && !run.error && /not ok \d+/.test(output) && !/SyntaxError:|ERR_MODULE_NOT_FOUND/.test(output)) {
      detected++; console.log(`DETECTED ${name}`);
    } else { console.error(`SURVIVED OR INCONCLUSIVE ${name} (status=${run.status}; signal=${run.signal}; error=${run.error?.code ?? 'none'})\n${output.slice(-2000)}`); process.exitCode = 1; }
  } finally { await writeFile(target, source); }
}
console.log(`${detected}/${mutants.length} CLI pricing-rule mutations detected`);
