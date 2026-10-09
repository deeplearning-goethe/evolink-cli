import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { requireThat } from './errors.mjs';

const AGENT_DIRS = {
  codex: '.agents', 'claude-code': '.claude', cursor: '.agents',
  gemini: '.agents', opencode: '.agents', copilot: '.agents',
  openclaw: '.openclaw', hermes: '.hermes',
};

export async function installSkill({ home = os.homedir(), agent = 'all' } = {}) {
  requireThat(agent === 'all' || Object.hasOwn(AGENT_DIRS, agent), 'invalid_agent', 'Choose all, codex, claude-code, cursor, gemini, opencode, copilot, openclaw or hermes.');
  const source = fileURLToPath(new URL('../skills/evolink-cli/SKILL.md', import.meta.url));
  const content = await fs.readFile(source, 'utf8');
  const dirs = agent === 'all' ? [...new Set(Object.values(AGENT_DIRS))] : [AGENT_DIRS[agent]];
  const files = [];
  // Check all destinations before updating any of them.
  for (const dir of dirs) {
    const target = path.join(home, dir, 'skills', 'evolink-cli', 'SKILL.md');
    let previous;
    try { previous = await fs.readFile(target, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    requireThat(!previous || previous.startsWith('---\nname: evolink-cli\n') && previous.includes('<!-- evolink-media-cli-owned -->'),
      'skill_conflict', 'A different evolink-cli skill already exists. Choose how to replace it before installing.');
    files.push({ path: target, updated: !!previous });
  }
  for (const file of files) {
    await fs.mkdir(path.dirname(file.path), { recursive: true, mode: 0o700 });
    const temp = `${file.path}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, content, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file.path); }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
  return { skill: 'evolink-cli', path: files[0].path, updated: files.some(f => f.updated), installations: files,
    next_step: 'Verify that your assistant discovers evolink-cli. If it does not refresh skills, open a new conversation.' };
}
