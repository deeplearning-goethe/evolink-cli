#!/usr/bin/env node
if (Number(process.versions.node.split('.')[0]) < 22) {
  const error = { schema_version: 1, ok: false, error: { code: 'unsupported_runtime', message: 'EvoLink CLI requires Node.js 22 or newer.' } };
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(error) + '\n');
  else process.stderr.write(error.error.message + '\n');
  process.exitCode = 1;
} else {
  const { main } = await import('../src/cli.mjs');
  await main();
  // A registry request given up at its deadline can keep a socket open for minutes (for example through a
  // proxy that never answers). The command is complete: write out its output, then exit instead of waiting.
  const { abandonedUpdateChecks } = await import('../src/update.mjs');
  if (abandonedUpdateChecks()) {
    for (const stream of [process.stdout, process.stderr]) await new Promise(resolve => stream.write('', resolve));
    process.exit();
  }
}
