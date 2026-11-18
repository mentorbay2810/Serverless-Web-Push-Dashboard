import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from './environment.js';

const directory = join(projectRoot, '.cache/validation'); await mkdir(directory, { recursive: true });
const junit = join(directory, 'junit.xml'); await rm(junit, { force: true });
const tests = (await readdir(join(projectRoot, 'tests'))).filter(name => name.endsWith('.test.ts')).sort().map(name => join(projectRoot, 'tests', name));
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-reporter-destination=stdout',
  '--test-reporter=junit', `--test-reporter-destination=${junit}`, ...tests], { cwd: projectRoot, stdio: 'inherit' });
if (result.error) console.error('The test runner could not start.');
process.exitCode = result.status ?? 1;
