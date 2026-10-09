import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installSkill, skillStatus } from '../src/skills.mjs';

async function homeFor(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-skill-state-'));
  t.after(() => fs.rm(home, { recursive: true, force: true })); return home;
}

test('skill resources install once, concurrent calls reuse identical content, and all agents report version status', async t => {
  const home = await homeFor(t);
  const runs = await Promise.all(Array.from({ length: 4 }, () => installSkill({ home })));
  assert.equal(runs.filter(r => r.updated).length, 1);
  const first = runs[0], stat = await fs.stat(first.path);
  assert.equal((await installSkill({ home })).updated, false);
  assert.equal((await fs.stat(first.path)).mtimeMs, stat.mtimeMs);
  for (const agent of ['codex', 'claude-code', 'cursor', 'gemini', 'opencode', 'copilot', 'openclaw', 'hermes']) {
    const result = await skillStatus({ home, agent });
    assert.equal(result.current, true); assert.equal(result.installations.length, 1);
    const ref = path.join(result.installations[0].directory, 'references/media-workflows.md');
    assert.ok((await fs.readFile(ref, 'utf8')).includes('reference'));
  }
});

test('modified skills and references are protected; explicit replacement preserves exact backups outside discovery', async t => {
  const home = await homeFor(t), installed = await installSkill({ home, agent: 'codex' });
  const original = await fs.readFile(installed.path, 'utf8');
  await fs.writeFile(installed.path, original + '\nPersonal instruction.');
  const reference = path.join(path.dirname(installed.path), 'references/media-workflows.md');
  await fs.appendFile(reference, '\nPersonal workflow.');
  assert.equal((await skillStatus({ home, agent: 'codex' })).installations[0].status, 'modified');
  await assert.rejects(installSkill({ home, agent: 'codex' }), { code: 'skill_modified' });
  const result = await installSkill({ home, agent: 'codex', replaceModified: true });
  const backup = result.installations[0].backup;
  assert.ok(backup.startsWith(path.join(home, '.evolink-media', 'skill-backups')));
  assert.equal(await fs.readFile(path.join(backup, 'SKILL.md'), 'utf8'), original + '\nPersonal instruction.');
  assert.ok((await fs.readFile(path.join(backup, 'references/media-workflows.md'), 'utf8')).endsWith('Personal workflow.'));
  assert.equal((await skillStatus({ home, agent: 'codex' })).current, true);
});

test('known published skill migrates safely, version drift is visible, and untracked user assets survive updates', async t => {
  const home = await homeFor(t), dir = path.join(home, '.agents/skills/evolink-cli');
  await fs.mkdir(dir, { recursive: true });
  const legacy = await fs.readFile(new URL('./fixtures/skill-v050.md', import.meta.url));
  await fs.writeFile(path.join(dir, 'SKILL.md'), legacy);
  assert.equal((await skillStatus({ home, agent: 'codex' })).installations[0].status, 'legacy');
  const installed = await installSkill({ home, agent: 'codex' });
  assert.deepEqual(await fs.readFile(path.join(installed.installations[0].backup, 'SKILL.md')), legacy);
  const file = path.join(dir, '.evolink-cli.json'), metadata = JSON.parse(await fs.readFile(file));
  metadata.cli_version = '0.4.0'; await fs.writeFile(file, JSON.stringify(metadata));
  await fs.writeFile(path.join(dir, 'personal-note.txt'), 'keep this');
  assert.equal((await skillStatus({ home, agent: 'codex' })).installations[0].status, 'outdated');
  await installSkill({ home, agent: 'codex' });
  assert.equal(await fs.readFile(path.join(dir, 'personal-note.txt'), 'utf8'), 'keep this');
});

test('published 0.5.1 skills migrate without asking to replace local modifications', async t => {
  const home = await homeFor(t), dir = path.join(home, '.agents/skills/evolink-cli');
  await fs.mkdir(dir, { recursive: true });
  const legacy = await fs.readFile(new URL('./fixtures/skill-v051.md', import.meta.url));
  await fs.writeFile(path.join(dir, 'SKILL.md'), legacy);
  assert.equal((await skillStatus({ home, agent: 'codex' })).installations[0].status, 'legacy');
  const installed = await installSkill({ home, agent: 'codex' });
  assert.deepEqual(await fs.readFile(path.join(installed.installations[0].backup, 'SKILL.md')), legacy);
  assert.equal((await skillStatus({ home, agent: 'codex' })).current, true);
});

test('deleted managed resources, damaged manifests, unowned skills and symlinks cannot silently overwrite user files', async t => {
  const home = await homeFor(t), installed = await installSkill({ home, agent: 'codex' });
  const dir = path.dirname(installed.path), reference = path.join(dir, 'references/media-workflows.md');
  await fs.unlink(reference);
  await assert.rejects(installSkill({ home, agent: 'codex' }), { code: 'skill_modified' });
  await installSkill({ home, agent: 'codex', replaceModified: true });
  await fs.writeFile(path.join(dir, '.evolink-cli.json'), '{broken');
  await assert.rejects(installSkill({ home, agent: 'codex', replaceModified: true }), { code: 'skill_conflict' });
  await fs.unlink(path.join(dir, '.evolink-cli.json'));
  await fs.writeFile(installed.path, 'a different skill');
  await assert.rejects(installSkill({ home, agent: 'codex', replaceModified: true }), { code: 'skill_conflict' });
  if (process.platform !== 'win32') {
    const outside = path.join(home, 'outside.md'); await fs.writeFile(outside, 'keep outside');
    await fs.unlink(installed.path); await fs.symlink(outside, installed.path);
    await assert.rejects(installSkill({ home, agent: 'codex', replaceModified: true }), { code: 'skill_conflict' });
    assert.equal(await fs.readFile(outside, 'utf8'), 'keep outside');
  }
});

test('a later filesystem failure rolls back earlier agent updates', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('Needs Unix permissions and a non-root test user.');
  const home = await homeFor(t), installed = await installSkill({ home });
  for (const entry of installed.installations) {
    const file = path.join(path.dirname(entry.path), '.evolink-cli.json');
    const metadata = JSON.parse(await fs.readFile(file)); metadata.cli_version = '0.4.0';
    await fs.writeFile(file, JSON.stringify(metadata));
  }
  const blockedParent = path.join(home, '.claude/skills');
  await fs.chmod(blockedParent, 0o500);
  try {
    await assert.rejects(installSkill({ home }), { code: 'EACCES' });
    const status = await skillStatus({ home });
    assert.ok(status.installations.every(i => i.status === 'outdated' && i.installed_cli_version === '0.4.0'));
    assert.ok(!(await fs.readdir(path.join(home, '.agents/skills'))).some(n => n.includes('staging')));
  } finally { await fs.chmod(blockedParent, 0o700); }
});
