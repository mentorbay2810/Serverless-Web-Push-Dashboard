import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { queuedLocal } from '../apps/functions/src/queued-local.js';
import { DEFAULT_NOTIFICATION } from '../packages/core/src/index.js';

test('local management stays behind host, origin, and CLI-token checks; public admin access stays disabled', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'webpush-management-'));
  const keys = webpush.generateVAPIDKeys();
  const runtime = queuedLocal({ port: 8787, webOrigin: 'http://localhost:5173', adminToken: 'private-cli-token', dataDirectory: directory,
    vapid: { ...keys, subject: 'mailto:developer@example.com' } });
  context.after(async () => { await runtime.stop(); await rm(directory, { recursive: true, force: true }); });
  const request = (path: string, token?: string, origin?: string, host = '127.0.0.1:8787') => runtime.handle(new Request(`http://${host}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) },
  }));
  assert.equal((await request('/api/local/manage/campaigns')).status, 401);
  assert.equal((await request('/api/local/manage/campaigns', 'incorrect')).status, 401);
  assert.equal((await request('/api/local/manage/campaigns', 'private-cli-token', 'https://foreign.example')).status, 403);
  assert.equal((await request('/api/local/manage/campaigns', 'private-cli-token', undefined, 'foreign.example')).status, 403);
  assert.equal((await request('/api/admin/campaigns', 'private-cli-token')).status, 401);
  const created = await runtime.handle(new Request('http://127.0.0.1:8787/api/local/manage/campaigns', {
    method: 'POST', headers: { Authorization: 'Bearer private-cli-token', 'Content-Type': 'application/json', 'Idempotency-Key': 'local-draft-123' },
    body: JSON.stringify({ content: DEFAULT_NOTIFICATION, audience: { type: 'all' } }),
  }));
  assert.equal(created.status, 201); assert.equal((await created.json()).state, 'draft');
  assert.equal((await request('/api/local/manage/campaigns', 'private-cli-token')).status, 200);
  const config = await (await request('/api/config')).text();
  assert.ok(!config.includes(keys.privateKey)); assert.ok(!config.includes('private-cli-token'));
  assert.equal(JSON.parse(config).localAdmin, true);
  const issueRequest = (token?: string) => runtime.handle(new Request('http://127.0.0.1:8787/api/local/session', {
    method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {},
  }));
  assert.equal((await issueRequest()).status, 401);
  const issued = await issueRequest('private-cli-token'); assert.equal(issued.status, 201);
  const link = await issued.json() as { url: string }; const code = new URLSearchParams(new URL(link.url).hash.slice(1)).get('pair');
  const exchange = (origin = 'http://localhost:5173') => runtime.handle(new Request('http://127.0.0.1:8787/api/local/session/exchange', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ code }),
  }));
  assert.equal((await exchange('https://foreign.example')).status, 403);
  const connected = await exchange(); assert.equal(connected.status, 200);
  const session = await connected.json() as { token: string };
  assert.equal((await exchange()).status, 401);
  assert.equal((await request('/api/local/manage/campaigns', session.token)).status, 200);
  assert.equal((await request('/api/admin/campaigns', session.token)).status, 401);
  assert.equal((await issueRequest(session.token)).status, 401);
  assert.equal((await request('/api/local/subscriptions', session.token)).status, 401);
  assert.equal((await runtime.handle(new Request('http://127.0.0.1:8787/api/local/session/logout', { method: 'POST', headers: { Authorization: `Bearer ${session.token}` } }))).status, 200);
  assert.equal((await request('/api/local/manage/campaigns', session.token)).status, 401);
});
