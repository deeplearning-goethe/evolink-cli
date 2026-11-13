// Builds the one-line installers from bin/evolink.mjs:
//   dist/setup.sh   (macOS / Linux, CLI embedded as a quoted heredoc)
//   dist/setup.ps1  (Windows, ASCII only, CLI and Chinese strings embedded as base64)
//   dist/evolink.mjs, dist/SHA256SUMS
// Usage: node scripts/build.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, 'bin', 'evolink.mjs'), 'utf8');
const version = /export const VERSION = '([^']+)'/.exec(src)?.[1];
if (!version) throw new Error('VERSION not found in bin/evolink.mjs');
const body = src.endsWith('\n') ? src : `${src}\n`;
const sha = crypto.createHash('sha256').update(body).digest('hex');

if (body.split('\n').includes('__EVOLINK_CLI_EOF__')) throw new Error('CLI source contains the heredoc terminator');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

let sh = fs.readFileSync(path.join(root, 'scripts', 'templates', 'setup.sh'), 'utf8');
// The heredoc writes the body without its final newline plus one newline, i.e. exactly `body`.
// The source goes in through a function: as a plain replacement string, a "$`", "$&" or "$'" in the source would be
// taken as a replacement pattern and the embedded copy would no longer match its checksum.
sh = sh.replaceAll('__EVOLINK_VERSION__', version).replace('__EVOLINK_CLI_SHA256__', sha).replace('__EVOLINK_CLI_SOURCE__\n', () => body);
const inSh = /<<'__EVOLINK_CLI_EOF__'\n([\s\S]*?)__EVOLINK_CLI_EOF__\n/.exec(sh)?.[1];
if (inSh !== body) throw new Error('setup.sh: the embedded CLI is not bin/evolink.mjs byte for byte');

let ps = fs.readFileSync(path.join(root, 'scripts', 'templates', 'setup.ps1'), 'utf8');
ps = ps
  .replaceAll('__EVOLINK_VERSION__', version)
  .replace('__EVOLINK_CLI_SHA256__', sha)
  .replace('__EVOLINK_CLI_B64__', () => b64(body).match(/.{1,120}/g).join('\n'))
  .replace(/\{\{zh:([^}]*)\}\}/g, (_, text) => b64(text));
if (/[^\x00-\x7f]/.test(ps)) throw new Error('setup.ps1 must be ASCII only');
const inPs = /\$cliB64 = @'\n([\s\S]*?)\n'@/.exec(ps)?.[1];
if (!inPs || Buffer.from(inPs.replace(/\s/g, ''), 'base64').toString('utf8') !== body) throw new Error('setup.ps1: the embedded CLI is not bin/evolink.mjs byte for byte');
ps = ps.replace(/\r?\n/g, '\r\n');

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'setup.sh'), sh, { mode: 0o755 });
fs.writeFileSync(path.join(dist, 'setup.ps1'), ps);
fs.writeFileSync(path.join(dist, 'evolink.mjs'), body, { mode: 0o755 });

const syntax = spawnSync('bash', ['-n', path.join(dist, 'setup.sh')], { encoding: 'utf8' });
if (syntax.status !== 0) throw new Error(`bash -n failed:\n${syntax.stderr}`);

const sums = ['setup.sh', 'setup.ps1', 'evolink.mjs']
  .map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, f))).digest('hex')}  ${f}`)
  .join('\n');
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), `${sums}\n`);
console.log(`built v${version}\n${sums}`);
