import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checkReviewSummary } from './check.js';
import { verifyAnalysis } from '../research/report.js';
import { sha256 } from '../release-artifacts.js';
import { projectRoot } from '../environment.js';

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--evidence')) throw new Error('Use review:verify [--evidence <completed-research-directory>].');
  const snapshot = await checkReviewSummary(); const directory = args[1] ? resolve(args[1]) : join(projectRoot, '.cache/research', snapshot.measurement.experimentId);
  const analysis = await verifyAnalysis(directory);
  if (sha256(await readFile(join(directory, 'analysis.json'))) !== snapshot.analysisSha256 || analysis.sourceTreeSha256 !== snapshot.measurement.sourceTreeSha256) throw new Error('The review summary does not match the verified raw study.');
  const artifacts = [];
  for (const item of snapshot.artifacts as { path: string; sha256: string }[]) {
    if (!item.path.startsWith('.cache/') || item.path.split('/').includes('..')) throw new Error('Invalid artifact path.');
    if (sha256(await readFile(join(projectRoot, item.path))) !== item.sha256) throw new Error('A frozen evidence archive changed.');
    artifacts.push(item);
  }
  const output = join(projectRoot, '.cache/review-inputs'); await mkdir(output, { recursive: true });
  await writeFile(join(output, 'verified.json'), JSON.stringify({ schemaVersion: 1, status: 'verified_local_review_inputs', checkedAt: new Date().toISOString(),
    experimentId: analysis.experimentId, analysisSha256: snapshot.analysisSha256, measuredSourceCommit: analysis.sourceCommit, artifacts }, null, 2), { mode: 0o600 });
  console.log('Review inputs verified against raw trials and both frozen archives. No cloud or browser claims were added.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Review inputs could not be verified.'); process.exitCode = 1; }
