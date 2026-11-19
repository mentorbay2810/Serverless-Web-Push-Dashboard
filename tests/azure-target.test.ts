import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAzureTarget, parseAzureTarget } from '../tools/azure-target.js';

const target = { schemaVersion: 1, tenantId: '11111111-1111-4111-8111-111111111111', subscriptionId: '22222222-2222-4222-8222-222222222222', location: 'centralindia' };
test('Azure checks require an explicit valid tenant and subscription before invoking a CLI', () => {
  for (const bad of [null, [], {}, { ...target, tenantId: '' }, { ...target, subscriptionId: '00000000-0000-0000-0000-000000000000' },
    { ...target, tenantId: 'id & other-command' }, { ...target, location: 'region; other-command' }, { ...target, region: 'typo' }]) {
    assert.throws(() => checkAzureTarget(bad, () => { assert.fail('Invalid targets must never invoke Azure.'); }));
  }
  assert.deepEqual(parseAzureTarget(target), target);
});
test('a previous account or disabled subscription stops checks before any resource queries', () => {
  for (const account of [{ id: target.subscriptionId, tenantId: '33333333-3333-4333-8333-333333333333', state: 'Enabled' },
    { id: '44444444-4444-4444-8444-444444444444', tenantId: target.tenantId, state: 'Enabled' },
    { id: target.subscriptionId, tenantId: target.tenantId, state: 'Disabled' }]) {
    let calls = 0;
    assert.throws(() => checkAzureTarget(target, () => { calls++; return account; }), /match|enabled/);
    assert.equal(calls, 1);
  }
});
test('every Azure resource query explicitly targets the new subscription and only reads state', () => {
  const calls: string[][] = [];
  const result = checkAzureTarget(target, args => {
    calls.push(args);
    assert.deepEqual(args.slice(-2), ['--subscription', target.subscriptionId]);
    if (args[0] === 'account') return { id: target.subscriptionId, tenantId: target.tenantId, state: 'Enabled' };
    if (args[0] === 'cosmosdb') return [{ enableFreeTier: true }];
    return [{ version: '24' }];
  });
  assert.deepEqual(result, { freeTierAccountPresent: true, nodeRuntimes: ['24'] });
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [['account', 'show'], ['cosmosdb', 'list'], ['functionapp', 'list-flexconsumption-runtimes']]);
});
