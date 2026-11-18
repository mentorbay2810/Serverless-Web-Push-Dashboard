import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { RunResult } from '../baseline/engine.js';
import { distribution, fingerprint } from '../benchmark/model.js';
import { subscriptionId } from '../../packages/core/src/pipeline.js';
import { sha256, treeFiles } from '../release-artifacts.js';
import { parsePlan, schedule, type Cell, type Plan } from './plan.js';

export interface Execution { id: string; cell: Cell; iteration: number }
export interface Inputs {
  schemaVersion: 1; status: 'completed'; id: string; plan: Plan; order: Cell[]; executions: Execution[];
  sourceTreeSha256: string; sourceCommit: string; sourceWasClean: boolean; compiledSha256: string; startedAt: string; finishedAt: string;
}
export interface Sample extends Cell {
  experimentId: string; runId: string; repetition: number; warmup: boolean; accepted: number;
  elapsedMs: number; seedMs: number; dispatchMs: number; deliveryStageMs: number; acceptedPerSecond: number; cpuMs: number;
  rssBeforeBytes: number; rssAfterBytes: number; endToEndMs: number[]; queueWaitMs: number[]; providerRequestMs: number[];
  databaseOperations: RunResult['databaseOperations'];
}
export const cellKey = (cell: Cell) => `${cell.audience}/${cell.concurrency}/${cell.condition}`;
const same = (a: unknown, b: unknown, message: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(message); };
const nonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function validateTrial(result: RunResult, observed: Record<string, unknown>[], spec: { audience: number; seed: number; concurrency: number }, delayMs: number) {
  same(result.spec, spec, 'Trial workload mismatch.');
  if (result.workloadSha256 !== fingerprint(spec, delayMs) || result.virtualClock !== false || result.accepted !== spec.audience || result.failed !== 0
    || result.scheduler !== 'phased fan-out, then bounded-parallel delivery' || !/^[a-f0-9-]{36}$/.test(result.runId)) throw new Error('Trial scope or outcome mismatch.');
  for (const key of ['seedMs', 'dispatchMs', 'deliveryStageMs', 'elapsedMs', 'cpuMs', 'rssBeforeBytes', 'rssAfterBytes'] as const) if (!nonnegative(result[key])) throw new Error('Invalid trial resource or duration measurement.');
  if (result.elapsedMs <= 0 || Math.abs(result.elapsedMs - result.dispatchMs - result.deliveryStageMs) > 1e-6
    || result.acceptedPerSecond !== result.accepted / (result.elapsedMs / 1000)) throw new Error('Inconsistent trial timing.');
  if (!Array.isArray(result.attempts) || !Array.isArray(result.outcomes) || result.attempts.length !== spec.audience || result.outcomes.length !== spec.audience
    || observed.length !== spec.audience) throw new Error('Incomplete raw delivery evidence.');
  const expected = new Set(Array.from({ length: spec.audience }, (_, index) => subscriptionId(`https://fcm.googleapis.com/wp/benchmark-${spec.seed}-${index}`)));
  const deliveryIds = new Set<string>(); const recipients = new Set<string>(); const providerIds = new Set<string>();
  const providers = new Map(observed.map(row => [row.deliveryId, row]));
  for (const row of observed) {
    if (row.runId !== result.runId || row.status !== 201 || row.attempt !== 1 || !nonnegative(row.processingMs) || typeof row.deliveryId !== 'string' || providerIds.has(row.deliveryId)) throw new Error('Invalid or duplicate provider observation.');
    providerIds.add(row.deliveryId);
  }
  for (const row of result.attempts) {
    const provider = providers.get(row.deliveryId);
    if (!/^[a-f0-9]{64}$/.test(row.deliveryId) || deliveryIds.has(row.deliveryId) || recipients.has(row.recipientId) || !expected.has(row.recipientId)
      || row.status !== 201 || row.attempt !== 1 || !provider || provider.recipientId !== row.recipientId
      || !nonnegative(row.requestMs) || !nonnegative(row.queueWaitMs) || row.requestMs > result.elapsedMs || row.queueWaitMs > result.elapsedMs) throw new Error('Attempt and provider accounting disagree.');
    deliveryIds.add(row.deliveryId); recipients.add(row.recipientId);
  }
  const outcomes = new Set<string>();
  for (const row of result.outcomes) {
    if (!deliveryIds.has(row.deliveryId) || outcomes.has(row.deliveryId) || row.state !== 'accepted' || row.attempts !== 1
      || !nonnegative(row.endToEndMs) || row.endToEndMs > result.elapsedMs) throw new Error('Invalid final delivery outcomes.');
    outcomes.add(row.deliveryId);
  }
  const operations = ['reads', 'creates', 'replaces', 'transactions', 'transactionWrites', 'pages'] as const;
  if (Object.keys(result.databaseOperations).length !== operations.length) throw new Error('Incomplete adapter operation counts.');
  for (const key of operations) if (!Number.isSafeInteger(result.databaseOperations[key]) || result.databaseOperations[key] < 0) throw new Error('Invalid adapter operation count.');
  same(result.latencyMs.endToEnd, distribution(result.outcomes.map(row => row.endToEndMs)), 'End-to-end percentile mismatch.');
  same(result.latencyMs.queueWait, distribution(result.attempts.map(row => row.queueWaitMs)), 'Queue percentile mismatch.');
  same(result.latencyMs.providerRequest, distribution(result.attempts.map(row => row.requestMs)), 'Provider percentile mismatch.');
}
export async function writeEvidenceManifest(directory: string) {
  const files = (await treeFiles(directory)).filter(path => ['inputs.json'].includes(relative(directory, path)) || relative(directory, path).startsWith('raw/'));
  const evidence = [];
  for (const path of files) evidence.push({ path: relative(directory, path).replaceAll('\\', '/'), sha256: sha256(await readFile(path)) });
  return { schemaVersion: 1, files: evidence };
}
export async function collect(directory: string) {
  const manifestBytes = await readFile(join(directory, 'evidence.json')); const manifest = JSON.parse(manifestBytes.toString()) as { schemaVersion: number; files: { path: string; sha256: string }[] };
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 2000) throw new Error('Invalid research evidence manifest.');
  const actual = await writeEvidenceManifest(directory);
  same(manifest, actual, 'Research evidence files or hashes changed.');
  const inputs = JSON.parse(await readFile(join(directory, 'inputs.json'), 'utf8')) as Inputs;
  const plan = parsePlan(inputs.plan);
  if (inputs.schemaVersion !== 1 || inputs.status !== 'completed' || !/^[a-f0-9-]{36}$/.test(inputs.id)
    || !/^[a-f0-9]{64}$/.test(inputs.sourceTreeSha256) || !/^[a-f0-9]{40}$/.test(inputs.sourceCommit) || typeof inputs.sourceWasClean !== 'boolean'
    || !/^[a-f0-9]{64}$/.test(inputs.compiledSha256)) throw new Error('Research inputs are incomplete.');
  same(inputs.order, schedule(plan), 'The recorded scenario order differs from the seeded plan.');
  const expected = inputs.order.flatMap(cell => Array.from({ length: cell.condition === 'fresh-process' ? plan.repetitions : 1 }, (_, iteration) => ({ cell, iteration })));
  if (inputs.executions.length !== expected.length || new Set(inputs.executions.map(row => row.id)).size !== expected.length) throw new Error('Research executions are missing or duplicated.');
  const samples: Sample[] = []; const startups: (Cell & { experimentId: string; ms: number })[] = []; let environment: unknown;
  for (let index = 0; index < expected.length; index++) {
    const execution = inputs.executions[index]!; same({ cell: execution.cell, iteration: execution.iteration }, expected[index], 'An execution was reordered or assigned to a different condition.');
    if (!/^[a-f0-9-]{36}$/.test(execution.id)) throw new Error('Invalid raw experiment ID.');
    const raw = join(directory, 'raw', execution.id); const s = JSON.parse(await readFile(join(raw, 'summary.json'), 'utf8'));
    const { cell } = execution; const repetitions = cell.condition === 'fresh-process' ? 1 : plan.repetitions; const warmup = cell.condition === 'fresh-process' ? 0 : plan.warmup;
    same(s.settings, { audience: cell.audience, repetitions, warmup, seed: plan.seed, concurrency: cell.concurrency, 'mock-delay-ms': plan.mockDelayMs, 'max-duration-ms': plan.maxDurationMs }, 'A raw experiment used different settings.');
    if (s.id !== execution.id || s.status !== 'passed' || s.sourceTreeSha256 !== inputs.sourceTreeSha256 || s.sourceCommitAtRun !== inputs.sourceCommit || s.sourceWasClean !== inputs.sourceWasClean
      || s.workloadSha256 !== fingerprint({ audience: cell.audience, seed: plan.seed, concurrency: cell.concurrency }, plan.mockDelayMs) || s.compiledSha256 !== inputs.compiledSha256 || s.cloudDeploymentEnabled !== false
      || s.virtualClock !== false || s.hostReused !== true || !nonnegative(s.processStartupMs) || s.trials?.length !== repetitions + warmup) throw new Error('Raw experiment provenance or completeness mismatch.');
    if (environment === undefined) environment = s.environment; else same(environment, s.environment, 'Experiments ran in different environments.');
    startups.push({ ...cell, experimentId: execution.id, ms: s.processStartupMs });
    const allProvider: unknown[] = []; const experimentSamples: Sample[] = [];
    for (let trial = 0; trial < repetitions + warmup; trial++) {
      const prefix = `trial-${String(trial + 1).padStart(2, '0')}`; const result = JSON.parse(await readFile(join(raw, `${prefix}.json`), 'utf8')) as RunResult;
      const observed = (await readFile(join(raw, `${prefix}-provider.ndjson`), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
      validateTrial(result, observed, { audience: cell.audience, seed: plan.seed, concurrency: cell.concurrency }, plan.mockDelayMs); allProvider.push(...observed);
      const { attempts, outcomes, ...metrics } = result;
      same(s.trials[trial], { ...metrics, warmup: trial < warmup, tracePrefix: prefix }, 'Raw trial and summary disagree.');
      same(await readFile(join(raw, `${prefix}-attempts.ndjson`), 'utf8'), attempts.map(row => JSON.stringify(row)).join('\n') + '\n', 'Attempt trace differs from trial JSON.');
      same(await readFile(join(raw, `${prefix}-outcomes.csv`), 'utf8'), 'deliveryId,state,attempts,endToEndMs\n' + outcomes.map(row => `${row.deliveryId},${row.state},${row.attempts},${row.endToEndMs}`).join('\n') + '\n', 'CSV outcomes differ from trial JSON.');
      experimentSamples.push({ ...cell, experimentId: execution.id, runId: result.runId, repetition: cell.condition === 'fresh-process' ? execution.iteration + 1 : trial - warmup + 1, warmup: trial < warmup,
        accepted: result.accepted, elapsedMs: result.elapsedMs, seedMs: result.seedMs, dispatchMs: result.dispatchMs, deliveryStageMs: result.deliveryStageMs, acceptedPerSecond: result.acceptedPerSecond,
        cpuMs: result.cpuMs, rssBeforeBytes: result.rssBeforeBytes, rssAfterBytes: result.rssAfterBytes, databaseOperations: result.databaseOperations,
        endToEndMs: outcomes.map(row => row.endToEndMs), queueWaitMs: attempts.map(row => row.queueWaitMs), providerRequestMs: attempts.map(row => row.requestMs) });
    }
    same(await readFile(join(raw, 'provider-all.ndjson'), 'utf8'), allProvider.map(row => JSON.stringify(row)).join('\n') + '\n', 'The complete provider trace is inconsistent.');
    const measured = experimentSamples.filter(row => !row.warmup);
    same(s.aggregate, { accepted: measured.reduce((sum, row) => sum + row.accepted, 0), failed: 0, elapsedMs: distribution(measured.map(row => row.elapsedMs)),
      acceptedPerSecond: distribution(measured.map(row => row.acceptedPerSecond)), endToEndMs: distribution(measured.flatMap(row => row.endToEndMs)) }, 'Raw aggregate statistics disagree with measured trials.');
    samples.push(...experimentSamples);
  }
  if (new Set(samples.map(row => row.runId)).size !== samples.length) throw new Error('A raw trial was reused across executions.');
  return { inputs, samples, startups, environment, evidenceManifestSha256: sha256(manifestBytes) };
}
