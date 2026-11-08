import test from 'node:test';
import assert from 'node:assert/strict';
import { Identity, passwordRecord } from '../service.mjs';
const password = 'fixture-password-long';
const record = await passwordRecord(password);

test('headless identity binds opaque sessions to an audience, expires and revokes without persisting tokens', async () => {
  let now = 1000; const identity = new Identity({ username: 'operator', password: record, now: () => now, sessionLifetimeMs: 1000 });
  const context = { audience: 'https://agent.example', client: '127.0.0.1' };
  await assert.rejects(identity.login('wrong', password, context), { status: 401 });
  await assert.rejects(identity.login('operator', 'incorrect', context), { status: 401 });
  const session = await identity.login('operator', password, context);
  assert.equal(identity.authenticate(session.token, context.audience).principal, 'operator');
  assert.equal(identity.authenticate(session.token, 'https://other.example'), null);
  assert.equal(identity.authenticate('arbitrary-value', context.audience), null);
  now = 2000; assert.equal(identity.authenticate(session.token, context.audience), null);
  const next = await identity.login('operator', password, context);
  identity.revoke(next.token, context.audience); assert.equal(identity.authenticate(next.token, context.audience), null);
  identity.stop(); await assert.rejects(identity.login('operator', password, context));
  assert.doesNotMatch(JSON.stringify(identity), new RegExp(session.token));
});

test('account changes require current password, persist before committing and revoke every session', async () => {
  let persisted;
  const identity = new Identity({ username: 'operator', password: record, persist: async config => { persisted = config; } });
  const context = { audience: 'https://agent.example', client: 'account' };
  const first = await identity.login('operator', password, context); const second = await identity.login('operator', password, context);
  await assert.rejects(identity.changeCredentials(first.token, context, { username: 'new-name', currentPassword: 'wrong', newPassword: 'replacement-long-password' }), { status: 400 });
  assert.equal(identity.username, 'operator'); assert.equal(persisted, undefined);
  await identity.changeCredentials(first.token, context, { username: 'new-name', currentPassword: password, newPassword: 'replacement-long-password' });
  assert.equal(persisted.username, 'new-name'); assert.doesNotMatch(JSON.stringify(persisted), /replacement-long-password/);
  assert.equal(identity.authenticate(first.token, context.audience), null); assert.equal(identity.authenticate(second.token, context.audience), null);
  const next = await identity.login('new-name', 'replacement-long-password', { ...context, client: 'new-client' }); assert.ok(next.token);
  const restored = new Identity(persisted); assert.ok((await restored.login('new-name', 'replacement-long-password', context)).token);
  identity.stop(); restored.stop();
});

test('failed account persistence retains original credentials and live session', async () => {
  const identity = new Identity({ username: 'operator', password: record, persist: async () => { throw Error('Storage unavailable'); } });
  const context = { audience: 'https://agent.example', client: 'account' }; const session = await identity.login('operator', password, context);
  await assert.rejects(identity.changeCredentials(session.token, context, { username: 'changed', currentPassword: password }), /Storage/);
  assert.equal(identity.username, 'operator'); assert.ok(identity.authenticate(session.token, context.audience)); identity.stop();
});

test('login attempts are bounded before password derivation and recover after the window', async () => {
  let now = 1000; const identity = new Identity({ username: 'operator', password: record, now: () => now });
  const context = { audience: 'https://agent.example', client: 'local' };
  for (let n = 0; n < 5; n++) await assert.rejects(identity.login('operator', 'wrong', context), { status: 401 });
  await assert.rejects(identity.login('operator', password, context), { status: 429 });
  now += 60001; const session = await identity.login('operator', password, context); assert.ok(session.token);
  identity.stop();
});
