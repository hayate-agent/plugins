import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from '../../agent-link/vendor/websocket.mjs';
import { tlsFixture } from './tls-fixture.mjs';
test('browser WebSocket requires same-origin session and cannot receive events after logout', async () => {
 const listeners = new Set();
 const relay = { revision: () => 'one', subscribe(owner, send) { assert.equal(owner, 'operator'); listeners.add(send); return () => listeners.delete(send); } };
 const f = await tlsFixture({ extraServices: { 'agent-link-relay': { version: 1, implementation: relay } } }); let socket;
 const connect = (origin, cookie) => new WebSocket(f.origin.replace('https:', 'wss:') + '/api/workspace/live', 'hayate.workspace.v1', { origin, rejectUnauthorized: false, family: 4, headers: cookie ? { Cookie: cookie } : {} });
 const refused = async ws => { const status = await new Promise((resolve, reject) => { ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); }); ws.on('open', () => reject(Error('Unauthorized WebSocket opened'))); ws.on('error', reject); }); assert.equal(status, 403); ws.terminate(); };
 try {
  await refused(connect(f.origin));
  const login = await f.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: f.password } });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  await refused(connect('https://foreign.example', cookie));
  socket = connect(f.origin, cookie);
  assert.equal(JSON.parse((await once(socket, 'message'))[0]).revision, 'one');
  await f.call('/api/auth/logout', { method: 'POST', body: {}, headers: { Cookie: cookie } });
  const closed = once(socket, 'close'); for (const send of listeners) send({ type: 'changed', revision: 'secret-after-logout' });
  assert.equal((await closed)[0], 4003);
 } finally { socket?.terminate(); await f.stop(); }
});
