import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { close, listen } from '../apps/functions/src/http-server.js';
import { baselineHost, type BaselineJob } from '../tools/baseline/host.js';
import { executeRun } from '../tools/baseline/engine.js';
import { distribution, fingerprint, loopbackOrigin, workload, type Attempt } from '../tools/benchmark/model.js';
import { mockProvider } from '../tools/benchmark/mock-provider.js';
import { MockHttpSender } from '../tools/benchmark/mock-sender.js';
import type { BrowserSubscription, PushPayload } from '../packages/core/src/index.js';

const token = () => randomBytes(32).toString('base64url');
const spec = { audience: 20, seed: 42, concurrency: 2 };
const subscription: BrowserSubscription = { endpoint: 'https://must-never-be-contacted.invalid/private', expirationTime: null, keys: { p256dh: 'synthetic', auth: 'synthetic' } };
const payload: PushPayload = { version: 1, sentAt: new Date().toISOString(), notificationId: 'a'.repeat(64), title: 'Synthetic', body: 'Only a mock can receive this', url: '/' };

test('research workloads are bounded and fingerprints identify comparable inputs', () => {
  for (const value of [null, [], { ...spec, audience: 1001 }, { ...spec, audience: 0 }, { ...spec, seed: -1 }, { ...spec, concurrency: 9 }, { ...spec, origin: 'https://external.example' }]) assert.throws(() => workload(value));
  assert.deepEqual(workload(spec), spec);
  assert.equal(fingerprint(spec, 2), fingerprint({ concurrency: 2, seed: 42, audience: 20 }, 2));
  assert.notEqual(fingerprint(spec, 2), fingerprint({ ...spec, seed: 43 }, 2));
  assert.notEqual(fingerprint(spec, 2), fingerprint(spec, 3));
});

test('latency percentiles use nearest rank and never invent empty measurements', () => {
  assert.deepEqual(distribution([100, 1, 3, 2]), { count: 4, mean: 26.5, min: 1, p50: 2, p95: 100, p99: 100, max: 100 });
  assert.equal(distribution([]).p95, null); assert.equal(distribution([]).mean, null);
  assert.throws(() => distribution([NaN])); assert.throws(() => distribution([-1]));
});

test('mock sender only accepts a literal loopback target and never follows redirects', async context => {
  for (const origin of ['http://localhost:8000', 'http://127.0.0.1:80', 'https://127.0.0.1:8000', 'http://127.0.0.1:8000/push', 'http://user:pass@127.0.0.1:8000', 'https://external.example', 'http://127.0.0.1.evil.example:8000']) assert.throws(() => loopbackOrigin(origin));
  let escaped = 0;
  const sink = createServer((_request, response) => { escaped++; response.end(); }); await listen(sink, 0, '127.0.0.1'); context.after(() => close(sink));
  const credential = token(); const provider = await mockProvider({ token: credential, delayMs: 0,
    respond: () => ({ status: 302, headers: { Location: `http://127.0.0.1:${(sink.address() as AddressInfo).port}/escape` } }) }); context.after(provider.stop);
  const attempts: Attempt[] = []; const sender = new MockHttpSender({ origin: provider.origin, token: credential, runId: 'redirect-test', queueWait: () => 0, record: row => attempts.push(row) });
  await assert.rejects(sender.send(subscription, payload), (error: { statusCode?: number }) => error.statusCode === 503);
  assert.equal(escaped, 0); assert.equal(provider.records.length, 1); assert.equal(attempts[0]?.status, 0);
});

test('controlled provider denies unauthorized or browser requests and exposes bounded retry faults', async context => {
  const credential = token(); let status = 503;
  const provider = await mockProvider({ token: credential, delayMs: 0, respond: () => ({ status, headers: { 'Retry-After': '2' } }) }); context.after(provider.stop);
  assert.equal((await fetch(`${provider.origin}/push`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${provider.origin}/push`, { headers: { Authorization: `Bearer ${credential}`, Origin: 'https://foreign.example' } })).status, 403);
  assert.equal(provider.records.length, 0);
  const traces: Attempt[] = []; const sender = new MockHttpSender({ origin: provider.origin, token: credential, runId: 'fault-test', queueWait: () => 12, record: row => traces.push(row) });
  await assert.rejects(sender.send(subscription, payload), (error: { statusCode?: number; headers?: Record<string, string> }) => error.statusCode === 503 && error.headers?.['retry-after'] === '2');
  status = 410; await assert.rejects(sender.send(subscription, payload), (error: { statusCode?: number }) => error.statusCode === 410);
  assert.deepEqual(traces.map(row => [row.attempt, row.status, row.queueWaitMs]), [[1, 503, 12], [2, 410, 12]]);
  assert.ok(!JSON.stringify(provider.records).includes(credential)); assert.ok(!JSON.stringify(provider.records).includes(subscription.endpoint));
});

test('baseline completes multiple campaign batches with one trace per synthetic delivery', async context => {
  const credential = token(); const provider = await mockProvider({ token: credential, delayMs: 0 }); context.after(provider.stop);
  const result = await executeRun('multi-batch-test', { ...spec, audience: 101 }, { ...provider, token: credential, delayMs: 0 }, new AbortController().signal);
  assert.equal(result.accepted, 101); assert.equal(result.failed, 0); assert.equal(provider.records.length, 101);
  assert.equal(new Set(result.outcomes.map(row => row.deliveryId)).size, 101);
  assert.ok(result.outcomes.every(row => row.state === 'accepted' && row.attempts === 1 && row.endToEndMs >= 0));
  assert.equal(result.latencyMs.endToEnd.count, 101); assert.equal(result.virtualClock, false);
  assert.ok(result.elapsedMs >= result.dispatchMs); assert.ok(result.databaseOperations.transactions > 101);
  assert.ok(result.scope.includes('no Web Push encryption'));
});

test('faulty or aborted baseline runs fail instead of producing healthy timing results', async context => {
  const credential = token(); const provider = await mockProvider({ token: credential, delayMs: 0, respond: () => ({ status: 410 }) }); context.after(provider.stop);
  await assert.rejects(executeRun('failed-run-test', { ...spec, audience: 1 }, { ...provider, token: credential, delayMs: 0 }, new AbortController().signal), /did not accept every delivery/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(executeRun('aborted-run-test', spec, { ...provider, token: credential, delayMs: 0 }, aborted.signal), /aborted/);
  await assert.rejects(executeRun('oversize-run-test', { ...spec, audience: 1001 }, { ...provider, token: credential, delayMs: 0 }, aborted.signal));
  assert.equal(provider.records.length, 1);
});

test('baseline host authenticates, rejects overlapping jobs and reports completed job results', async context => {
  const credential = token(); const provider = await mockProvider({ token: credential, delayMs: 10 }); context.after(provider.stop);
  const apiToken = token(); const host = await baselineHost({ token: apiToken, provider: { ...provider, token: credential, delayMs: 10 } }); context.after(host.stop);
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${host.origin}${path}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${apiToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('/health', undefined, { Authorization: 'Bearer incorrect' })).status, 401);
  assert.equal((await request('/health', undefined, { Origin: 'http://localhost:5173' })).status, 403);
  assert.equal((await request('/runs', { ...spec, audience: 1001 })).status, 400);
  assert.equal((await request('/runs', spec, { 'Content-Type': 'text/plain' })).status, 415);
  const start = await request('/runs', spec); assert.equal(start.status, 202);
  let job = await start.json() as BaselineJob;
  assert.equal((await request('/runs', spec)).status, 409);
  for (let index = 0; job.status === 'running' && index < 200; index++) {
    await new Promise(resolve => setTimeout(resolve, 10)); job = await (await request(`/runs/${job.id}`)).json() as BaselineJob;
  }
  assert.equal(job.status, 'completed'); assert.equal(job.result?.accepted, 20);
  assert.equal((await request('/runs/missing')).status, 404);
  await host.stop(); await host.stop();
});
