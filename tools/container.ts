import { lstat, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { envPath, loadEnvironment, projectRoot } from './environment.js';
import { setupLocal } from './setup-local.js';
import { runLocalEntry } from '../apps/functions/src/local-runtime.js';

async function removePreviousPidLock(lock: string) {
  // The image entrypoint holds the kernel flock for this dedicated Docker volume.
  // PID-only locks from a stopped container cannot identify owners in a new namespace.
  try {
    if (!(await lstat(lock)).isFile()) throw new Error('Unexpected backend lock. Preserve the volume and inspect it.');
    const owner = JSON.parse(await readFile(lock, 'utf8')) as { version?: number; pid?: number; nonce?: string };
    if (owner.version !== 1 || !Number.isInteger(owner.pid) || owner.pid! < 1 || typeof owner.nonce !== 'string' || !owner.nonce) throw new Error('Unexpected backend lock. Preserve the volume and inspect it.');
    await unlink(lock);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

try {
  await removePreviousPidLock(`${envPath}.setup.lock`);
  await setupLocal(dirname(envPath));
  const config = loadEnvironment();
  await removePreviousPidLock(join(config.dataDirectory, 'backend.lock'));
  const runtime = await runLocalEntry(config, { frontendDirectory: join(projectRoot, 'apps/dashboard/dist'),
    frontendHost: '0.0.0.0', startPaused: process.argv.includes('--paused') });
  if (runtime) {
    console.log(`Dashboard: ${runtime.config.webOrigin}`);
    console.log('Administrator link: docker compose exec webpush node dist/tools/admin-login.js');
    console.log('Keys and queued data are saved in the private Docker volume. Cloud deployment is off.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Container startup failed.');
  process.exitCode = 1;
}
