import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { distribution, fingerprint } from '../tools/benchmark/model.js';
import { collect, validateTrial, writeEvidenceManifest, type Sample } from '../tools/research/evidence.js';
import { parsePlan, deliveryCount, schedule, smokePlan } from '../tools/research/plan.js';
import { summarize } from '../tools/research/report.js';
import { sha256 } from '../tools/release-artifacts.js';
import { projectRoot } from '../tools/environment.js';
import type { RunResult } from '../tools/baseline/engine.js';
import { subscriptionId } from '../packages/core/src/pipeline.js';

function fixture() {
  const spec = { audience: 3, seed: 42, concurrency: 1 }; const runId = randomUUID();
  const attempts = Array.from({ length: 3 }, (_, index) => ({ deliveryId: sha256(`delivery-${index}`), recipientId: subscriptionId(`https://fcm.googleapis.com/wp/benchmark-42-${index}`), attempt: 1, status: 201, startedAt: new Date().toISOString(), requestMs: 1, queueWaitMs: index * 2 }));
  const outcomes = attempts.map((row, index) => ({ deliveryId: row.deliveryId, state: 'accepted', attempts: 1, endToEndMs: (index + 1) * 5 }));
  const result: RunResult = { runId, spec, workloadSha256: fingerprint(spec, 0), scope: 'synthetic fixture', scheduler: 'phased fan-out, then bounded-parallel delivery', virtualClock: false,
    accepted: 3, failed: 0, seedMs: 1, dispatchMs: 2, deliveryStageMs: 18, elapsedMs: 20, acceptedPerSecond: 150, cpuMs: 5, rssBeforeBytes: 1000000, rssAfterBytes: 2000000,
    databaseOperations: { reads: 10, creates: 3, replaces: 3, transactions: 3, transactionWrites: 6, pages: 1 },
    latencyMs: { endToEnd: distribution(outcomes.map(row => row.endToEndMs)), queueWait: distribution(attempts.map(row => row.queueWaitMs)), providerRequest: distribution([1, 1, 1]) }, attempts, outcomes };
  const observed = attempts.map(row => ({ runId, deliveryId: row.deliveryId, recipientId: row.recipientId, status: 201, attempt: 1, processingMs: 1 }));
  return { spec, result, observed };
}

test('research plans enforce bounded workloads and reproduce a complete seeded scenario order', () => {
  const plan = parsePlan({ ...smokePlan(), audiences: [10, 100, 1000], concurrencies: [1, 2, 4], repetitions: 5 });
  assert.equal(deliveryCount(plan), 36630); assert.equal(schedule(plan).length, 18);
  assert.deepEqual(schedule(plan), schedule(plan));
  assert.notDeepEqual(schedule(plan), schedule({ ...plan, orderSeed: 999 }));
  assert.equal(new Set(schedule(plan).map(row => JSON.stringify(row))).size, 18);
  for (const invalid of [{ ...plan, audiences: [1001] }, { ...plan, audiences: [100, 100] }, { ...plan, concurrencies: [8] }, { ...plan, repetitions: 6 },
    { ...plan, conditions: ['fresh-process'] }, { ...plan, warmup: 0 }, { ...plan, audiences: [998, 999, 1000] }, { ...plan, cloudOrigin: 'https://external.example' }]) assert.throws(() => parsePlan(invalid));
});

test('raw research evidence validates complete recipient accounting and recomputed statistics', () => {
  const { result, observed, spec } = fixture(); assert.doesNotThrow(() => validateTrial(result, observed, spec, 0));
  for (const mutate of [
    (row: RunResult) => { row.outcomes.pop(); },
    (row: RunResult) => { row.attempts[1]!.deliveryId = row.attempts[0]!.deliveryId; },
    (row: RunResult) => { row.attempts[0]!.recipientId = 'b'.repeat(64); },
    (row: RunResult) => { row.outcomes[0]!.state = 'failed'; },
    (row: RunResult) => { row.latencyMs.endToEnd.p95 = 999; },
    (row: RunResult) => { row.elapsedMs = -1; },
    (row: RunResult) => { row.databaseOperations.reads = NaN; },
    (row: RunResult) => { row.acceptedPerSecond = 999; },
  ]) { const changed = structuredClone(result); mutate(changed); assert.throws(() => validateTrial(changed, observed, spec, 0)); }
  assert.throws(() => validateTrial(result, observed.slice(1), spec, 0));
  assert.throws(() => validateTrial(result, observed.map(row => ({ ...row, status: 410 })), spec, 0));
});

test('analysis excludes warm-ups, pools raw latency samples and leaves unmeasured costs null', () => {
  const plan = smokePlan(); const order = schedule(plan);
  const samples = order.flatMap(cell => [1, 2].map(repetition => ({ ...cell, experimentId: randomUUID(), runId: randomUUID(), repetition, warmup: false, accepted: 3,
    elapsedMs: repetition * 100, seedMs: 1, dispatchMs: 1, deliveryStageMs: repetition * 100 - 1, acceptedPerSecond: 30 / repetition, cpuMs: 1, rssBeforeBytes: 1, rssAfterBytes: 2,
    endToEndMs: repetition === 1 ? [1, 2, 3] : [10, 20, 100], queueWaitMs: [1, 2, 3], providerRequestMs: [1, 1, 1], databaseOperations: fixture().result.databaseOperations })));
  samples.push({ ...samples[0]!, warmup: true, acceptedPerSecond: 99999, endToEndMs: [99999] });
  const data = { inputs: { schemaVersion: 1 as const, status: 'completed' as const, id: randomUUID(), plan, order, executions: [], sourceTreeSha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), sourceWasClean: true, compiledSha256: 'c'.repeat(64), startedAt: '', finishedAt: '' },
    samples: samples as Sample[], startups: order.map(cell => ({ ...cell, experimentId: randomUUID(), ms: 20 })), environment: { node: 'test' }, evidenceManifestSha256: 'd'.repeat(64) };
  const result = summarize(data);
  assert.equal(result.counts.measuredTrials, 4); assert.equal(result.counts.warmupTrials, 1); assert.equal(result.counts.measuredAccepted, 12);
  assert.equal(result.groups[0]?.endToEndMs.p95, 100); assert.equal(result.groups[0]?.acceptedPerSecond.max, 30);
  assert.equal(result.cost.measuredAzureCostINR, null); assert.equal(result.cost.measuredLocalEnergyCostINR, null); assert.equal(result.cost.cloudDeploymentEnabled, false);
  assert.throws(() => summarize({ ...data, samples: data.samples.slice(1) }), /missing measured repetitions/);
});

test('evidence manifests detect changed raw files before an analysis is issued', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'webpush-research-')); context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'inputs.json'), '{}');
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(await writeEvidenceManifest(directory)));
  await writeFile(join(directory, 'inputs.json'), '{"changed":true}');
  await assert.rejects(collect(directory), /files or hashes changed/);
});

test('an isolated baseline host exits when its launcher disconnects', async context => {
  const child = fork(join(projectRoot, 'tools/baseline/server.ts'), [], { cwd: projectRoot, execArgv: ['--import', 'tsx'],
    env: { PATH: process.env.PATH ?? '', BENCHMARK_API_TOKEN: randomBytes(32).toString('base64url'), BENCHMARK_PROVIDER_TOKEN: randomBytes(32).toString('base64url'), BENCHMARK_PROVIDER_ORIGIN: 'http://127.0.0.1:65534', BENCHMARK_DELAY_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout?.resume(); child.stderr?.resume(); const exited = once(child, 'exit');
  context.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const message = await Promise.race([once(child, 'message'), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Baseline readiness timed out.')), 10000); })]);
    assert.equal((message[0] as { type: string }).type, 'ready'); child.disconnect();
    clearTimeout(timeout);
    const [code, signal] = await Promise.race([exited, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Orphaned baseline did not stop.')), 10000); })]);
    assert.equal(code, 0); assert.equal(signal, null);
  } finally { clearTimeout(timeout); }
});
