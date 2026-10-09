import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const destination = fileURLToPath(new URL('../src/platform', import.meta.url));
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/sync-platform-client.mjs /path/to/platform-client/dist');
const manifest = JSON.parse(await fs.readFile(path.join(source, 'source.json'), 'utf8'));
if (manifest.repository !== 'Evolink-AI/evolink-mcp' || manifest.schema_version !== 1) throw new Error('Unexpected platform source manifest');
const license = await fs.readFile(path.join(source, 'LICENSE'), 'utf8');
const notice = await fs.readFile(path.join(source, 'NOTICE'), 'utf8');
await fs.rm(destination, { recursive: true, force: true });
await fs.mkdir(destination, { recursive: true });
await fs.writeFile(path.join(destination, 'LICENSE'), license);
await fs.writeFile(path.join(destination, 'NOTICE'), notice);
const artifacts = {};
async function copy(directory) {
  for (const entry of (await fs.readdir(path.join(source, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await copy(name);
    else if (name.endsWith('.js')) {
      const data = `// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0\n// Generated from ${manifest.repository}; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.\n`
        + (await fs.readFile(path.join(source, name), 'utf8')).replace(/^\/\/# sourceMappingURL=.*\n?/mg, '');
      await fs.mkdir(path.dirname(path.join(destination, name)), { recursive: true });
      await fs.writeFile(path.join(destination, name), data);
      artifacts[name] = createHash('sha256').update(data).digest('hex');
    }
  }
}
await copy('core/src');
await fs.writeFile(path.join(destination, 'source.json'), JSON.stringify({ ...manifest, artifacts }, null, 2) + '\n');
console.log(`Synchronized ${Object.keys(artifacts).length} shared modules (${manifest.source_sha256}).`);
