import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { distribution } from '../benchmark/model.js';
import { sha256 } from '../release-artifacts.js';
import { cellKey, collect, type Sample } from './evidence.js';

export function summarize(data: Awaited<ReturnType<typeof collect>>) {
  const measured = data.samples.filter(row => !row.warmup); const warmups = data.samples.filter(row => row.warmup);
  const groups = data.inputs.order.map(cell => {
    const rows = measured.filter(row => cellKey(row) === cellKey(cell));
    if (rows.length !== data.inputs.plan.repetitions) throw new Error('A condition is missing measured repetitions.');
    return { ...cell, trials: rows.length, accepted: rows.reduce((sum, row) => sum + row.accepted, 0),
      elapsedMs: distribution(rows.map(row => row.elapsedMs)), acceptedPerSecond: distribution(rows.map(row => row.acceptedPerSecond)),
      endToEndMs: distribution(rows.flatMap(row => row.endToEndMs)), queueWaitMs: distribution(rows.flatMap(row => row.queueWaitMs)), providerRequestMs: distribution(rows.flatMap(row => row.providerRequestMs)),
      seedMs: distribution(rows.map(row => row.seedMs)), cpuMs: distribution(rows.map(row => row.cpuMs)), rssAfterBytes: distribution(rows.map(row => row.rssAfterBytes)),
      databaseOperations: Object.fromEntries(Object.keys(rows[0]!.databaseOperations).map(key => [key, distribution(rows.map(row => row.databaseOperations[key as keyof Sample['databaseOperations']]))])),
      startupMs: distribution(data.startups.filter(row => cellKey(row) === cellKey(cell)).map(row => row.ms)) };
  }).sort((a, b) => a.concurrency - b.concurrency || a.audience - b.audience || a.condition.localeCompare(b.condition));
  return { schemaVersion: 1, status: 'local_analysis_passed', experimentId: data.inputs.id, sourceTreeSha256: data.inputs.sourceTreeSha256,
    sourceCommit: data.inputs.sourceCommit, sourceWasClean: data.inputs.sourceWasClean, compiledSha256: data.inputs.compiledSha256, evidenceManifestSha256: data.evidenceManifestSha256,
    plan: data.inputs.plan, environment: data.environment, groups, startups: data.startups,
    counts: { scenarios: groups.length, measuredTrials: measured.length, warmupTrials: warmups.length, measuredAccepted: measured.reduce((sum, row) => sum + row.accepted, 0),
      warmupAccepted: warmups.reduce((sum, row) => sum + row.accepted, 0), failed: 0 },
    cost: { cloudDeploymentEnabled: false, azureResourcesProvisionedBySuite: [], measuredAzureCostINR: null, measuredLocalEnergyCostINR: null,
      status: 'unmeasured; local execution only; no invoice or cloud usage queried' },
    scope: 'local exploratory baseline; memory adapters; phased fan-out; loopback mock HTTP; no Web Push encryption',
    statistics: 'nearest-rank percentiles; pooled delivery latency; medians and ranges of trial throughput; no significance or confidence-interval claims',
    limitations: ['Fresh and reused conditions change both the driver/mock process and child host lifecycle; effects cannot be attributed solely to host reuse.',
      'Five repetitions in the default plan describe this session and do not establish population capacity or independent per-delivery samples.',
      'Startup samples: one host per reused scenario versus one per fresh repetition. Startup is excluded from pipeline elapsed time; neither is an Azure cold start.',
      'Mock delay and machine scheduling can dominate local timing. Different audiences also change campaign count and adapter work.',
      'No Azure/serverless comparison, costs, durability/settlement measurements, real-browser delivery or production scaling result.'],
    samples: data.samples.map(({ endToEndMs, queueWaitMs, providerRequestMs, ...row }) => ({ ...row, endToEndP95Ms: distribution(endToEndMs).p95, queueWaitP95Ms: distribution(queueWaitMs).p95, providerRequestP95Ms: distribution(providerRequestMs).p95 })) };
}
const csv = (rows: (string | number | boolean | null)[][]) => rows.map(row => row.map(value => value === null ? '' : typeof value === 'string' ? `"${value.replaceAll('"', '""')}"` : String(value)).join(',')).join('\n') + '\n';
export async function writeAnalysis(directory: string) {
  const evidence = await collect(directory); const analysis = summarize(evidence);
  const f = (value: number | null) => value === null ? 'unmeasured' : value.toFixed(2);
  const files: Record<string, string> = {
    'analysis.json': JSON.stringify(analysis, null, 2),
    'trials.csv': csv([['audience', 'concurrency', 'condition', 'experimentId', 'runId', 'repetition', 'warmup', 'accepted', 'elapsedMs', 'acceptedPerSecond', 'endToEndP95Ms', 'queueWaitP95Ms', 'providerRequestP95Ms', 'seedMs', 'cpuMs', 'rssBeforeBytes', 'rssAfterBytes'],
      ...analysis.samples.map(row => [row.audience, row.concurrency, row.condition, row.experimentId, row.runId, row.repetition, row.warmup, row.accepted, row.elapsedMs, row.acceptedPerSecond, row.endToEndP95Ms, row.queueWaitP95Ms, row.providerRequestP95Ms, row.seedMs, row.cpuMs, row.rssBeforeBytes, row.rssAfterBytes])]),
    'conditions.csv': csv([['audience', 'concurrency', 'condition', 'trials', 'accepted', 'elapsedMedianMs', 'throughputMedian', 'throughputMin', 'throughputMax', 'pooledEndToEndP95Ms', 'cpuMedianMs', 'rssAfterMedianBytes', 'startupSamples', 'startupMedianMs'],
      ...analysis.groups.map(row => [row.audience, row.concurrency, row.condition, row.trials, row.accepted, row.elapsedMs.p50, row.acceptedPerSecond.p50, row.acceptedPerSecond.min, row.acceptedPerSecond.max, row.endToEndMs.p95, row.cpuMs.p50, row.rssAfterBytes.p50, row.startupMs.count, row.startupMs.p50])]),
    'costs.csv': csv([['component', 'measurementStatus', 'measuredCostINR', 'reason'],
      ...['Azure Functions', 'Cosmos DB', 'Service Bus', 'Azure storage', 'Azure network/telemetry'].map(name => [name, 'not run', null, 'No cloud experiment or invoice query; do not infer a zero project bill.'] as (string | null)[]),
      ['Local compute/electricity', 'unmeasured', null, 'CPU and RSS were observed; energy and monetary rates were not measured.']]),
    'report.md': `# Phase 7 local experimental results\n\nStatus: ${analysis.status}. Source commit: \`${analysis.sourceCommit}\`; source SHA-256: \`${analysis.sourceTreeSha256}\`.\n\n${analysis.scope}.\n\n${analysis.counts.scenarios} scenarios, ${analysis.counts.measuredTrials} measured trials and ${analysis.counts.measuredAccepted} measured mock acceptances; ${analysis.counts.warmupTrials} warm-ups (${analysis.counts.warmupAccepted} acceptances) excluded. Every raw attempt, provider observation and final outcome was cross-checked. Failed/incomplete experiments cannot issue this report.\n\n## Observed results\n\n| Audience | Workers | Process condition | Trials | Median elapsed ms | Median accepted/s | Range accepted/s | Pooled p95 end-to-end ms |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${analysis.groups.map(row => `| ${row.audience} | ${row.concurrency} | ${row.condition} | ${row.trials} | ${f(row.elapsedMs.p50)} | ${f(row.acceptedPerSecond.p50)} | ${f(row.acceptedPerSecond.min)}–${f(row.acceptedPerSecond.max)} | ${f(row.endToEndMs.p95)} |`).join('\n')}\n\nThese are descriptive measurements of this session. Inspect raw trial points and ranges before drawing conclusions. A larger audience changes campaign count and database work; results do not isolate compute scaling. Fresh/reused conditions also change driver/mock reuse, so their difference cannot be attributed solely to the child host.\n\n## Measurement and reproducibility\n\nThe plan fixes payload, endpoint seed, requested mock delay and worker settings. Scenario blocks are shuffled using the recorded order seed; repetitions remain within each block. Fresh runs start a new driver/mock and child host for each measured trial without a workload warm-up. Reused runs exclude the configured warm-ups, then measure the same driver/mock and child host against fresh in-memory datasets. This order does not eliminate thermal, scheduling or time drift.\n\nPipeline elapsed begins before campaign submission and ends after final campaign refresh; it excludes dataset seeding and process startup. End-to-end per delivery ends after its persisted outcome read. Queue wait includes remaining fan-out before worker dequeue. Provider time includes loopback HTTP and requested mock delay. CPU includes seeding and processing; RSS snapshots are not peak memory. Adapter call counts are not Cosmos RU.\n\nPercentiles use nearest rank. The table pools measured delivery latencies; per-trial p95 values remain in trials.csv. Throughput medians/ranges use trial values. Deliveries within a trial are correlated; no confidence interval, significance or production capacity claim is made. Startup is separate: one observation per reused scenario, one per fresh repetition, with counts in conditions.csv. It is not an Azure cold-start measurement.\n\ninputs.json records the complete plan, seeded order and executions. evidence.json hashes all raw files. analysis-files.json hashes this report and the derived JSON/CSV. See raw/<experiment-id>/ for trial JSON, provider/attempt NDJSON and outcome CSV; warm-ups are retained. Hashes detect changed files and are not a signature of authenticity.\n\n## Cost and cloud status\n\nThe suite provisions no Azure resources and makes no Azure API calls. No Azure usage/invoice, local electricity use or monetary rates were measured. Monetary fields are null/blank, not zero; costs.csv lists the unmeasured components. Existing account charges cannot be inferred from this run. Cloud deployment stays disabled under the strict INR 100 decision. A cloud/serverless performance and cost comparison remains pending.\n\n## Remaining limits\n\n${analysis.limitations.map(value => `- ${value}`).join('\n')}\n- Actual UI/OS notification/click and cross-browser checks remain pending.\n- Audiences above 1,000 and formal cloud experiments remain deferred.\n\nCharts can be generated from analysis.json with tools/research/plot.py. They show measured trial points, medians and observed ranges, without interpolated capacity claims.\n`,
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content, { mode: 0o600 });
  await writeFile(join(directory, 'analysis-files.json'), JSON.stringify({ schemaVersion: 1, files: Object.entries(files).map(([path, content]) => ({ path, sha256: sha256(content) })) }, null, 2), { mode: 0o600 });
  return analysis;
}
export async function verifyAnalysis(directory: string) {
  const data = await collect(directory); const expected = summarize(data);
  const actual = JSON.parse(await readFile(join(directory, 'analysis.json'), 'utf8'));
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Derived analysis differs from raw evidence.');
  const manifest = JSON.parse(await readFile(join(directory, 'analysis-files.json'), 'utf8')) as { files: { path: string; sha256: string }[] };
  if (manifest.files.length !== 5 || new Set(manifest.files.map(row => row.path)).size !== 5) throw new Error('Incomplete derived-file manifest.');
  for (const row of manifest.files) {
    if (!['analysis.json', 'trials.csv', 'conditions.csv', 'costs.csv', 'report.md'].includes(row.path) || sha256(await readFile(join(directory, row.path))) !== row.sha256) throw new Error('Derived report hash mismatch.');
  }
  return actual;
}
