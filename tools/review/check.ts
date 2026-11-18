import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { distribution } from '../benchmark/model.js';
import { projectRoot } from '../environment.js';
import { parsePlan, schedule } from '../research/plan.js';

export async function checkReviewSummary() {
  const snapshot = JSON.parse(await readFile(join(projectRoot, 'docs/review/evidence-summary.json'), 'utf8'));
  const m = snapshot.measurement; const plan = parsePlan(m.plan); const cells = schedule(plan);
  const key = (row: { audience: number; concurrency: number; condition: string }) => `${row.audience}/${row.concurrency}/${row.condition}`;
  if (snapshot.schemaVersion !== 1 || snapshot.status !== 'local_review_evidence' || !/^[a-f0-9]{40}$/.test(m.sourceCommit)
    || !/^[a-f0-9]{64}$/.test(snapshot.analysisSha256) || snapshot.groups.length !== cells.length || new Set(snapshot.groups.map(key)).size !== cells.length) throw new Error('Invalid public review summary.');
  const measured = snapshot.samples.filter((row: { warmup: boolean }) => !row.warmup); const warmups = snapshot.samples.filter((row: { warmup: boolean }) => row.warmup);
  for (const cell of cells) {
    const rows = measured.filter((row: Parameters<typeof key>[0]) => key(row) === key(cell)); const group = snapshot.groups.find((row: Parameters<typeof key>[0]) => key(row) === key(cell));
    if (!group || rows.length !== plan.repetitions || rows.some((row: { accepted: number }) => row.accepted !== cell.audience)) throw new Error('Incomplete condition in the review evidence.');
    for (const field of ['elapsedMs', 'acceptedPerSecond', 'cpuMs', 'rssAfterBytes']) {
      if (JSON.stringify(group[field]) !== JSON.stringify(distribution(rows.map((row: Record<string, number>) => row[field]!)))) throw new Error('The public statistics differ from their trial values.');
    }
  }
  const total = (rows: { accepted: number }[]) => rows.reduce((sum, row) => sum + row.accepted, 0);
  if (measured.length !== m.counts.measuredTrials || warmups.length !== m.counts.warmupTrials || total(measured) !== m.counts.measuredAccepted
    || total(warmups) !== m.counts.warmupAccepted || m.counts.scenarios !== cells.length || m.counts.failed !== 0) throw new Error('Review counts are inconsistent.');
  if (m.cost.cloudDeploymentEnabled !== false || m.cost.measuredAzureCostINR !== null || m.cost.measuredLocalEnergyCostINR !== null) throw new Error('The review must preserve unmeasured monetary values.');
  const policy = JSON.parse(await readFile(join(projectRoot, 'infra/deployment-policy.json'), 'utf8'));
  if (policy.cloudDeploymentEnabled !== false || policy.monthlyBudgetINR !== 100 || policy.strictSpendingLimitRequired !== true) throw new Error('The cloud-off budget decision changed.');
  const tests = snapshot.historicalValidation.tests;
  if (tests.total !== tests.passed || tests.passed !== tests.junitCases || snapshot.historicalValidation.sourceCommit !== m.sourceCommit) throw new Error('Historical test provenance differs from the measured candidate.');
  const report = await readFile(join(projectRoot, 'docs/review/report.md'), 'utf8');
  const number = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const group of snapshot.groups) {
    const row = `| ${group.audience} | ${group.concurrency} | ${group.condition === 'fresh-process' ? 'Fresh' : 'Reused'} | ${number(group.elapsedMs.p50)} | ${number(group.acceptedPerSecond.p50)} | ${number(group.endToEndMs.p95)} |`;
    if (!report.includes(row)) throw new Error('The report table differs from the frozen numerical summary.');
  }
  if (!report.includes(m.sourceCommit) || !report.includes(m.sourceTreeSha256)) throw new Error('The report is missing its measurement identity.');
  const references = JSON.parse(await readFile(join(projectRoot, 'docs/review/references.json'), 'utf8')) as { id: number; url: string }[];
  for (const ref of references) if (!report.includes(ref.url)) throw new Error('The reference list and report differ.');
  return snapshot;
}
if (process.argv[1]?.endsWith('/check.ts') || process.argv[1]?.endsWith('/check.js')) {
  checkReviewSummary().then(snapshot => console.log(`Public review summary is consistent: ${snapshot.measurement.counts.measuredTrials} measured local trials. Raw evidence remains a separate verification.`))
    .catch(error => { console.error(error instanceof Error ? error.message : 'Review check failed.'); process.exitCode = 1; });
}
