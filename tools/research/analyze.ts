import { resolve } from 'node:path';
import { verifyAnalysis, writeAnalysis } from './report.js';

try {
  const args = process.argv.slice(2);
  if (!args[0] || args.length > 2 || (args[1] && args[1] !== '--verify')) throw new Error('Use research:analyze -- <experiment-directory> [--verify].');
  const directory = resolve(args[0]); const report = await (args[1] === '--verify' ? verifyAnalysis(directory) : writeAnalysis(directory));
  console.log(`Research ${args[1] ? 'verification' : 'analysis'} passed: ${report.counts.measuredTrials} measured trials. ${directory}/report.md`);
} catch (error) { console.error(error instanceof Error ? error.message : 'Research analysis failed.'); process.exitCode = 1; }
