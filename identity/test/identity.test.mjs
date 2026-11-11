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
  await identity.revoke(next.token, context.audience); assert.equal(identity.authenticate(next.token, context.audience), null);
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


test('hash-only sessions survive restart; explicit renewal extends idle expiry, reads do not', async () => {
  let now = 1000, saved = [];
  const options = { username: 'admin', password: record, now: () => now, sessionLifetimeMs: 1000,
    persistSessions: async sessions => { saved = structuredClone(sessions); } };
  const context = { audience: 'https://agent.example', client: 'test' };
  let identity = new Identity(options);
  const session = await identity.login('admin', password, context);
  assert.ok(!JSON.stringify(saved).includes(session.token)); assert.equal(saved[0].hash.length, 64);
  identity.stop(); identity = new Identity({ ...options, sessions: saved });
  assert.ok(identity.authenticate(session.token, context.audience));
  now = 1800; assert.equal((await identity.renew(session.token, context.audience)).expiresAt, 2800);
  await assert.rejects(identity.renew(session.token, 'https://other.example'), { status: 401 });
  now = 2100; assert.ok(identity.authenticate(session.token, context.audience));
  now = 2800; assert.equal(identity.authenticate(session.token, context.audience), null);
  await assert.rejects(identity.renew(session.token, context.audience), { status: 401 });
});

test('failed renewal and logout do not commit unpersisted session changes; retry survives restart', async () => {
  let now = 1000, saved = [], fail = false;
  const options = { username: 'admin', password: record, now: () => now, sessionLifetimeMs: 1000,
    persistSessions: async sessions => { if (fail) throw Error('disk failed'); saved = structuredClone(sessions); } };
  const identity = new Identity(options), context = { audience: 'https://agent.example', client: 'test' };
  const session = await identity.login('admin', password, context);
  now = 1500; fail = true;
  await assert.rejects(identity.renew(session.token, context.audience), /disk failed/);
  assert.equal(identity.authenticate(session.token, context.audience).expiresAt, 2000);
  await assert.rejects(identity.revoke(session.token, context.audience), /disk failed/);
  assert.ok(identity.authenticate(session.token, context.audience));
  fail = false; await identity.revoke(session.token, context.audience);
  assert.equal(new Identity({ ...options, sessions: saved }).authenticate(session.token, context.audience), null);
});


test('unchanged credential save and parallel renewal cannot resurrect revoked sessions', async () => {
  let entered, release, saved = [];
  const saving = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const options = { username: 'admin', password: record,
    persist: async () => { entered(); await blocked; saved = []; },
    persistSessions: async sessions => { saved = structuredClone(sessions); } };
  const identity = new Identity(options), context = { audience: 'https://agent.example', client: 'test' };
  const session = await identity.login('admin', password, context);
  const change = identity.changeCredentials(session.token, context, { username: 'admin', currentPassword: password });
  await saving;
  const renewal = assert.rejects(identity.renew(session.token, context.audience), { status: 401 });
  release(); await change; await renewal;
  assert.equal(identity.authenticate(session.token, context.audience), null);
  assert.equal(new Identity({ ...options, sessions: saved }).authenticate(session.token, context.audience), null);
});
