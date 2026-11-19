import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { localLockStatus } from '../packages/adapters/src/local-lock.js';
import { envPath, loadEnvironment, projectRoot } from './environment.js';

try {
  const config = loadEnvironment();
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major! < 22 || (major === 22 && minor! < 19)) throw new Error('Use Node 22.19+ or the recommended Node 24.');
  try { if (process.platform !== 'win32' && ((await stat(envPath)).mode & 0o077)) throw new Error('The .env permissions are too open. Run npm run setup to restore private permissions.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const lock = await localLockStatus(join(config.dataDirectory, 'backend.lock'));
  if (lock === 'stale') throw new Error('A stale backend lock remains. With services stopped, run npm run local:unlock.');
  const built = await stat(join(projectRoot, 'apps/dashboard/dist/index.html')).then(() => true, () => false);
  console.log(`Node ${process.versions.node}: ready`);
  console.log('Local configuration: matching VAPID pair and private CLI credential validated');
  console.log(`Frontend: ${config.webOrigin}; API port: ${config.port}`);
  console.log(`Backend data owner: ${lock}; dashboard build: ${built ? 'present' : 'missing (run npm run build)'}`);
  for (const [name, field] of [['subscriptions.json', 'subscriptions'], ['phase2-documents.json', 'documents'], ['phase2-queues.json', 'documents']] as const) {
    try {
      const content = await readFile(join(config.dataDirectory, name), 'utf8');
      const data = JSON.parse(content) as Record<string, unknown>;
      if (data.version !== 1 || !Array.isArray(data[field])) throw new Error();
      const rows = data[field] as { kind?: string }[];
      const dead = rows.filter(row => row?.kind === 'dead-letter').length;
      console.log(`${name}: ${rows.length} records${name.includes('queues') ? `; ${dead} dead letters` : ''}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot read ${name}. Existing data was preserved; stop services and inspect a private backup.`);
    }
  }
  if (config.vapid.subject.endsWith('@example.com')) console.log('VAPID contact is still the local example; set a real contact before Safari testing.');
  console.log('No credentials were printed and no Azure requests were made.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Local preflight failed.'); process.exitCode = 1; }
