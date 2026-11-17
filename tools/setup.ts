import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import webpush from 'web-push';
import { envPath, projectRoot } from './environment.js';

async function setup() {
  let existing: string;
  try {
    existing = await readFile(envPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    existing = await readFile(join(projectRoot, '.env.example'), 'utf8');
  }
  const current = new Map(existing.split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).trim()] as const;
  }));
  if (!!current.get('VAPID_PUBLIC_KEY') !== !!current.get('VAPID_PRIVATE_KEY')) {
    throw new Error('Both VAPID keys must be present together. Restore the pair or clear both before setup.');
  }
  if (current.get('VAPID_PUBLIC_KEY') && current.get('VAPID_PRIVATE_KEY') && current.get('LOCAL_ADMIN_TOKEN')) {
    await chmod(envPath, 0o600);
    console.log('Local configuration already exists. Existing keys and subscriptions were preserved.');
    return;
  }
  const keys = current.get('VAPID_PUBLIC_KEY') ? undefined : webpush.generateVAPIDKeys();
  const values: Record<string, string> = {
    VAPID_PUBLIC_KEY: keys?.publicKey ?? current.get('VAPID_PUBLIC_KEY')!,
    VAPID_PRIVATE_KEY: keys?.privateKey ?? current.get('VAPID_PRIVATE_KEY')!,
    LOCAL_ADMIN_TOKEN: current.get('LOCAL_ADMIN_TOKEN') || randomBytes(32).toString('base64url'),
  };
  let output = existing;
  for (const [name, value] of Object.entries(values)) {
    const expression = new RegExp(`^${name}=.*$`, 'm');
    output = expression.test(output) ? output.replace(expression, `${name}=${value}`) : `${output}\n${name}=${value}\n`;
  }
  await writeFile(envPath, output, { mode: 0o600 });
  await chmod(envPath, 0o600);
  console.log('Created private local configuration in .env. No keys were printed.');
  console.log('Run npm run dev, then open http://localhost:5173.');
}

setup().catch(error => { console.error(error.message); process.exitCode = 1; });
