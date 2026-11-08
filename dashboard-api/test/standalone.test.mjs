import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { request } from 'node:https';
import path from 'node:path';
import { setup } from '../../agent-link/test/fixture.mjs';
import { passwordRecord } from '../../identity/service.mjs';
import { createAdministration } from '../standalone.mjs';

test('standalone administration authenticates registry/WSS without a Core/model/local agent and persists account changes', async t => {
  const f = await setup(t); await f.server.stop(); const home = path.join(f.home, 'standalone'); await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'identity.json'), JSON.stringify({ username: 'operator', password: await passwordRecord('fixture-password-original') }), { mode: 0o600 });
  const options = { home, origin: f.origin, host: '127.0.0.1', port: f.config.port, keyFile: f.config.keyFile, certFile: f.config.certFile };
  let admin = await createAdministration(options); t.after(() => admin.stop());
  const ca = await readFile(f.config.certFile);
  const call = (route, body, cookie) => new Promise((resolve, reject) => {
    const req = request(f.origin + route, { ca, method: body ? 'POST' : 'GET', headers: { ...(body ? { Origin: f.origin, 'X-Hayate-WebUI': '1', 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, res => {
      const chunks = []; res.on('data', data => chunks.push(data)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  assert.equal((await call('/api/workspace/agent-relay')).status, 401);
  const login = await call('/api/auth/login', { username: 'operator', password: 'fixture-password-original' }); assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const caps = (await call('/api/workspace/capabilities', undefined, cookie)).body;
  assert.equal(caps['local-agent'], false); assert.equal(caps['project-creation'], false); assert.equal(caps['agent-link-relay'], 1);
  assert.equal((await call('/api/chats', {}, cookie)).status, 409);
  assert.equal((await call('/api/workspace/projects', { title: 'Fake local execution', cwd: home }, cookie)).status, 409);
  const invite = await call('/api/workspace/agent-relay', { name: 'Manual target' }, cookie); assert.equal(invite.status, 201); assert.equal(invite.body.transport, 'hayate-wss');
  assert.equal(admin.hub.list('operator').length, 0);
  const update = await call('/api/auth/account', { currentPassword: 'fixture-password-original', username: 'renamed', newPassword: 'fixture-password-updated' }, cookie); assert.equal(update.status, 200);
  await admin.reloadTLS(); await admin.stop(); admin = await createAdministration(options);
  assert.equal((await call('/api/auth/login', { username: 'operator', password: 'fixture-password-original' })).status, 401);
  assert.equal((await call('/api/auth/login', { username: 'renamed', password: 'fixture-password-updated' })).status, 200);
});
