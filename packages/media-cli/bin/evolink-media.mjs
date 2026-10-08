#!/usr/bin/env node
if (Number(process.versions.node.split('.')[0]) < 22) {
  const error = { schema_version: 1, ok: false, error: { code: 'unsupported_runtime', message: 'EvoLink Media CLI requires Node.js 22 or newer.' } };
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(error) + '\n');
  else process.stderr.write(error.error.message + '\n');
  process.exitCode = 1;
} else {
  const { main } = await import('../src/cli.mjs');
  await main();
}
