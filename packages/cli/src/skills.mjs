import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { CliError, requireThat } from './errors.mjs';
import { State } from './state.mjs';
import { CLI_VERSION } from './version.mjs';

const AGENT_DIRS = {
  codex: '.agents', 'claude-code': '.claude', cursor: '.agents',
  gemini: '.agents', opencode: '.agents', copilot: '.agents',
  openclaw: '.openclaw', hermes: '.hermes',
};
const MANIFEST = '.evolink-cli.json';
// Only exact published bundles migrate without explicit replacement approval.
const LEGACY_HASHES = new Set(['bed3f5dcba1d5d07e98f21f6ab45180eaa5983b610851d2aed25274114b64982', '680faa81bab65b6324933fa24bed34f2680c88df0bbf843423b53e3d3c9b6de5']);
const digest = content => createHash('sha256').update(content).digest('hex');
const owned = content => content?.startsWith('---\nname: evolink-cli\n') && content.includes('<!-- evolink-media-cli-owned -->');
const source = fileURLToPath(new URL('../skills/evolink-cli/', import.meta.url));

export function validateAgent(agent = 'all') {
  requireThat(agent === 'all' || Object.hasOwn(AGENT_DIRS, agent), 'invalid_agent',
    'Choose all, codex, claude-code, cursor, gemini, opencode, copilot, openclaw or hermes.');
  return agent;
}
function targets(home, agent) {
  validateAgent(agent);
  const dirs = agent === 'all' ? [...new Set(Object.values(AGENT_DIRS))] : [AGENT_DIRS[agent]];
  return dirs.map(dir => path.join(home, dir, 'skills', 'evolink-cli'));
}
async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
}
async function bundle() {
  const files = {};
  async function visit(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      requireThat(!entry.isSymbolicLink(), 'invalid_skill_bundle', 'The bundled skill cannot contain symbolic links.');
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), `${relative}/`);
      else if (entry.isFile()) files[relative] = await fs.readFile(path.join(dir, entry.name));
    }
  }
  await visit(source);
  return files;
}
async function noSymlinks(home, dir, files) {
  for (const file of ['', MANIFEST, ...Object.keys(files)]) {
    const relative = path.relative(home, path.join(dir, file));
    let current = home;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try {
        requireThat(!(await fs.lstat(current)).isSymbolicLink(), 'skill_conflict',
          'A skill destination is a symbolic link. Choose a regular skill directory before installing.', { path: current });
      } catch (e) { if (e.code !== 'ENOENT') throw e; break; }
    }
  }
}
async function inspect(home, dir, files) {
  await noSymlinks(home, dir, files);
  const previous = await readOptional(path.join(dir, 'SKILL.md'));
  const raw = await readOptional(path.join(dir, MANIFEST));
  let manifest;
  try { manifest = raw ? JSON.parse(raw) : undefined; } catch { /* Treat damaged metadata as a conflict. */ }
  const valid = manifest?.schema_version === 1 && typeof manifest.cli_version === 'string' &&
    manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files) &&
    Object.entries(manifest.files).every(([name, sha]) => /^[a-zA-Z0-9_.\/-]+$/.test(name) &&
      !name.startsWith('/') && name.split('/').every(p => p && p !== '.' && p !== '..') && /^[a-f0-9]{64}$/.test(sha));
  const changes = [];
  const liveHashes = {};
  let matches = true;
  for (const [relative, content] of Object.entries(files)) {
    const live = await readOptional(path.join(dir, relative));
    liveHashes[relative] = live === undefined ? null : digest(live);
    if (live === undefined || digest(live) !== digest(content)) matches = false;
    // Existing untracked resources are user content and must not be overwritten.
    if (live !== undefined && valid && (!manifest.files[relative] || digest(live) !== manifest.files[relative])) changes.push(relative);
    if (live !== undefined && !raw && relative !== 'SKILL.md' && digest(live) !== digest(content)) changes.push(relative);
  }
  if (valid) {
    await noSymlinks(home, dir, manifest.files);
    for (const [relative, sha] of Object.entries(manifest.files)) {
      const live = await readOptional(path.join(dir, relative));
      liveHashes[relative] = live === undefined ? null : digest(live);
      if (live === undefined || digest(live) !== sha) changes.push(relative);
    }
  }
  if (previous && !valid && !matches && !LEGACY_HASHES.has(digest(previous))) changes.push('SKILL.md');
  let status;
  if (previous === undefined && raw === undefined && !changes.length) status = 'missing';
  else if (!owned(previous) || raw && !valid) status = 'conflict';
  else if (changes.length || !valid && !matches && !LEGACY_HASHES.has(digest(previous))) status = 'modified';
  else if (!valid) status = LEGACY_HASHES.has(digest(previous)) ? 'legacy' : 'unmanaged';
  else status = matches && manifest.cli_version === CLI_VERSION ? 'current' : 'outdated';
  return { path: path.join(dir, 'SKILL.md'), directory: dir, status,
    installed_cli_version: valid ? manifest.cli_version : null, changed_files: [...new Set(changes)],
    _fingerprint: digest(JSON.stringify({ previous, raw, liveHashes })) };
}
function lock(home, fn) {
  // Skills are shared across state directories and agents: use one per-home lock.
  return new State(path.join(home, '.evolink-media')).lock('skills-install', fn);
}
function publicInstallation({ _fingerprint, ...view }) { return view; }
export async function skillStatus({ home = os.homedir(), agent = 'all' } = {}) {
  const dirs = targets(home, agent);
  return lock(home, async () => {
    const files = await bundle();
    const installations = await Promise.all(dirs.map(dir => inspect(home, dir, files)));
    return { skill: 'evolink-cli', cli_version: CLI_VERSION, agent, current: installations.every(f => f.status === 'current'),
      installations: installations.map(publicInstallation), assistant_discovery: 'not_checked',
      next_step: 'Run evolink skills install for missing or outdated files. Ask your assistant to confirm discovery; only reopen the conversation if needed.' };
  });
}
export async function installSkill({ home = os.homedir(), agent = 'all', replaceModified = false } = {}) {
  const dirs = targets(home, agent);
  return lock(home, async () => {
    const files = await bundle();
    const plans = await Promise.all(dirs.map(dir => inspect(home, dir, files)));
    // Validate every destination before writing to any agent's skill directory.
    const conflict = plans.find(plan => plan.status === 'conflict');
    requireThat(!conflict, 'skill_conflict', 'A different skill or invalid installation metadata already exists. Resolve it before installing.', { path: conflict?.path });
    const modified = plans.find(plan => plan.status === 'modified');
    requireThat(!modified || replaceModified, 'skill_modified',
      'The installed skill has local changes. Keep them, or explicitly use --replace-modified to back up and replace it.', { path: modified?.path, changed_files: modified?.changed_files });
    const swaps = [];
    const staged = [];
    try {
      for (const plan of plans.filter(p => p.status !== 'current')) {
        const temp = path.join(path.dirname(plan.directory), `.evolink-cli-staging-${randomUUID()}`);
        const backup = path.join(home, '.evolink-media', 'skill-backups', randomUUID());
        await fs.mkdir(path.dirname(plan.directory), { recursive: true, mode: 0o700 });
        await fs.mkdir(temp, { mode: 0o700 });
        staged.push(temp);
        let existed = false;
        try { await fs.cp(plan.directory, temp, { recursive: true, dereference: false }); existed = true; }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        for (const [relative, content] of Object.entries(files)) {
          const file = path.join(temp, relative);
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await fs.writeFile(file, content, { mode: 0o600 });
        }
        await fs.writeFile(path.join(temp, MANIFEST), JSON.stringify({ schema_version: 1, cli_version: CLI_VERSION,
          files: Object.fromEntries(Object.entries(files).map(([relative, content]) => [relative, digest(content)])) }, null, 2) + '\n', { mode: 0o600 });
        const now = await inspect(home, plan.directory, files);
        requireThat(now._fingerprint === plan._fingerprint, 'skill_changed', 'The skill changed during installation. Retry after the other editor finishes.', { path: plan.path });
        const swap = { plan, temp, backup: existed ? backup : null, backedUp: false, installed: false };
        swaps.push(swap);
        if (existed) {
          await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
          await fs.rename(plan.directory, backup);
          swap.backedUp = true;
        }
        await fs.rename(temp, plan.directory);
        swap.installed = true;
      }
    } catch (e) {
      for (const swap of swaps.reverse()) {
        if (swap.installed) await fs.rename(swap.plan.directory, swap.temp);
        if (swap.backedUp) await fs.rename(swap.backup, swap.plan.directory);
      }
      throw e;
    } finally { for (const temp of staged) await fs.rm(temp, { recursive: true, force: true }); }
    const installations = plans.map(plan => ({ path: plan.path, status: 'current', updated: plan.status !== 'current',
      previous_status: plan.status, backup: swaps.find(s => s.plan === plan)?.backup || null }));
    return { skill: 'evolink-cli', cli_version: CLI_VERSION, path: installations[0].path,
      updated: installations.some(f => f.updated), installations, assistant_discovery: 'not_checked',
      next_step: 'Ask your assistant to confirm it discovers evolink-cli. If it does not refresh skills, open a new conversation.' };
  });
}
