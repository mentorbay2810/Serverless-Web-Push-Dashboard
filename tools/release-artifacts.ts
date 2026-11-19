import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export async function sourceDigest(root: string, files: string[]) {
  const hash = createHash('sha256');
  for (const file of files) {
    if (isAbsolute(file) || file.split('/').some(part => ['..', '.git', '.data', '.cache', '.azure', '.azure-profiles', '.aws', '.container-backup', 'node_modules'].includes(part))
      || /(?:^|\/)(?:\.env(?!\.example$)|local\.settings\.json)/.test(file)) throw new Error('A private or generated path was included in the source set.');
    const path = join(root, file);
    if (!(await lstat(path)).isFile()) throw new Error('Release sources must be regular files, not symlinks.');
    hash.update(file); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0');
  }
  return hash.digest('hex');
}
export async function sourceState(root: string) {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root }).toString().split('\0').filter(Boolean))].sort();
  return { files, sha256: await sourceDigest(root, files), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
    clean: !execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim() };
}
export async function treeFiles(directory: string): Promise<string[]> {
  const rows = await readdir(directory, { withFileTypes: true }); const files: string[] = [];
  for (const row of rows) {
    const path = join(directory, row.name);
    if (row.isSymbolicLink()) throw new Error('Build artifacts must not contain symlinks.');
    if (row.isDirectory()) files.push(...await treeFiles(path)); else if (row.isFile()) files.push(path);
  }
  return files.sort();
}
export async function treeHash(directory: string) {
  const hash = createHash('sha256');
  for (const path of await treeFiles(directory)) { hash.update(relative(directory, path).replaceAll('\\', '/')); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0'); }
  return hash.digest('hex');
}
export async function checkArtifacts(root: string, privateValues: string[]) {
  const source = await sourceState(root); const dashboard = join(root, 'apps/dashboard/dist');
  const check = (bytes: Uint8Array) => {
    const data = Buffer.from(bytes);
    if (privateValues.some(value => value.length > 20 && data.includes(Buffer.from(value)))) throw new Error('A generated private credential was found in source or build artifacts.');
  };
  for (const path of [...source.files.map(file => join(root, file)), ...await treeFiles(dashboard)]) check(await readFile(path));
  const archive = join(root, '.cache/azure-function.zip');
  const names = execFileSync('unzip', ['-Z1', archive]).toString().split('\n').filter(Boolean);
  for (const name of names) if (name.startsWith('/') || name.split('/').some(part => ['..', '.data', '.env', 'local.settings.json'].includes(part))) throw new Error('The cloud archive contains a private or unsafe path.');
  check(execFileSync('unzip', ['-p', archive], { maxBuffer: 64 * 1024 * 1024 }));
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version as string;
  const packaged = JSON.parse(execFileSync('unzip', ['-p', archive, 'package.json']).toString()) as { version: string };
  if (packaged.version !== version) throw new Error('The cloud archive version does not match the candidate.');
  const policy = JSON.parse(await readFile(join(root, 'infra/deployment-policy.json'), 'utf8'));
  if (policy.cloudDeploymentEnabled !== false || policy.monthlyBudgetINR !== 100 || policy.strictSpendingLimitRequired !== true) throw new Error('The disabled deployment policy changed. Review the budget decision before preparing a release.');
  return { sourceTreeSha256: source.sha256, dashboardSha256: await treeHash(dashboard), cloudArchiveSha256: sha256(await readFile(archive)), sourceFiles: source.files.length };
}
