import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectRoot } from './environment.js';

const output = join(projectRoot, '.cache', 'azure-package');
const archive = join(projectRoot, '.cache', 'azure-function.zip');
await rm(output, { recursive: true, force: true });
await rm(archive, { force: true });
await mkdir(output, { recursive: true });
await build({ entryPoints: [join(projectRoot, 'apps/functions/src/azure.ts')], outfile: join(output, 'index.cjs'),
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['@azure/functions'], sourcemap: false, logLevel: 'warning' });
const copied = new Set<string>();
async function copyRuntimePackage(name: string, from: string) {
  if (copied.has(name)) return;
  const require = createRequire(from);
  let directory = dirname(require.resolve(name));
  let manifest: { name: string; version: string; dependencies?: Record<string, string> };
  for (;;) {
    try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); if (manifest.name === name) break; } catch {}
    const parent = dirname(directory); if (parent === directory) throw new Error(`Cannot locate runtime dependency ${name}`); directory = parent;
  }
  copied.add(name);
  const destination = join(output, 'node_modules', name);
  await mkdir(dirname(destination), { recursive: true });
  await cp(directory, destination, { recursive: true, filter: source => !source.includes(`${directory}/node_modules/`) });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) await copyRuntimePackage(dependency, join(directory, 'package.json'));
}
await copyRuntimePackage('@azure/functions', join(projectRoot, 'package.json'));
await cp(join(projectRoot, 'apps/functions/host.json'), join(output, 'host.json'));
const project = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as { version: string };
await writeFile(join(output, 'package.json'), JSON.stringify({ name: 'webpush-azure-functions', version: project.version, private: true, main: 'index.cjs', engines: { node: '24.x' } }, null, 2));
execFileSync('zip', ['-qr', archive, '.'], { cwd: output });
console.log('Packaged .cache/azure-function.zip with cloud handlers and runtime dependencies.');
console.log('Local environment files and subscription data are excluded.');
