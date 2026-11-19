import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from './environment.js';
import { sha256, sourceState } from './release-artifacts.js';

async function main() {
  const initial = await sourceState(projectRoot); const directory = join(projectRoot, '.cache/validation'); await mkdir(directory, { recursive: true });
  for (const name of ['report.json', 'report.md']) await rm(join(directory, name), { force: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  for (const name of ['release:check', 'benchmark:smoke']) {
    try { execFileSync(npm, ['run', name], { cwd: projectRoot, stdio: 'inherit' }); }
    catch { throw new Error(`${name} failed; validation report was not issued.`); }
  }
  const release = JSON.parse(await readFile(join(projectRoot, '.cache/release/report.json'), 'utf8'));
  const pointer = JSON.parse(await readFile(join(projectRoot, '.cache/benchmarks/latest.json'), 'utf8'));
  if (pointer.status !== 'passed' || !/^[a-f0-9-]{36}$/.test(pointer.id)) throw new Error('The benchmark did not pass.');
  const benchmarkPath = `.cache/benchmarks/${pointer.id}`;
  const benchmark = JSON.parse(await readFile(join(projectRoot, benchmarkPath, 'summary.json'), 'utf8'));
  const junit = await readFile(join(directory, 'junit.xml'), 'utf8');
  const count = [...junit.matchAll(/<testcase(?:\s|>)/g)].length;
  if (count !== release.tests.passed || /<(?:failure|error|skipped)(?:\s|\/|>)/.test(junit)) throw new Error('JUnit and TAP results disagree or contain non-passing tests.');
  if (release.sourceTreeSha256 !== initial.sha256 || benchmark.sourceTreeSha256 !== initial.sha256 || benchmark.status !== 'passed'
    || (await sourceState(projectRoot)).sha256 !== initial.sha256) throw new Error('Evidence was generated from different sources.');
  const files = ['.cache/release/report.json', '.cache/release/tests.log', '.cache/validation/junit.xml', `${benchmarkPath}/summary.json`, `${benchmarkPath}/report.md`,
    ...benchmark.traceFiles.map((name: string) => `${benchmarkPath}/${name}`), `${benchmarkPath}/provider-all.ndjson`];
  const evidence = [];
  for (const path of files) {
    if (!path.startsWith('.cache/') || path.split('/').includes('..')) throw new Error('Invalid evidence path.');
    evidence.push({ path, sha256: sha256(await readFile(join(projectRoot, path))) });
  }
  const pending = ['Visual dashboard and OS notification/click checks', 'Real cross-browser permission, offline and tab-closed checks', 'Live Azure queue, Cosmos and Entra verification', 'Comparable serverless benchmark and measured cloud costs'];
  const report = { schemaVersion: 1, status: 'local_validation_passed', checkedAt: new Date().toISOString(), version: release.version, node: process.versions.node,
    sourceTreeSha256: initial.sha256, sourceCommitAtCheck: initial.commit, sourceWasClean: initial.clean, tests: { ...release.tests, junitCases: count },
    releaseChecks: release.checks, benchmark: { id: pointer.id, scope: benchmark.scope, accepted: benchmark.aggregate.accepted, failed: benchmark.aggregate.failed },
    cloudDeploymentEnabled: false, pending, evidence };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await writeFile(join(directory, 'report.md'), `# Local validation evidence\n\n${report.version}: ${count} tests passed (TAP and JUnit agree). Compiled smoke and artifact/policy checks passed.\n\nSource SHA-256: \`${initial.sha256}\`.\n\nThe bounded baseline smoke accepted ${report.benchmark.accepted} synthetic deliveries with ${report.benchmark.failed} failures. This is a functional harness check, not a performance conclusion.\n\nCloud deployment stays disabled under the strict INR 100 decision.\n\nPending:\n\n${pending.map(item => `- ${item}`).join('\n')}\n\nMachine-readable report.json binds every raw evidence file above to a SHA-256 digest. See [benchmark report](../benchmarks/${pointer.id}/report.md).\n`, { mode: 0o600 });
  console.log(`Local validation: ${count} tests passed. Report: .cache/validation/report.md`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Local validation failed.'); process.exitCode = 1; });
