import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import webpush from 'web-push';
import { acquireLocalLock } from '../packages/adapters/src/local-lock.js';
import { parseLocalEnvironment } from './environment.js';

export async function setupLocal(root: string) {
  const path = join(root, '.env');
  const release = await acquireLocalLock(join(root, '.env.setup.lock'));
  try {
    let text: string;
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Setup will not rewrite a symbolic-link .env file.');
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      text = await readFile(join(root, '.env.example'), 'utf8');
    }
    const current = parseEnv(text);
    if (!!current.VAPID_PUBLIC_KEY !== !!current.VAPID_PRIVATE_KEY) throw new Error('Both VAPID keys must be present together. Restore the pair or clear both before setup.');
    const keys = current.VAPID_PUBLIC_KEY ? undefined : webpush.generateVAPIDKeys();
    const values = { VAPID_PUBLIC_KEY: keys?.publicKey ?? current.VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY: keys?.privateKey ?? current.VAPID_PRIVATE_KEY!,
      LOCAL_ADMIN_TOKEN: current.LOCAL_ADMIN_TOKEN || randomBytes(32).toString('base64url') };
    parseLocalEnvironment({ ...current, ...values }, root);
    let changed = false;
    for (const [name, value] of Object.entries(values)) {
      if (current[name]) continue;
      changed = true;
      const expression = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, 'gm');
      text = expression.test(text) ? text.replace(expression, `${name}=${value}`) : `${text.endsWith('\n') ? text : `${text}\n`}${name}=${value}\n`;
    }
    if (changed) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    await chmod(path, 0o600);
    return { created: changed };
  } finally { await release(); }
}
