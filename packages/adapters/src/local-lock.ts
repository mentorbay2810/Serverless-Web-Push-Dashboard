import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

interface Owner { version: 1; pid: number; nonce: string }
async function owner(path: string): Promise<Owner | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Owner;
    if (value.version !== 1 || !Number.isInteger(value.pid) || value.pid < 1 || typeof value.nonce !== 'string') throw new Error();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Cannot read a local process lock. Preserve the file and inspect it before retrying.');
  }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export async function localLockStatus(path: string) {
  const record = await owner(path);
  return !record ? 'free' : alive(record.pid) ? 'active' : 'stale';
}
export async function acquireLocalLock(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another process or a stale lock owns this local directory. Stop other backends; use npm run local:unlock only after a crash.');
    throw error;
  }
  const record: Owner = { version: 1, pid: process.pid, nonce: randomUUID() };
  try { await file.writeFile(JSON.stringify(record)); } finally { await file.close(); }
  let released = false;
  return async () => {
    if (released) return;
    const current = await owner(path);
    if (current?.nonce === record.nonce) await unlink(path);
    released = true;
  };
}
/** Explicit crash recovery only. Never remove the lock of a live process. */
export async function unlockStaleLocalLock(path: string) {
  const guard = `${path}.unlock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let file;
  try { file = await open(guard, 'wx', 0o600); }
  catch { throw new Error('Another unlock operation is active. Preserve its guard file and retry after it stops.'); }
  try {
    const current = await owner(path);
    if (!current) return false;
    if (alive(current.pid)) throw new Error('The local lock belongs to a live process. Stop that process first.');
    await unlink(path); return true;
  } finally { await file.close(); await unlink(guard); }
}
