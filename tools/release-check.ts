import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { checkArtifacts, sourceState } from './release-artifacts.js';
import { loadEnvironment, projectRoot } from './environment.js';

async function main() {
  const config = loadEnvironment(); const initial = await sourceState(projectRoot);
  const directory = join(projectRoot, '.cache/release'); await mkdir(directory, { recursive: true });
  await rm(join(directory, 'report.json'), { force: true });
  if (process.env.VITE_API_ORIGIN?.trim()) throw new Error('Keep VITE_API_ORIGIN empty for the local release candidate.');
  for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const settings = await readFile(join(projectRoot, 'apps/dashboard', file), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    if (parseEnv(settings).VITE_API_ORIGIN?.trim()) throw new Error('Keep the dashboard VITE_API_ORIGIN empty for a local release check.');
  }
  const run = async (name: string, command: string, args: string[]) => {
    let output: Buffer;
    try { output = execFileSync(command, args, { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) {
      const result = error as { stdout?: Buffer; stderr?: Buffer };
      await writeFile(join(directory, `${name}.log`), Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]), { mode: 0o600 });
      throw new Error(`${name} failed. Inspect the ignored .cache/release/${name}.log.`);
    }
    await writeFile(join(directory, `${name}.log`), output, { mode: 0o600 }); console.log(`${name}: passed`); return output.toString();
  };
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await run('doctor', npm, ['run', 'doctor']);
  const tests = await run('tests', npm, ['test']);
  await run('build', npm, ['run', 'build']);
  await run('cloud-package', npm, ['run', 'package:cloud']);
  await run('built-smoke', process.execPath, ['dist/tools/release-smoke.js']);
  const artifacts = await checkArtifacts(projectRoot, [config.adminToken, config.vapid.privateKey]); console.log('artifacts-and-policy: passed');
  const current = await sourceState(projectRoot);
  if (initial.sha256 !== current.sha256) throw new Error('Sources changed while release checks ran. Run them again on a stable checkout.');
  const total = Number(/# tests (\d+)/.exec(tests)?.[1]); const passed = Number(/# pass (\d+)/.exec(tests)?.[1]);
  if (!total || total !== passed) throw new Error('The test summary is incomplete.');
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as { version: string };
  const report = { schemaVersion: 1, status: 'local_checks_passed', version: manifest.version, checkedAt: new Date().toISOString(), node: process.versions.node,
    sourceCommitAtCheck: initial.commit, sourceWasClean: initial.clean, tests: { total, passed }, ...artifacts,
    cloudDeploymentEnabled: false, scope: 'local candidate only', pending: ['visual UI and real click checks', 'broader cross-browser checks', 'live Azure and Entra verification'],
    checks: ['doctor', 'tests', 'build', 'cloud-package', 'built-smoke', 'artifacts-and-policy'] };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`Local candidate ${manifest.version}: ${passed} tests passed. Report: .cache/release/report.json`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Release checks failed.'); process.exitCode = 1; });
