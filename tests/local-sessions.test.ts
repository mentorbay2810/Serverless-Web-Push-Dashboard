import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalAdminSessions } from '../apps/functions/src/local-sessions.js';

test('local sign-in links are one-use, expire after two minutes, and produce separately revocable one-hour sessions', () => {
  let now = 0; const sessions = new LocalAdminSessions(() => now);
  const issued = sessions.issue(); const session = sessions.exchange(issued.code);
  assert.notEqual(issued.code, session.token);
  assert.throws(() => sessions.exchange(issued.code), /already used/);
  assert.equal(sessions.authorized(`Bearer ${session.token}`), true);
  assert.equal(sessions.authorized(`Bearer ${issued.code}`), false);
  assert.equal(sessions.authorized('Bearer forged'), false);
  const expiring = sessions.issue(); now += 120000;
  assert.throws(() => sessions.exchange(expiring.code), /expired/);
  sessions.revoke(`Bearer ${session.token}`); assert.equal(sessions.authorized(`Bearer ${session.token}`), false);
  const other = sessions.exchange(sessions.issue().code); now += 3600000;
  assert.equal(sessions.authorized(`Bearer ${other.token}`), false);
  assert.equal(new LocalAdminSessions(() => now).authorized(`Bearer ${other.token}`), false);
});

test('local link and session counts are bounded', () => {
  const links = new LocalAdminSessions(); for (let index = 0; index < 5; index++) links.issue();
  assert.throws(() => links.issue(), /Too many unused/);
  const sessions = new LocalAdminSessions(); for (let index = 0; index < 10; index++) sessions.exchange(sessions.issue().code);
  assert.throws(() => sessions.exchange(sessions.issue().code), /Too many active/);
});
