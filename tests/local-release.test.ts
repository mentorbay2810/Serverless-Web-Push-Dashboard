import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import webpush from 'web-push';
import { parseLocalEnvironment, projectRoot } from '../tools/environment.js';
import { setupLocal } from '../tools/setup-local.js';
import { acquireLocalLock, localLockStatus, unlockStaleLocalLock } from '../packages/adapters/src/local-lock.js';
import { staticFrontend } from '../apps/functions/src/static-frontend.js';
import { close, httpServer, listen } from '../apps/functions/src/http-server.js';
import { startLocalRuntime } from '../apps/functions/src/local-runtime.js';
import { sourceDigest } from '../tools/release-artifacts.js';

const values = () => {
  const keys = webpush.generateVAPIDKeys();
  return { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, LOCAL_ADMIN_TOKEN: randomBytes(32).toString('base64url') };
};
async function directory(context: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'webpush-release-'));
  context.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('local configuration rejects mismatched keys, remote origins, collisions, and public data paths without printing credentials', () => {
  const valid = values(); const config = parseLocalEnvironment(valid, '/checkout');
  assert.equal(config.webOrigin, 'http://localhost:5173'); assert.equal(config.dataDirectory, '/checkout/.data');
  for (const patch of [{ VAPID_PRIVATE_KEY: values().VAPID_PRIVATE_KEY }, { WEB_ORIGIN: 'https://foreign.example' },
    { WEB_ORIGIN: 'http://localhost:8787' }, { WEB_ORIGIN: 'http://localhost:5173/path' }, { API_PORT: 'NaN' },
    { LOCAL_DATA_DIR: '' }, { LOCAL_DATA_DIR: 'apps/dashboard/public/data' }, { LOCAL_ADMIN_TOKEN: 'short' }]) {
    assert.throws(() => parseLocalEnvironment({ ...valid, ...patch }, '/checkout'), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes(valid.VAPID_PRIVATE_KEY)); return true;
    });
  }
  assert.equal(parseLocalEnvironment({ ...valid, WEB_ORIGIN: 'http://127.0.0.1:5555', API_PORT: '8888' }, '/checkout').port, 8888);
});

test('setup is private and idempotent, preserving quoted existing keys and unrelated configuration', async context => {
  const root = await directory(context); await copyFile(join(projectRoot, '.env.example'), join(root, '.env.example'));
  await setupLocal(root); const original = await readFile(join(root, '.env'), 'utf8');
  await setupLocal(root); assert.equal(await readFile(join(root, '.env'), 'utf8'), original);
  const valid = values(); const quoted = `# preserve me\nVAPID_PUBLIC_KEY="${valid.VAPID_PUBLIC_KEY}"\nVAPID_PRIVATE_KEY='${valid.VAPID_PRIVATE_KEY}'\nLOCAL_ADMIN_TOKEN=${valid.LOCAL_ADMIN_TOKEN}\nAPI_PORT = 8999\n`;
  await writeFile(join(root, '.env'), quoted); await chmod(join(root, '.env'), 0o644);
  await setupLocal(root); assert.equal(await readFile(join(root, '.env'), 'utf8'), quoted);
  assert.equal((await stat(join(root, '.env'))).mode & 0o077, 0);
  assert.equal(await localLockStatus(join(root, '.env.setup.lock')), 'free');
});

test('invalid setup preserves the original file and refuses to follow an environment symlink', async context => {
  const root = await directory(context); const path = join(root, '.env');
  const partial = 'VAPID_PUBLIC_KEY=existing\nVAPID_PRIVATE_KEY=\n'; await writeFile(path, partial);
  await assert.rejects(setupLocal(root), /Both VAPID keys/); assert.equal(await readFile(path, 'utf8'), partial);
  await rm(path); const target = join(root, 'private-source'); await writeFile(target, 'keep unchanged'); await symlink(target, path);
  await assert.rejects(setupLocal(root), /symbolic-link/); assert.equal(await readFile(target, 'utf8'), 'keep unchanged');
});

test('a live data owner cannot be replaced or unlocked; verified stale locks can be recovered explicitly', async context => {
  const root = await directory(context); const path = join(root, 'backend.lock'); const release = await acquireLocalLock(path);
  assert.equal(await localLockStatus(path), 'active'); await assert.rejects(acquireLocalLock(path), /Another process/);
  await assert.rejects(unlockStaleLocalLock(path), /live process/); await release(); await release();
  assert.equal(await localLockStatus(path), 'free');
  await writeFile(path, JSON.stringify({ version: 1, pid: 2147483647, nonce: 'dead-owner' }));
  assert.equal(await localLockStatus(path), 'stale'); assert.equal(await unlockStaleLocalLock(path), true);
  assert.equal(await localLockStatus(path), 'free');
});

test('built frontend serves SPA routes and hashed assets while rejecting private files, escaped symlinks, and foreign hosts', async context => {
  const root = await directory(context); const build = join(root, 'build'); await mkdir(join(build, 'assets'), { recursive: true });
  await writeFile(join(build, 'index.html'), '<div id="root">built</div>'); await writeFile(join(build, 'sw.js'), 'worker');
  await writeFile(join(build, 'assets/app-12345678.js'), 'application'); await writeFile(join(build, '.env'), 'private');
  await writeFile(join(root, 'outside.js'), 'private-outside'); await symlink(join(root, 'outside.js'), join(build, 'escape.js'));
  const handler = staticFrontend(build, 'http://localhost:5173', 'http://127.0.0.1:8787', async request => Response.json({ apiHost: new URL(request.url).host }));
  const get = (path: string, options?: RequestInit) => handler(new Request(`http://localhost:5173${path}`, options));
  assert.equal((await get('/admin')).status, 200); assert.equal((await get('/sw.js')).headers.get('cache-control'), 'no-store');
  const asset = await get('/assets/app-12345678.js'); assert.match(asset.headers.get('cache-control')!, /immutable/); assert.match(asset.headers.get('content-type')!, /javascript/);
  for (const path of ['/.env', '/%2eenv', '/.data/state', '/escape.js', '/package.json', '/missing.js']) assert.equal((await get(path)).status, 404);
  assert.equal((await handler(new Request('http://foreign.example/admin'))).status, 403);
  assert.equal((await get('/admin', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await (await get('/api/health')).json()).apiHost, '127.0.0.1:8787');
  assert.equal((await get('/admin', { method: 'HEAD' })).body, null);
});

test('failed startup closes workers and releases the data lock instead of running behind an occupied port', async context => {
  const root = await directory(context); const blocker = httpServer(async () => Response.json({ ok: true }));
  await listen(blocker, 0, '127.0.0.1'); context.after(() => close(blocker));
  const config = parseLocalEnvironment(values(), root); config.port = (blocker.address() as AddressInfo).port;
  await assert.rejects(startLocalRuntime(config), /port could not be opened/);
  assert.equal(await localLockStatus(join(config.dataDirectory, 'backend.lock')), 'free');
});

test('runtime rejects a second data owner and supports graceful stop and restart', async context => {
  const root = await directory(context); const config = parseLocalEnvironment(values(), root); config.port = 0;
  const runtime = await startLocalRuntime(config); context.after(() => runtime.stop());
  await assert.rejects(startLocalRuntime(config), /Another process/);
  assert.equal((await fetch(`http://127.0.0.1:${runtime.config.port}/api/health`)).status, 200);
  await runtime.stop(); assert.equal(await localLockStatus(join(config.dataDirectory, 'backend.lock')), 'free');
  const restarted = await startLocalRuntime(config); await restarted.stop();
});

test('release source identity detects changed bytes and refuses private paths or symlinks', async context => {
  const root = await directory(context); await writeFile(join(root, 'app.ts'), 'original');
  const before = await sourceDigest(root, ['app.ts']);
  await writeFile(join(root, 'app.ts'), 'modified'); assert.notEqual(await sourceDigest(root, ['app.ts']), before);
  await writeFile(join(root, '.env.example'), 'PUBLIC_EXAMPLE='); assert.ok(await sourceDigest(root, ['.env.example']));
  await writeFile(join(root, '.env'), 'private'); await assert.rejects(sourceDigest(root, ['.env']), /private or generated/);
  for (const path of ['.azure/config', '.azure-profiles/new-account.parameters.json', '.aws/credentials', '.container-backup/config/.env']) {
    await assert.rejects(sourceDigest(root, [path]), /private or generated/);
  }
  await symlink(join(root, 'app.ts'), join(root, 'alias.ts')); await assert.rejects(sourceDigest(root, ['alias.ts']), /regular files/);
  await assert.rejects(sourceDigest(root, ['../private']), /private or generated/);
});

test('paused startup persists both controls before exposing queued work and retains them on restart', async context => {
  const root = await directory(context); const config = parseLocalEnvironment(values(), root); config.port = 0;
  const runtime = await startLocalRuntime(config, { startPaused: true });
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.config.port}/api/local/manage/operations`, { headers: { Authorization: `Bearer ${config.adminToken}` } });
    assert.equal(response.status, 200); const controls = await response.json();
    assert.equal(controls.dispatchPaused, true); assert.equal(controls.sendingPaused, true);
  } finally { await runtime.stop(); }
  const restarted = await startLocalRuntime(config);
  try {
    const response = await fetch(`http://127.0.0.1:${restarted.config.port}/api/local/manage/operations`, { headers: { Authorization: `Bearer ${config.adminToken}` } });
    assert.equal((await response.json()).sendingPaused, true);
  } finally { await restarted.stop(); }
});

test('entry point handles repeated stop signals during an open request and releases ownership', async context => {
  const root = await directory(context); const blocker = httpServer(async () => Response.json({ ok: true }));
  await listen(blocker, 0, '127.0.0.1'); const port = (blocker.address() as AddressInfo).port; await close(blocker);
  const environment = values();
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/functions/src/local-server.ts'], { cwd: projectRoot,
    env: { ...process.env, ...environment, API_PORT: String(port), WEB_ORIGIN: 'http://localhost:5173', LOCAL_DATA_DIR: join(root, '.data'), LOCAL_PIPELINE_MODE: 'queued' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const ended = once(child, 'exit'); let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); }); child.stderr.on('data', chunk => { output += chunk.toString(); });
  let socket: ReturnType<typeof createConnection> | undefined;
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes('Local push API:') && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(output, /Local push API:/);
    socket = createConnection({ host: '127.0.0.1', port }); await once(socket, 'connect');
    socket.write(`POST /api/subscriptions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 8192\r\n\r\n{`);
    await new Promise(resolve => setTimeout(resolve, 30)); child.kill('SIGINT');
    await new Promise(resolve => setTimeout(resolve, 15)); child.kill('SIGINT');
    socket.destroy();
    const result = await Promise.race([ended, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Shutdown timed out.')), 5000); timer.unref(); })]);
    assert.equal(result[0], 0); assert.equal(result[1], null);
    assert.equal(await localLockStatus(join(root, '.data/backend.lock')), 'free');
  } finally { socket?.destroy(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended; }
});
