import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { request } from 'node:https';
import { tlsFixture } from './tls-fixture.mjs';
import { networkOptions } from '../access.mjs';

test('direct TLS authenticates every API, uses secure cookies and refuses CSRF, rebinding and forwarded identity', async t => {
  const f = await tlsFixture(); t.after(() => f.stop());
  for (const route of ['/', '/app.js', '/style.css']) assert.equal((await f.call(route)).status, 404);
  for (const route of ['/api/state', '/api/events', '/api/workspace/state', '/api/workspace/events', '/api/workspace/credentials', '/api/workspace/agents', '/api/workspace/files']) assert.equal((await f.call(route)).status, 401, route);
  assert.equal((await f.call('/api/state', { headers: { 'X-Forwarded-User': 'operator', 'X-Forwarded-Proto': 'https' } })).status, 401);
  assert.equal((await f.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: f.password }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'incorrect' } })).status, 401);
  const login = await f.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: f.password } });
  assert.equal(login.status, 200); const header = login.headers['set-cookie'][0];
  assert.match(header, /^__Host-hayate_operator=/); assert.match(header, /HttpOnly/); assert.match(header, /Secure/); assert.match(header, /SameSite=Strict/); assert.doesNotMatch(login.text, /token|fixture-password/);
  const Cookie = header.split(';')[0];
  assert.equal((await f.call('/api/state', { headers: { Cookie } })).status, 200);
  assert.equal((await f.call('/api/state', { headers: { Cookie, Host: 'evil.example' } })).status, 403);
  assert.equal((await f.call('/api/chats', { method: 'POST', body: {}, headers: { Cookie } })).status, 201);
  const logout = await f.call('/api/auth/logout', { method: 'POST', body: {}, headers: { Cookie } });
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await f.call('/api/state', { headers: { Cookie } })).status, 401);
  assert.equal((await f.call('/api/state', { headers: { Cookie: Cookie + '; ' + Cookie } })).status, 401);
});

test('logout revokes already-open legacy and workspace SSE connections', async t => {
  const f = await tlsFixture(); t.after(() => f.stop());
  const login = await f.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: f.password } });
  const Cookie = login.headers['set-cookie'][0].split(';')[0];
  // Wrap the end promises so awaiting the first data does not assimilate them.
  const streams = ['/api/events', '/api/workspace/events'].map(route => new Promise((resolve, reject) => {
    const req = request(f.origin + route, { rejectUnauthorized: false, family: 4, headers: { Cookie } }, res => {
      assert.equal(res.statusCode, 200);
      const ended = new Promise(done => res.once('end', done));
      res.once('data', () => resolve({ ended })); res.resume();
    }); req.on('error', reject); req.end();
  }));
  const opened = await Promise.all(streams);
  await f.call('/api/auth/logout', { method: 'POST', body: {}, headers: { Cookie } });
  let timer;
  try { await Promise.race([Promise.all(opened.map(s => s.ended)), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Revoked SSE stayed open')), 5000); })]); }
  finally { clearTimeout(timer); }
});

test('expired sessions cannot read or mutate either legacy or workspace state', async t => {
  const f = await tlsFixture(); t.after(() => f.stop());
  const login = await f.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: f.password } });
  const Cookie = login.headers['set-cookie'][0].split(';')[0];
  f.identity.now = () => Date.now() + 3600001;
  assert.equal((await f.call('/api/state', { headers: { Cookie } })).status, 401);
  assert.equal((await f.call('/api/workspace/state', { headers: { Cookie } })).status, 401);
  assert.equal((await f.call('/api/chats', { method: 'POST', body: {}, headers: { Cookie } })).status, 401);
  assert.equal((await f.call('/api/workspace/projects', { method: 'POST', body: { title: 'Forbidden', cwd: f.home }, headers: { Cookie } })).status, 401);
  assert.equal(f.workspace.snapshot('operator').projects.length, 0);
  f.identity.stop(); assert.equal((await f.call('/api/state', { headers: { Cookie } })).status, 401);
});

test('network configuration fails closed for missing identity, HTTP origin, ambiguous authority or unsafe key permissions', async t => {
  const f = await tlsFixture(); t.after(() => f.stop());
  await assert.rejects(networkOptions(f.network, { get: () => undefined }), /identity/);
  for (const patch of [{ origin: 'http://localhost' }, { origin: 'https://user:pass@localhost' }, { origin: 'https://localhost/path' }, { host: 'localhost' }]) await assert.rejects(networkOptions({ ...f.network, ...patch }, f.services));
  await chmod(f.network.keyFile, 0o644);
  await assert.rejects(networkOptions(f.network, f.services), /private/);
});
