import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = `swpd-check-${randomBytes(6).toString('hex')}`;
const probe = createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const env = { ...process.env, SWPD_WEB_PORT: String(port) };
const compose = (...args) => execFileSync('docker', ['compose', '-f', 'compose.yaml', '--env-file', 'docker/compose.env.example', '-p', project, ...args],
  { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
const base = `http://127.0.0.1:${port}`;
// Each probe uses a fresh connection, including immediately after a forced kill.
const request = (path, options = {}) => fetch(`${base}${path}`, { ...options,
  headers: { ...options.headers, Connection: 'close' }, signal: AbortSignal.timeout(10000) });
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function session() {
  const output = compose('exec', '-T', 'webpush', 'node', 'dist/tools/admin-login.js');
  const link = /http:\/\/localhost:\d+\/admin#pair=[A-Za-z0-9_-]+/.exec(output)?.[0];
  assert.ok(link, 'Container CLI must issue an administrator link.');
  const response = await request('/api/local/session/exchange', json({ code: new URL(link).hash.slice('#pair='.length) }));
  assert.equal(response.status, 200);
  return (await response.json()).token;
}
let started = false;
let stage = 'startup';
try {
  started = true;
  compose('up', '--wait', '--wait-timeout', '120', '--no-build', 'webpush');
  stage = 'startup access checks';
  const identity = compose('exec', '-T', 'webpush', 'node', '-e', "console.log(process.getuid()); console.log(require('node:fs').existsSync('/app/.env'))").trim().split(/\r?\n/);
  assert.deepEqual(identity, ['1000', 'false'], 'The app must run without root or a baked-in root .env.');
  const service = compose('ps', '--format', 'json', 'webpush').trim();
  const details = service.startsWith('[') ? JSON.parse(service)[0] : JSON.parse(service);
  assert.equal(details.Health, 'healthy');
  assert.throws(() => compose('run', '--rm', '--no-deps', 'webpush', 'node', '-e', 'process.exit(0)'), error => error.status === 1,
    'Another container must not acquire this running data volume.');
  const published = details.Publishers?.filter(item => item.PublishedPort > 0);
  assert.equal(published?.length, 1);
  assert.ok(published.every(item => item.URL === '127.0.0.1' && item.TargetPort === port), 'Only the dashboard may be published on localhost.');
  assert.equal((await request('/admin')).status, 200);
  assert.equal((await request('/sw.js')).status, 200);
  assert.equal((await request('/api/config', { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const wire = httpRequest(`${base}/api/config`, { headers: { Host: 'foreign.invalid' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    wire.once('error', reject); wire.end();
  });
  assert.equal(foreignHostStatus, 403, 'Requests with a foreign Host must be rejected.');
  assert.equal((await request('/api/local/manage/subscriptions')).status, 401);
  const originalConfig = await (await request('/api/config')).json();
  const curve = createECDH('prime256v1'); curve.generateKeys();
  const response = await request('/api/subscriptions', json({ subscription: {
    endpoint: `https://fcm.googleapis.com/wp/container-fixture-${project}`, expirationTime: null,
    keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  } }));
  assert.equal(response.status, 201);
  const subscription = await response.json();
  stage = 'administrator session';
  const oldSession = await session();
  const draft = await request('/api/local/manage/campaigns', { ...json({ name: 'Container persistence check',
    content: { title: 'Unsent fixture', body: 'This draft is never activated.', url: '/' }, audience: { type: 'all' } }),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oldSession}`, 'Idempotency-Key': project } });
  assert.equal(draft.status, 201);
  const saved = await draft.json();
  stage = 'forced crash and restart';
  // Abrupt termination leaves the PID lock behind. The kernel volume lock must
  // release, and a new container process must safely reclaim its dedicated data.
  compose('kill', '--signal', 'SIGKILL', 'webpush');
  compose('up', '--wait', '--wait-timeout', '120', '--no-build', 'webpush');
  stage = 'persisted state and session revocation';
  const restartedConfig = await (await request('/api/config')).json();
  assert.equal(restartedConfig.vapidPublicKey, originalConfig.vapidPublicKey);
  assert.equal((await request('/api/local/manage/me', { headers: { Authorization: `Bearer ${oldSession}` } })).status, 401);
  const newSession = await session();
  const stored = await request(`/api/local/manage/campaigns/${saved.id}`, { headers: { Authorization: `Bearer ${newSession}` } });
  assert.equal(stored.status, 200);
  assert.equal((await stored.json()).state, 'draft');
  assert.equal((await request(`/api/subscriptions/${subscription.id}`, { headers: { Authorization: `Bearer ${subscription.token}` } })).status, 200);
  assert.equal((await request(`/api/subscriptions/${subscription.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${subscription.token}` } })).status, 200);
  console.log('Container smoke passed: non-root startup, localhost access, administrator sign-in, persistent keys/subscriber/draft, crash recovery, and revoked sessions. No provider sends or Azure calls.');
} catch (error) {
  // Child command output can contain a one-use administrator link; keep it private.
  console.error(`Container smoke failed during ${stage}: ${error instanceof assert.AssertionError ? error.message : error.cause?.code ?? error.code ?? `${error.name}, command exit ${error.status ?? 'unknown'}`}`);
  if (error.stderr) console.error(String(error.stderr).slice(-1500));
  process.exitCode = 1;
} finally {
  if (started) compose('down', '--volumes', '--remove-orphans');
}
