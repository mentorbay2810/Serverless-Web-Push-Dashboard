import { spawn } from 'node:child_process';
import { loadEnvironment, projectRoot } from './environment.js';

try {
  const environment = loadEnvironment();
  const children = [
    spawn(process.execPath, ['--import', 'tsx', '--watch', 'apps/functions/src/local-server.ts'], {
      cwd: projectRoot, stdio: 'inherit', env: process.env, detached: process.platform !== 'win32',
    }),
    spawn('npm', ['run', 'dev:web'], {
      cwd: projectRoot, stdio: 'inherit', env: { ...process.env, WEBPUSH_API_PORT: String(environment.port) }, detached: process.platform !== 'win32',
    }),
  ];
  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    children.forEach(child => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch { /* A child may already have exited. */ }
    });
    process.exitCode = code;
  };
  for (const child of children) {
    child.on('error', error => { console.error(error.message); stop(1); });
    child.on('exit', code => { if (!stopping) stop(code ?? 1); });
  }
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
