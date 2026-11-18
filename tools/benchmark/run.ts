import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release, arch } from 'node:os';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { projectRoot } from '../environment.js';
import { sourceState, treeHash } from '../release-artifacts.js';
import type { BaselineJob } from '../baseline/host.js';
import type { RunResult } from '../baseline/engine.js';
import { distribution, fingerprint, integer, workload } from './model.js';
import { mockProvider } from './mock-provider.js';
import { launchBaseline } from './launcher.js';

async function main() {
  const settings = { audience: 100, repetitions: 3, warmup: 1, seed: 42, concurrency: 2, 'mock-delay-ms': 2, 'max-duration-ms': 20000 };
  const bounds: Record<keyof typeof settings, [number, number]> = { audience: [1, 1000], repetitions: [1, 10], warmup: [0, 2], seed: [0, 0xffffffff],
    concurrency: [1, 8], 'mock-delay-ms': [0, 25], 'max-duration-ms': [1000, 60000] };
  const args = process.argv.slice(2); const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2) as keyof typeof settings;
    if (!args[index]?.startsWith('--') || !Object.hasOwn(settings, key) || seen.has(key) || !/^\d+$/.test(args[index + 1] ?? '')) throw new Error('Use unique --audience, --repetitions, --warmup, --seed, --concurrency, --mock-delay-ms, or --max-duration-ms integer options.');
    settings[key] = integer(Number(args[index + 1]), key, ...bounds[key]); seen.add(key);
  }
  const spec = workload({ audience: settings.audience, seed: settings.seed, concurrency: settings.concurrency });
  const initial = await sourceState(projectRoot); const compiledSha256 = await treeHash(join(projectRoot, 'dist'));
  const id = randomUUID(); const directory = join(projectRoot, '.cache/benchmarks', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const write = async (name: string, value: string) => writeFile(join(directory, name), value, { mode: 0o600 });
  const pointer = (status: string) => writeFile(join(projectRoot, '.cache/benchmarks/latest.json'), JSON.stringify({ id, status, directory: relative(projectRoot, directory) }, null, 2), { mode: 0o600 });
  await pointer('running');
  const providerToken = randomBytes(32).toString('base64url');
  let controlled: Awaited<ReturnType<typeof mockProvider>> | undefined;
  let host: Awaited<ReturnType<typeof launchBaseline>> | undefined;
  const trials: (Omit<RunResult, 'attempts' | 'outcomes'> & { warmup: boolean; tracePrefix: string })[] = [];
  const pooledLatencies: number[] = []; const traceNames: string[] = [];
  try {
    // Tokens stay only in parent/child memory and are never included in evidence.
    controlled = await mockProvider({ token: providerToken, delayMs: settings['mock-delay-ms'] });
    host = await launchBaseline(projectRoot, { origin: controlled.origin, token: providerToken, delayMs: settings['mock-delay-ms'] });
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`${host!.origin}${path}`, { method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit',
        headers: { Authorization: `Bearer ${host!.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Research host returned HTTP ${response.status}.`);
      return await response.json() as BaselineJob;
    };
    for (let index = 0; index < settings.warmup + settings.repetitions; index++) {
      const warmup = index < settings.warmup; const prefix = `trial-${String(index + 1).padStart(2, '0')}`;
      let job = await request('/runs', spec); const deadline = performance.now() + settings['max-duration-ms'];
      while (job.status === 'running') {
        if (performance.now() > deadline) throw new Error('Research trial exceeded its duration bound. No successful performance claim is produced.');
        await new Promise(resolve => setTimeout(resolve, 25)); job = await request(`/runs/${job.id}`);
      }
      if (job.status !== 'completed' || !job.result) throw new Error(job.error ?? 'Research trial did not complete.');
      const result = job.result; const observed = controlled.records.filter(row => row.runId === job.id);
      if (result.workloadSha256 !== fingerprint(spec, settings['mock-delay-ms']) || result.accepted !== spec.audience || result.failed !== 0
        || observed.length !== spec.audience || observed.some(row => row.status !== 201)
        || new Set(observed.map(row => row.deliveryId)).size !== spec.audience
        || result.attempts.some(row => !observed.some(seen => seen.deliveryId === row.deliveryId && seen.recipientId === row.recipientId && seen.attempt === row.attempt))) throw new Error('Research provider and pipeline accounting disagree.');
      const names = [`${prefix}.json`, `${prefix}-attempts.ndjson`, `${prefix}-outcomes.csv`, `${prefix}-provider.ndjson`]; traceNames.push(...names);
      await write(names[0]!, JSON.stringify(result, null, 2));
      await write(names[1]!, result.attempts.map(row => JSON.stringify(row)).join('\n') + '\n');
      await write(names[2]!, 'deliveryId,state,attempts,endToEndMs\n' + result.outcomes.map(row => `${row.deliveryId},${row.state},${row.attempts},${row.endToEndMs}`).join('\n') + '\n');
      await write(names[3]!, observed.map(row => JSON.stringify(row)).join('\n') + '\n');
      const { attempts, outcomes, ...metrics } = result; trials.push({ ...metrics, warmup, tracePrefix: prefix });
      if (!warmup) pooledLatencies.push(...outcomes.map(row => row.endToEndMs));
      console.log(`${prefix} (${warmup ? 'warm-up, excluded' : 'measured'}): ${result.accepted} accepted, ${result.elapsedMs.toFixed(1)} ms`);
    }
    if ((await sourceState(projectRoot)).sha256 !== initial.sha256 || await treeHash(join(projectRoot, 'dist')) !== compiledSha256) throw new Error('Sources or compiled tools changed during the experiment.');
    const measured = trials.filter(row => !row.warmup);
    const summary = { schemaVersion: 1, id, status: 'passed', recordedAt: new Date().toISOString(), settings, workloadSha256: fingerprint(spec, settings['mock-delay-ms']),
      sourceTreeSha256: initial.sha256, sourceCommitAtRun: initial.commit, sourceWasClean: initial.clean, compiledSha256,
      environment: { node: process.versions.node, platform: platform(), release: release(), arch: arch(), cpuModel: cpus()[0]?.model, logicalCpus: cpus().length },
      scope: 'exploratory always-on local baseline; memory adapters; phased dispatch; mock HTTP acceptance; no encryption or browser delivery',
      processStartupMs: host.startupMs, hostReused: true, cloudDeploymentEnabled: false, virtualClock: false,
      percentiles: 'nearest rank; pooled per-delivery latencies; trial throughput reported separately',
      aggregate: { accepted: measured.reduce((sum, row) => sum + row.accepted, 0), failed: 0, elapsedMs: distribution(measured.map(row => row.elapsedMs)),
        acceptedPerSecond: distribution(measured.map(row => row.acceptedPerSecond)), endToEndMs: distribution(pooledLatencies) },
      trials, traceFiles: traceNames, limitations: ['No serverless comparison or Azure cost evidence.', 'Process startup is not an Azure cold start.', 'Synthetic audience is capped at 1,000; application limits remain unchanged.', 'HTTP responses are mock provider acceptance, not browser receipt or display.'] };
    await write('summary.json', JSON.stringify(summary, null, 2));
    await write('report.md', `# Local exploratory baseline\n\nStatus: passed. Source SHA-256: \`${initial.sha256}\`.\n\n${summary.scope}.\n\n${settings.repetitions} measured trials; ${settings.warmup} warm-up trials excluded; ${spec.audience} recipients/trial; concurrency ${spec.concurrency}; mock delay ${settings['mock-delay-ms']} ms. The same child process serves all trials; each trial has a fresh in-memory dataset.\n\n| Trial | Warm-up | Accepted | Elapsed ms | Accepted/s | p95 end-to-end ms |\n| --- | --- | --- | --- | --- | --- |\n${trials.map(row => `| ${row.tracePrefix} | ${row.warmup} | ${row.accepted} | ${row.elapsedMs.toFixed(2)} | ${row.acceptedPerSecond.toFixed(2)} | ${row.latencyMs.endToEnd.p95?.toFixed(2)} |`).join('\n')}\n\nPercentiles use nearest rank. End-to-end starts before campaign submission and ends after each delivery's persisted outcome is read. Elapsed time additionally includes final campaign refresh. Seeding is separate; CPU spans seeding and processing. RSS is a process snapshot, not peak memory. Queue wait starts at delivery enqueue and includes remaining fan-out. Provider-request time includes HTTP serialization, transport, mock delay and response consumption. Database counts are adapter calls, not Cosmos request units.\n\nProcess startup: ${host.startupMs.toFixed(2)} ms; measured separately from trial processing.\n\n${summary.limitations.map(value => `- ${value}`).join('\n')}\n\nSee summary.json and trial JSON/NDJSON/CSV files for inputs, environment, raw traces and outcomes. No tokens or subscription keys are recorded.\n`);
  } catch (error) {
    await write('failure.json', JSON.stringify({ id, status: 'failed', message: error instanceof Error ? error.message : 'Research run failed.', completedTrials: trials.length }, null, 2));
    await pointer('failed'); throw error;
  } finally {
    try { await host?.stop(); }
    finally { if (controlled) { try { await write('provider-all.ndjson', controlled.records.map(row => JSON.stringify(row)).join('\n') + '\n'); } finally { await controlled.stop(); } } }
  }
  await pointer('passed'); console.log(`Benchmark report: ${directory}/report.md`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Benchmark failed.'); process.exitCode = 1; });
