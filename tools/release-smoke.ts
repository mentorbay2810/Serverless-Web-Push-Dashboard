import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import webpush from 'web-push';
import type { PushPayload } from '../packages/core/src/index.js';
import type { startLocalRuntime as Runtime } from '../apps/functions/src/local-runtime.js';
import { projectRoot } from './environment.js';

async function main() {
  // Import the compiled backend, not the TypeScript source under test.
  const { startLocalRuntime } = await import(pathToFileURL(join(projectRoot, 'dist/apps/functions/src/local-runtime.js')).href) as { startLocalRuntime: typeof Runtime };
  const directory = await mkdtemp(join(tmpdir(), 'webpush-built-smoke-'));
  const config = { port: 0, webOrigin: 'http://127.0.0.1:0', dataDirectory: directory, adminToken: randomBytes(32).toString('base64url'),
    vapid: { ...webpush.generateVAPIDKeys(), subject: 'mailto:release-test@example.com' } };
  let delivered: PushPayload | undefined; let sends = 0;
  const options = { frontendDirectory: join(projectRoot, 'apps/dashboard/dist'), sender: { async send(_subscription: unknown, payload: PushPayload) {
    sends++; delivered = payload; return { statusCode: 202 };
  } } };
  let runtime: Awaited<ReturnType<typeof Runtime>> | undefined;
  try {
    runtime = await startLocalRuntime(config, options);
    let origin = runtime.config.webOrigin;
    async function request(path: string, method = 'GET', token?: string, body?: unknown, extra: Record<string, string> = {}) {
      const response = await fetch(`${origin}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : undefined };
    }
    const page = await request('/admin'); assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-store');
    const scripts = [...page.text.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]!);
    assert.ok(scripts.length >= 2);
    for (const path of scripts) assert.equal((await request(path)).status, 200);
    assert.equal((await request('/sw.js')).status, 200);
    for (const path of ['/.env', '/.data/phase2-documents.json', '/package.json', '/assets/missing.js']) assert.equal((await request(path)).status, 404);
    assert.equal((await request('/api/config', 'GET', undefined, undefined, { Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await request('/api/subscriptions', 'POST', undefined, { oversized: 'x'.repeat(9000) })).status, 413);
    const issued = await request('/api/local/session', 'POST', config.adminToken); assert.equal(issued.status, 201);
    const code = new URLSearchParams(new URL(issued.data.url).hash.slice(1)).get('pair');
    const session = await request('/api/local/session/exchange', 'POST', undefined, { code }); assert.equal(session.status, 200);
    assert.equal((await request('/api/local/session/exchange', 'POST', undefined, { code })).status, 401);
    const token = session.data.token as string;
    const manage = (path: string, method = 'GET', body?: unknown, extra?: Record<string, string>) => request(`/api/local/manage${path}`, method, token, body, extra);
    assert.equal((await manage('/me')).status, 200);
    assert.equal((await request('/api/admin/me', 'GET', token)).status, 401);
    let controls = await manage('/operations');
    controls = await manage('/operations', 'PATCH', { dispatchPaused: true, sendingPaused: true }, { 'If-Match': controls.headers.get('etag')! }); assert.equal(controls.status, 200);
    controls = await manage('/operations', 'PATCH', { dispatchPaused: false, sendingPaused: false }, { 'If-Match': controls.headers.get('etag')! }); assert.equal(controls.status, 200);
    const curve = createECDH('prime256v1'); curve.generateKeys();
    const registered = await request('/api/subscriptions', 'POST', undefined, { subscription: { endpoint: 'https://fcm.googleapis.com/wp/isolated-release-fixture', expirationTime: null,
      keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } } }); assert.equal(registered.status, 201);
    const created = await manage('/campaigns', 'POST', { name: 'Isolated candidate smoke', content: { title: 'Release fixture', body: 'No real provider request', url: '/' },
      audience: { type: 'selected', subscriptionIds: [registered.data.id] } }, { 'Idempotency-Key': randomUUID() }); assert.equal(created.status, 201);
    const id = created.data.id as string;
    const preview = await manage(`/campaigns/${id}/preview`, 'POST', {});
    assert.equal((await manage(`/campaigns/${id}/send`, 'POST', { fingerprint: preview.data.fingerprint }, { 'If-Match': preview.headers.get('etag')!, 'Idempotency-Key': randomUUID() })).status, 202);
    let report;
    for (let attempt = 0; attempt < 50; attempt++) {
      report = await manage(`/campaigns/${id}`);
      if (report.data.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(report!.data.state, 'completed'); assert.equal(sends, 1); assert.ok(delivered?.reporting);
    // Synthetic observations belong only to this disposable store.
    const eventPath = new URL(delivered.reporting.url).pathname;
    for (const type of ['received', 'received', 'clicked']) assert.equal((await request(eventPath, 'POST', delivered.reporting.token, { type })).status, 200);
    report = await manage(`/campaigns/${id}`);
    assert.deepEqual(report.data.metrics, { targeted: 1, accepted: 1, received: 1, clicked: 1, failed: 0, expired: 0, cancelled: 0 });
    const owner = registered.data.token as string;
    await runtime.stop(); runtime = await startLocalRuntime(config, options); origin = runtime.config.webOrigin;
    assert.equal((await manage('/me')).status, 401);
    assert.equal((await request(`/api/subscriptions/${registered.data.id}`, 'GET', owner)).status, 200);
    const newLink = await request('/api/local/session', 'POST', config.adminToken);
    const newCode = new URLSearchParams(new URL(newLink.data.url).hash.slice(1)).get('pair');
    const newSession = await request('/api/local/session/exchange', 'POST', undefined, { code: newCode });
    const persisted = await request(`/api/local/manage/campaigns/${id}`, 'GET', newSession.data.token);
    assert.equal(persisted.data.metrics.clicked, 1); assert.equal(sends, 1);
    assert.equal((await request('/api/local/session/logout', 'POST', newSession.data.token)).status, 200);
    assert.equal((await request('/api/local/manage/me', 'GET', newSession.data.token)).status, 401);
    console.log(JSON.stringify({ status: 'passed', scope: 'compiled local HTTP application', provider: 'controlled test double', browserEvents: 'synthetic in disposable storage',
      checks: ['built routes and assets', 'private path rejection', 'session replay and revocation', 'pause/resume', 'reviewed send', 'deduplicated observations', 'restart persistence'] }, null, 2));
  } finally { await runtime?.stop(); await rm(directory, { recursive: true, force: true }); }
}
main().catch(() => { console.error('The isolated built-application smoke check failed. No real provider was contacted.'); process.exitCode = 1; });
