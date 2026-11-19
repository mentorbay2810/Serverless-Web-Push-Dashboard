import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Container, OperationInput } from '@azure/cosmos';
import { CosmosDocumentDatabase } from '../packages/adapters/src/cosmos.js';

test('Cosmos adapter checks individual transaction failures and emits guarded deletes', async () => {
  let operations: OperationInput[] = [];
  let results = [200, 204];
  const container = { items: { async batch(input: OperationInput[], partition: string) {
    operations = input; assert.equal(partition, 'test'); return { code: 200, result: results.map(statusCode => ({ statusCode })) };
  } } } as unknown as Container;
  const database = new CosmosDocumentDatabase(container, 'test');
  assert.equal(await database.transact([{ type: 'delete', id: 'record', etag: 'version-1' }]), true);
  assert.equal(operations[0]?.operationType, 'Patch');
  assert.equal((operations[0] as { ifMatch?: string }).ifMatch, 'version-1');
  assert.equal(operations[1]?.operationType, 'Delete');
  results = [412, 424];
  assert.equal(await database.transact([{ type: 'delete', id: 'record', etag: 'stale-version' }]), false);
});
