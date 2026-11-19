import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definition, draftFrom, emptyDraft, scheduleUtc, type CampaignSummary } from '../apps/dashboard/src/admin-model.js';
import { DEFAULT_NOTIFICATION } from '../packages/core/src/index.js';

test('dashboard draft validation normalizes targeting and enforces the shared notification rules', () => {
  const form = { ...emptyDraft(), name: ' Update ', ...DEFAULT_NOTIFICATION, tags: 'Demo, news, demo' };
  const draft = definition(form); assert.equal(draft.name, 'Update');
  assert.deepEqual(draft.audience, { type: 'tags', tags: ['demo', 'news'] });
  assert.throws(() => definition({ ...form, url: 'https://foreign.example' }), /path on this website/);
  assert.throws(() => definition({ ...form, tags: '' }), /at least one/);
  assert.throws(() => definition({ ...form, audienceType: 'selected', selected: [] }), /at least one/);
  assert.throws(() => definition({ ...form, title: '' }), /Title/);
});

test('dashboard reads saved audience definitions and converts schedule offsets without modifying saved recipients', () => {
  const campaign: CampaignSummary = { id: 'a'.repeat(64), name: 'Draft', content: DEFAULT_NOTIFICATION,
    audience: { type: 'selected', subscriptionIds: ['b'.repeat(64), 'a'.repeat(64)] }, state: 'draft', createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z', recipientCount: 0, dispatchedCount: 0 };
  const form = draftFrom(campaign); const data = definition(form);
  assert.deepEqual(data.audience, { type: 'selected', subscriptionIds: ['a'.repeat(64), 'b'.repeat(64)] });
  assert.ok(campaign.audience.type === 'selected');
  assert.deepEqual(campaign.audience.subscriptionIds, ['b'.repeat(64), 'a'.repeat(64)]);
  const now = Date.parse('2026-11-18T00:00:00Z');
  assert.equal(scheduleUtc('2026-11-18T05:45:00+05:30', now), '2026-11-18T00:15:00.000Z');
  for (const value of ['', 'invalid', '2026-11-17T00:00:00Z', '2026-11-26T00:00:00Z']) assert.throws(() => scheduleUtc(value, now), /next seven days/);
});
