import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { projectRoot } from '../environment.js';
import { sourceState, treeFiles, treeHash } from '../release-artifacts.js';
import { parsePlan, schedule, smokePlan, deliveryCount } from './plan.js';
import { writeEvidenceManifest, type Execution, type Inputs } from './evidence.js';
import { verifyAnalysis, writeAnalysis } from './report.js';

async function main() {
  const args = process.argv.slice(2); const smoke = args.length === 1 && args[0] === '--smoke';
  if (!smoke && args.length && (args.length !== 2 || args[0] !== '--plan')) throw new Error('Use research:run [--plan <local-json-file>] or research:smoke.');
  const plan = smoke ? smokePlan() : parsePlan(JSON.parse(await readFile(resolve(projectRoot, args[1] ?? 'experiments/local-baseline-v1.json'), 'utf8')));
  const initial = await sourceState(projectRoot);
  if (!smoke && !initial.clean) throw new Error('Commit stable sources before collecting a full experiment. The smoke check permits a dirty checkout.');
  const compiledSha256 = await treeHash(join(projectRoot, 'dist')); const order = schedule(plan); const id = randomUUID();
  const parent = join(projectRoot, '.cache/research'); await mkdir(parent, { recursive: true, mode: 0o700 });
  const lockPath = join(parent, 'active.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw new Error('A research suite owns .cache/research/active.lock. Check that process before clearing a stale lock.'); throw error; });
  const directory = join(parent, id); const executions: Execution[] = []; const startedAt = new Date().toISOString();
  const pointer = (status: string) => writeFile(join(parent, 'latest.json'), JSON.stringify({ id, status, directory: `.cache/research/${id}` }, null, 2), { mode: 0o600 });
  const inputs = <T extends 'running' | 'completed'>(status: T) => ({ schemaVersion: 1 as const, status, id, plan, order, executions, sourceTreeSha256: initial.sha256, sourceCommit: initial.commit,
    sourceWasClean: initial.clean, compiledSha256, startedAt, finishedAt: new Date().toISOString() });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, id, startedAt })); await mkdir(join(directory, 'raw'), { recursive: true, mode: 0o700 }); await pointer('running');
    await writeFile(join(directory, 'inputs.json'), JSON.stringify(inputs('running'), null, 2), { mode: 0o600 });
    const policy = JSON.parse(await readFile(join(projectRoot, 'infra/deployment-policy.json'), 'utf8'));
    if (policy.cloudDeploymentEnabled !== false || policy.monthlyBudgetINR !== 100 || policy.strictSpendingLimitRequired !== true) throw new Error('The strict disabled-cloud policy changed.');
    console.log(`${plan.name}: ${order.length} scenario blocks, ${deliveryCount(plan)} synthetic deliveries including warm-ups. Sequential execution only.`);
    const deadline = Date.now() + 600000;
    for (let cellIndex = 0; cellIndex < order.length; cellIndex++) {
      const cell = order[cellIndex]!; const fresh = cell.condition === 'fresh-process';
      for (let iteration = 0; iteration < (fresh ? plan.repetitions : 1); iteration++) {
        const repetitions = fresh ? 1 : plan.repetitions; const warmup = fresh ? 0 : plan.warmup;
        const timeout = Math.min((repetitions + warmup) * plan.maxDurationMs + 25000, deadline - Date.now());
        if (timeout <= 0) throw new Error('The research suite reached its ten-minute bound.');
        let output: Buffer;
        try {
          output = execFileSync(process.execPath, ['dist/tools/benchmark/run.js', '--audience', String(cell.audience), '--repetitions', String(repetitions), '--warmup', String(warmup),
            '--seed', String(plan.seed), '--concurrency', String(cell.concurrency), '--mock-delay-ms', String(plan.mockDelayMs), '--max-duration-ms', String(plan.maxDurationMs)],
          { cwd: projectRoot, timeout, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          const failure = error as { stdout?: Buffer; stderr?: Buffer };
          await writeFile(join(directory, 'failed-execution.log'), Buffer.concat([failure.stdout ?? Buffer.alloc(0), failure.stderr ?? Buffer.alloc(0)]), { mode: 0o600 });
          throw new Error(`Scenario ${cellIndex + 1} failed or timed out. Partial benchmark traces remain in .cache/benchmarks; the suite is invalid.`);
        }
        const benchmarkId = /\.cache\/benchmarks\/([a-f0-9-]{36})\/report\.md/.exec(output.toString())?.[1];
        if (!benchmarkId) throw new Error('The benchmark did not return its own successful output directory.');
        const original = join(projectRoot, '.cache/benchmarks', benchmarkId); await treeFiles(original);
        const copy = join(directory, 'raw', benchmarkId); await cp(original, copy, { recursive: true, errorOnExist: true, force: false });
        await writeFile(join(copy, 'driver.log'), output, { mode: 0o600 }); executions.push({ id: benchmarkId, cell, iteration });
        await writeFile(join(directory, 'inputs.json'), JSON.stringify(inputs('running'), null, 2), { mode: 0o600 });
        console.log(`Scenario ${cellIndex + 1}/${order.length}: n=${cell.audience}, workers=${cell.concurrency}, ${cell.condition}, execution ${iteration + 1}: saved ${benchmarkId}`);
      }
    }
    if ((await sourceState(projectRoot)).sha256 !== initial.sha256 || await treeHash(join(projectRoot, 'dist')) !== compiledSha256) throw new Error('Sources or compiled tools changed during the suite.');
    await writeFile(join(directory, 'inputs.json'), JSON.stringify(inputs('completed') satisfies Inputs, null, 2), { mode: 0o600 });
    await writeFile(join(directory, 'evidence.json'), JSON.stringify(await writeEvidenceManifest(directory), null, 2), { mode: 0o600 });
    const analysis = await writeAnalysis(directory); await verifyAnalysis(directory); await pointer('passed');
    console.log(`Research passed: ${analysis.counts.measuredTrials} measured trials, ${analysis.counts.measuredAccepted} mock acceptances. Report: ${directory}/report.md`);
  } catch (error) {
    await writeFile(join(directory, 'failure.json'), JSON.stringify({ id, status: 'failed', message: error instanceof Error ? error.message : 'Research failed.', completedExecutions: executions.length }, null, 2), { mode: 0o600 });
    await pointer('failed'); throw error;
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Research failed.'); process.exitCode = 1; });
