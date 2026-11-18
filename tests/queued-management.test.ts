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
  context.after(async () => { runtime.stop(); await rm(directory, { recursive: true, force: true }); });
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
});
