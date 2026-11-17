import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../apps/dashboard/public/sw.js', import.meta.url), 'utf8');

function worker() {
  const listeners = new Map<string, (event: any) => void>();
  const displayed: { title: string; options: any }[] = [];
  const opened: string[] = [];
  const messages: any[] = [];
  const self = {
    location: { origin: 'http://localhost:5173' },
    addEventListener: (name: string, callback: (event: any) => void) => listeners.set(name, callback),
    registration: { async showNotification(title: string, options: any) { displayed.push({ title, options }); } },
    clients: { async matchAll() { return [{ url: 'http://localhost:5173/', postMessage(message: unknown) { messages.push(message); }, async navigate(url: string) { opened.push(url); }, async focus() {} }]; }, async openWindow(url: string) { opened.push(url); } },
  };
  runInNewContext(source, { self, URL });
  async function emit(name: string, extra: Record<string, unknown>) {
    let pending = Promise.resolve();
    listeners.get(name)!({ ...extra, waitUntil(promise: Promise<void>) { pending = promise; } });
    await pending;
  }
  return { emit, displayed, opened, messages };
}

test('service worker displays incoming payload and reports only after display succeeds', async () => {
  const w = worker();
  await w.emit('push', { data: { json: () => ({ title: 'Hello', body: 'From the server', notificationId: 'unique-id', url: '/' }) } });
  assert.equal(w.displayed[0]?.title, 'Hello');
  assert.equal(w.displayed[0]?.options.tag, 'unique-id');
  assert.equal(w.messages[0]?.type, 'PUSH_RECEIVED');
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
