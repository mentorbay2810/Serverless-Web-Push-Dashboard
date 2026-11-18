import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkArtifacts, sha256, sourceDigest, sourceState, treeHash } from './release-artifacts.js';
import { loadEnvironment, projectRoot } from './environment.js';

async function main() {
  const config = loadEnvironment(); const current = await sourceState(projectRoot);
  if (!current.clean) throw new Error('Commit the candidate sources before packaging. Private .env and .data files remain ignored.');
  const report = JSON.parse(await readFile(join(projectRoot, '.cache/release/report.json'), 'utf8'));
  const artifacts = await checkArtifacts(projectRoot, [config.adminToken, config.vapid.privateKey]);
  if (report.status !== 'local_checks_passed' || !report.tests?.total || report.tests.total !== report.tests.passed
    || !['sourceTreeSha256', 'dashboardSha256', 'cloudArchiveSha256'].every(key => report[key] === artifacts[key as keyof typeof artifacts])) throw new Error('Source or artifacts changed since verification. Run npm run release:check again.');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[\w.-]+)?$/.test(report.version)) throw new Error('Invalid release version.');
  const directory = join(projectRoot, '.cache/releases'); const bundle = join(directory, 'bundle');
  await rm(bundle, { recursive: true, force: true }); await mkdir(join(bundle, 'source'), { recursive: true });
  for (const file of current.files) { const destination = join(bundle, 'source', file); await mkdir(dirname(destination), { recursive: true }); await cp(join(projectRoot, file), destination); }
  await cp(join(projectRoot, 'apps/dashboard/dist'), join(bundle, 'dashboard'), { recursive: true });
  await cp(join(projectRoot, '.cache/azure-function.zip'), join(bundle, 'azure-functions.zip'));
  if (await sourceDigest(join(bundle, 'source'), current.files) !== current.sha256
    || await treeHash(join(bundle, 'dashboard')) !== artifacts.dashboardSha256
    || sha256(await readFile(join(bundle, 'azure-functions.zip'))) !== artifacts.cloudArchiveSha256
    || (await sourceState(projectRoot)).sha256 !== current.sha256) throw new Error('Release inputs changed while packaging. Retry on a stable checkout.');
  await writeFile(join(bundle, 'RELEASE.json'), JSON.stringify({ ...report, sourceCommit: current.commit, sourceVerifiedBy: 'matching source tree SHA-256', packagedAt: new Date().toISOString() }, null, 2));
  const name = `webpush-${report.version}.zip`; const archive = join(directory, name);
  await rm(archive, { force: true }); execFileSync('zip', ['-qr', archive, '.'], { cwd: bundle });
  const checksum = sha256(await readFile(archive)); await writeFile(`${archive}.sha256`, `${checksum}  ${name}\n`);
  console.log(`Prepared .cache/releases/${name}`); console.log(`SHA-256: ${checksum}`);
  console.log('Includes public source, built dashboard, review-only cloud package, and verification manifest. No deployment was performed.');
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Release packaging failed.'); process.exitCode = 1; });
