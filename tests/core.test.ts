import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { parseNotification, parseSubscription } from '../packages/core/src/index.js';

export function fixture(endpoint = 'https://fcm.googleapis.com/fcm/send/foundation-test') {
  const curve = createECDH('prime256v1'); curve.generateKeys();
  return { endpoint, expirationTime: null, keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

test('valid browser subscription retains only expected fields', () => {
  const input = fixture();
  assert.deepEqual(parseSubscription({ ...input, injected: 'discarded' }), input);
});

test('Chromium alternate Google push host is supported without accepting lookalikes', () => {
  assert.equal(new URL(parseSubscription(fixture('https://jmt17.google.com/fcm/send/test')).endpoint).hostname, 'jmt17.google.com');
  assert.throws(() => parseSubscription(fixture('https://jmt17.google.com.evil.example/fcm/send/test')));
});

test('subscription validation rejects private hosts, spoofed providers, credentials, and malformed keys', () => {
  for (const endpoint of ['http://localhost:8787/', 'https://127.0.0.1/', 'https://fcm.googleapis.com.evil.example/', 'https://evil.example/', 'https://user:pass@fcm.googleapis.com/send', 'https://fcm.googleapis.com:8443/send']) {
    assert.throws(() => parseSubscription(fixture(endpoint)));
  }
  assert.throws(() => parseSubscription({ ...fixture(), keys: { p256dh: 'bad', auth: 'bad' } }));
});

test('notification validation rejects external click destinations and oversized payloads', () => {
  assert.deepEqual(parseNotification({ title: ' Test ', body: ' Message ', url: '/?test=1' }), { title: 'Test', body: 'Message', url: '/?test=1' });
  for (const url of ['https://evil.example', '//evil.example', '/\\evil.example', '/\nunsafe']) {
    assert.throws(() => parseNotification({ title: 'Test', body: 'Message', url }));
  }
  assert.throws(() => parseNotification({ title: 'x'.repeat(81), body: 'Message' }));
});
