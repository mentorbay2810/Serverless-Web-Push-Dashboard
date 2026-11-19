import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../apps/dashboard/public/sw.js', import.meta.url), 'utf8');

function worker(options: { failDisplay?: boolean; failReporting?: boolean; apiOrigin?: string } = {}) {
  const listeners = new Map<string, (event: any) => void>();
  const displayed: { title: string; options: any }[] = [];
  const opened: string[] = [];
  const messages: any[] = [];
  const reports: { url: string; options: any }[] = [];
  const sequence: string[] = [];
  const self = {
    location: { origin: 'http://localhost:5173', href: `http://localhost:5173/sw.js${options.apiOrigin ? `?apiOrigin=${encodeURIComponent(options.apiOrigin)}` : ''}` },
    addEventListener: (name: string, callback: (event: any) => void) => listeners.set(name, callback),
    registration: { async showNotification(title: string, notificationOptions: any) {
      if (options.failDisplay) throw new Error('Display unavailable');
      displayed.push({ title, options: notificationOptions }); sequence.push('displayed');
    } },
    clients: { async matchAll() { return [{ url: 'http://localhost:5173/', postMessage(message: unknown) { messages.push(message); }, async navigate(url: string) { opened.push(url); }, async focus() {} }]; }, async openWindow(url: string) { opened.push(url); } },
  };
  runInNewContext(source, { self, URL, AbortSignal, async fetch(url: string, request: unknown) {
    sequence.push('reported'); reports.push({ url, options: request });
    if (options.failReporting) throw new Error('Offline');
    return { ok: true };
  } });
  async function emit(name: string, extra: Record<string, unknown>) {
    let pending = Promise.resolve();
    listeners.get(name)!({ ...extra, waitUntil(promise: Promise<void>) { pending = promise; } });
    await pending;
  }
  return { emit, displayed, opened, messages, reports, sequence };
}

test('service worker displays incoming payload and reports only after display succeeds', async () => {
  const w = worker();
  await w.emit('push', { data: { json: () => ({ title: 'Hello', body: 'From the server', notificationId: 'unique-id', url: '/' }) } });
  assert.equal(w.displayed[0]?.title, 'Hello');
  assert.equal(w.displayed[0]?.options.tag, 'unique-id');
  assert.equal(w.messages[0]?.type, 'PUSH_RECEIVED');
});

const reportingPayload = (origin = 'http://localhost:5173') => ({ title: 'A real update', body: 'Report safely', url: '/updates',
  notificationId: 'a'.repeat(64), reporting: { url: `${origin}/api/deliveries/${'a'.repeat(64)}/events`, token: 't'.repeat(43) } });

test('service worker reports receipt after notification creation and reports clicks separately', async () => {
  const w = worker(); const payload = reportingPayload();
  await w.emit('push', { data: { json: () => payload } });
  assert.deepEqual(w.sequence, ['displayed', 'reported']);
  assert.equal(JSON.parse(w.reports[0]!.options.body).type, 'received');
  assert.equal(w.reports[0]!.options.headers.Authorization, `Bearer ${payload.reporting.token}`);
  await w.emit('notificationclick', { notification: { data: w.displayed[0]!.options.data, close() {} } });
  assert.equal(JSON.parse(w.reports[1]!.options.body).type, 'clicked');
  assert.equal(w.opened[0], 'http://localhost:5173/updates');
});

test('reporting failure does not prevent display or safe navigation, and failed display produces no receipt', async () => {
  const w = worker({ failReporting: true }); const payload = reportingPayload();
  await w.emit('push', { data: { json: () => payload } });
  assert.equal(w.displayed.length, 1); assert.equal(w.messages.length, 1);
  await w.emit('notificationclick', { notification: { data: w.displayed[0]!.options.data, close() {} } });
  assert.equal(w.opened[0], 'http://localhost:5173/updates');
  const blocked = worker({ failDisplay: true });
  await assert.rejects(blocked.emit('push', { data: { json: () => payload } }), /Display unavailable/);
  assert.equal(blocked.reports.length, 0); assert.equal(blocked.messages.length, 0);
});

test('service worker sends capabilities only to the configured reporting origin and exact delivery path', async () => {
  const untrusted = worker(); const payload = reportingPayload('https://foreign.example');
  await untrusted.emit('push', { data: { json: () => payload } });
  assert.equal(untrusted.reports.length, 0); assert.equal(untrusted.displayed.length, 1);
  const configured = worker({ apiOrigin: 'https://api.example' });
  await configured.emit('push', { data: { json: () => reportingPayload('https://api.example') } });
  assert.equal(configured.reports.length, 1);
  const malformed = reportingPayload(); malformed.reporting.url += '?credential=leak';
  await untrusted.emit('push', { data: { json: () => malformed } });
  assert.equal(untrusted.reports.length, 0);
});

test('malformed payload still produces a visible fallback notification', async () => {
  const w = worker();
  await w.emit('push', { data: { json: () => { throw new Error('not JSON'); } } });
  assert.equal(w.displayed[0]?.title, 'Web Push update');
});

test('notification clicks cannot navigate outside the subscriber website', async () => {
  const w = worker();
  let closed = false;
  await w.emit('notificationclick', { notification: { data: { url: 'https://untrusted.example/phish' }, close() { closed = true; } } });
  assert.equal(closed, true);
  assert.equal(w.opened[0], 'http://localhost:5173/');
});
