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

const hostID = createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
function dead(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
async function ownerOf(dir) {
  try { return JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8')); }
  catch { return undefined; }
}
async function staleOwner(dir) {
  const owner = await ownerOf(dir);
  if (owner) return owner.hostname === os.hostname() && dead(owner.pid);
  try { return Date.now() - (await fs.stat(dir)).mtimeMs > 30_000; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}
async function recovering(dir) {
  let entries;
  try { entries = await fs.readdir(dir); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let active = false;
  for (const name of entries) {
    const match = /^([a-f0-9]{16})\.([1-9][0-9]*)\.([a-f0-9-]{36})$/.exec(name);
    // Old releases left an empty recovery directory, not an owned ticket.
    if (!match) continue;
    if (match[1] === hostID && dead(Number(match[2]))) {
      await fs.unlink(path.join(dir, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } else active = true;
  }
  return active;
}

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
    const dir = path.join(this.home, 'locks', id);
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 10_000;
    const recovery = `${dir}.recovery`;
    const token = randomUUID();
    const busy = () => {
      if (Date.now() > deadline) throw new CliError('operation_busy', 'Another command is using this state. Wait for it to finish.');
    };
    for (;;) {
      let acquired = false;
      try { await fs.mkdir(dir, { mode: 0o700 }); acquired = true; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // Each recovery has a unique, process-owned ticket. New owners wait for
        // all tickets before entering; a crash cannot leave an unowned guard.
        await fs.mkdir(recovery, { recursive: true, mode: 0o700 });
        const ticket = path.join(recovery, `${hostID}.${process.pid}.${randomUUID()}`);
        await fs.writeFile(ticket, '', { flag: 'wx', mode: 0o600 });
        try {
          if (await staleOwner(dir)) await fs.rm(dir, { recursive: true, force: true });
        } finally { await fs.unlink(ticket); }
      }
      if (!acquired) { busy(); await pause(); continue; }
      let entered = false;
      try {
        await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, hostname: os.hostname(), token }), { mode: 0o600 });
        while (await recovering(recovery)) { busy(); await pause(); }
        // Another recovery may have removed this not-yet-entered owner.
        if ((await ownerOf(dir))?.token !== token) { busy(); continue; }
        entered = true;
        return await fn();
      } catch (error) {
        if (entered || error.code !== 'ENOENT') throw error;
      } finally {
        if ((await ownerOf(dir))?.token === token) await fs.rm(dir, { recursive: true, force: true });
      }
      busy();
    }
  }
}
