import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { CliError, requireThat } from './errors.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export const validID = id => typeof id === 'string' && /^[a-zA-Z0-9._-]{1,96}$/.test(id) && !id.includes('..');

export class State {
  // Retain the original storage location so renaming the command preserves sessions and request IDs.
  constructor(home = process.env.EVOLINK_CLI_HOME || process.env.EVOLINK_MEDIA_HOME || path.join(os.homedir(), '.evolink-media')) {
    this.home = path.resolve(home);
  }
  file(group, id) {
    requireThat(validID(group) && validID(id), 'invalid_id', 'Invalid state identifier.');
    return path.join(this.home, group, `${id}.json`);
  }
  async read(group, id) {
    try { return JSON.parse(await fs.readFile(this.file(group, id), 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') return undefined;
      throw new CliError('state_unreadable', 'Local state is unreadable. Keep the saved request IDs when reporting this problem.');
    }
  }
  async write(group, id, data) {
    const target = this.file(group, id);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(data, null, 2)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, target);
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  async remove(group, id) { await fs.unlink(this.file(group, id)).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  async lock(id, fn) {
    requireThat(validID(id), 'invalid_id', 'Invalid lock identifier.');
    const dir = path.join(this.home, 'locks', id), recovery = `${dir}.recovery`;
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const owner = await claim(dir);
      if (owner) {
        try { return await fn(); }
        finally { await release(dir, owner); }
      }
      // Each recovery guard has an owner and can itself be recovered after a crash.
      // Remove only the observed owner's unique file: a replacement guard survives.
      const guard = await claim(recovery);
      if (guard) {
        try { await recover(dir); }
        finally { await release(recovery, guard); }
      } else await recover(recovery);
      if (Date.now() > deadline) throw new CliError('operation_busy', 'Another command is using this state. Wait for it to finish.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

async function claim(dir) {
  try { await fs.lstat(dir); return undefined; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = `${randomUUID()}.owner.json`, temp = `${dir}.claim-${randomUUID()}`;
  await fs.mkdir(temp, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(temp, token), JSON.stringify({ pid: process.pid, hostname: os.hostname() }), { mode: 0o600 });
    // Publish a nonempty directory atomically, so a crash cannot leave an owner gap.
    await fs.rename(temp, dir);
    return token;
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    try { await fs.lstat(dir); } catch { throw error; }
    return undefined;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

async function release(dir, token) {
  try { await fs.unlink(path.join(dir, token)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await fs.rmdir(dir); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}

async function recover(dir) {
  try {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const names = await fs.readdir(dir);
    if (!names.length) {
      // A previous CLI may have left an empty recovery guard; allow its creation window.
      if (Date.now() - stat.mtimeMs > 30_000) await fs.rmdir(dir).catch(error => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      });
      return;
    }
    if (names.length !== 1 || !(names[0] === 'owner.json' || /^[a-f0-9-]{36}\.owner\.json$/.test(names[0]))) return;
    const owner = JSON.parse(await fs.readFile(path.join(dir, names[0]), 'utf8'));
    if (owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return;
    try { process.kill(owner.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') await release(dir, names[0]); }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
  }
}
