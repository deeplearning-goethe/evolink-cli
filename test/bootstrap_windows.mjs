// Runs dist/setup.ps1 the way Windows users do (the scriptblock form with arguments, and irm … | iex) in
// Windows PowerShell 5.1 and, when installed, PowerShell 7, against the local mock gateway, each time in a
// throwaway USERPROFILE. Windows only; used by CI.
//
//   node test/bootstrap_windows.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockGateway } from './mock-server.mjs';

if (process.platform !== 'win32') {
  console.log('SKIP bootstrap_windows: Windows only');
  process.exit(0);
}

const SCRIPT = fileURLToPath(new URL('../dist/setup.ps1', import.meta.url));
const KEY = `sk-${'Wn1Ps5Bs'.repeat(6)}`;
const gw = await startMockGateway({ keys: { [KEY.slice(3)]: {} } });

// Served the way the CDN serves it (text/plain), plus a copy with one byte of the embedded CLI changed.
const original = fs.readFileSync(SCRIPT);
const text = original.toString('latin1');
const marker = "$cliB64 = @'\r\n";
const at = text.indexOf(marker) + marker.length;
if (at < marker.length) throw new Error('embedded CLI not found in dist/setup.ps1');
const tampered = Buffer.from(text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1), 'latin1');
const files = { '/cli/setup.ps1': original, '/cli/tampered.ps1': tampered };
const srv = http.createServer((req, res) => {
  const body = files[req.url];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body || '');
});
await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
const url = (name) => `http://127.0.0.1:${srv.address().port}/cli/${name}`;

const newProfile = () => fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ps-'));
const launcherOf = (p) => path.join(p, '.evolink', 'bin', 'evolink.cmd');
const settingsOf = (p) => path.join(p, '.claude', 'settings.json');

function ps(shell, profile, command) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      USERPROFILE: profile,
      APPDATA: path.join(profile, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
      EVOLINK_BASE_URL: gw.url,
      EVOLINK_API_KEY: KEY,
      EVOLINK_LANG: 'en',
      NO_COLOR: '1',
    };
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', `${command}; exit $LASTEXITCODE`], { env, cwd: profile });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 180000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const shells = ['powershell.exe'];
if (spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0) shells.push('pwsh');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `\n----- output -----\n${detail.slice(-3000)}\n------------------`}`);
};

for (const shell of shells) {
  const version = spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' }).stdout.trim();
  console.log(`\n== ${shell} ${version}`);

  // 1. The documented form with arguments.
  const p1 = newProfile();
  const setup = await ps(shell, p1, `& ([scriptblock]::Create((irm '${url('setup.ps1')}'))) --yes --no-install`);
  const settings = fs.existsSync(settingsOf(p1)) ? JSON.parse(fs.readFileSync(settingsOf(p1), 'utf8')) : null;
  check(`${shell}: setup exits 0`, setup.code === 0, setup.out);
  check(`${shell}: settings written with the key`, settings?.env?.ANTHROPIC_AUTH_TOKEN === KEY && settings?.env?.ANTHROPIC_API_KEY === '', setup.out);
  check(`${shell}: test request passed`, /Test passed/.test(setup.out), setup.out);
  check(`${shell}: launcher installed`, fs.existsSync(launcherOf(p1)));
  check(`${shell}: key never printed in full`, !setup.out.includes(KEY.slice(3)));

  // 2. The launcher it installed: doctor, then reset.
  const doctor = await ps(shell, p1, `& '${launcherOf(p1)}' doctor`);
  check(`${shell}: launcher runs doctor`, /Key valid/.test(doctor.out) && /evolink-doctor/.test(doctor.out), doctor.out);
  const reset = await ps(shell, p1, `& '${launcherOf(p1)}' reset --yes`);
  const after = fs.existsSync(settingsOf(p1)) ? JSON.parse(fs.readFileSync(settingsOf(p1), 'utf8')) : {};
  check(`${shell}: reset undoes the settings`, reset.code === 0 && !after.env?.ANTHROPIC_AUTH_TOKEN, reset.out);

  // 3. irm … | iex, no arguments: interactive, so with stdin closed it stops at the first question.
  const p3 = newProfile();
  const iex = await ps(shell, p3, `irm '${url('setup.ps1')}' | iex`);
  check(`${shell}: irm | iex starts setup and stops cleanly without input`, /EvoLink setup/.test(iex.out) && iex.code === 130 && fs.existsSync(launcherOf(p3)), `exit ${iex.code}\n${iex.out}`);

  // 4. A damaged download must not run and must not write anything.
  const p4 = newProfile();
  const bad = await ps(shell, p4, `& ([scriptblock]::Create((irm '${url('tampered.ps1')}'))) --yes --no-install`);
  check(`${shell}: tampered script is refused`, bad.code !== 0 && /checksum mismatch/.test(bad.out) && !fs.existsSync(settingsOf(p4)) && !fs.existsSync(path.join(p4, '.evolink', 'cli', 'evolink.mjs')), `exit ${bad.code}\n${bad.out}`);

  for (const p of [p1, p3, p4]) fs.rmSync(p, { recursive: true, force: true });
}

srv.close();
await gw.close();
const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
