import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileDocumentDatabase } from '../packages/adapters/src/file-database.js';
import { LocalQueuePublisher } from '../packages/adapters/src/local-queue.js';

test('both local queues persist across restart and acknowledge only processed messages', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'webpush-queues-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'queues.json');
  const original = new LocalQueuePublisher(new FileDocumentDatabase(path));
  await original.campaign('campaign-id'); await original.delivery('delivery-id');
  const restarted = new LocalQueuePublisher(new FileDocumentDatabase(path));
  const received: string[] = [];
  await restarted.consume('campaign', async id => { received.push(id); });
  assert.deepEqual(received, ['campaign-id']);
  assert.equal((await new FileDocumentDatabase(path).page('message', 100)).items.length, 1);
  await restarted.consume('delivery', async id => { received.push(id); });
  assert.deepEqual(received, ['campaign-id', 'delivery-id']);
  assert.equal((await new FileDocumentDatabase(path).page('message', 100)).items.length, 0);
});
