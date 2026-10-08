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
  constructor(home = process.env.EVOLINK_MEDIA_HOME || path.join(os.homedir(), '.evolink-media')) {
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
    const dir = path.join(this.home, 'locks', id);
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { await fs.mkdir(dir, { mode: 0o700 }); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // Serialize stale-owner recovery so two contenders cannot remove a new lock.
        const recovery = `${dir}.recovery`;
        let recovering = false;
        try {
          await fs.mkdir(recovery, { mode: 0o700 });
          recovering = true;
          let stale = false;
          try {
            const owner = JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8'));
            if (owner.hostname === os.hostname()) {
              try { process.kill(owner.pid, 0); } catch (probe) { stale = probe.code === 'ESRCH'; }
            }
          } catch {
            try { stale = Date.now() - (await fs.stat(dir)).mtimeMs > 30_000; }
            catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
          }
          if (stale) await fs.rm(dir, { recursive: true, force: true });
        } catch (recoveryError) { if (recoveryError.code !== 'EEXIST') throw recoveryError; }
        finally { if (recovering) await fs.rmdir(recovery); }
        if (Date.now() > deadline) throw new CliError('operation_busy', 'Another command is using this state. Wait for it to finish.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    try {
      await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, hostname: os.hostname() }), { mode: 0o600 });
      return await fn();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
}
