import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plugin from '../index.mjs';
import { passwordRecord } from '../service.mjs';

test('plugin persists private hashed sessions across activation and durably revokes logout and account changes', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'identity-persistence-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const password = 'fixture-password-long', audience = 'https://agent.example';
  await writeFile(path.join(home, 'identity.json'), JSON.stringify({ username: 'admin', password: await passwordRecord(password) }), { mode: 0o600 });
  let stop;
  const activate = async () => {
    let service;
    await plugin.activate({ home, foregroundWork: work => Promise.resolve().then(work), onStop: callback => { stop = callback; }, registerService: (_name, _version, value) => { service = value; } });
    return service;
  };
  let service = await activate(); t.after(() => stop());
  const first = await service.login('admin', password, { audience, client: 'test' });
  const file = path.join(home, 'identity/account.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(file, 'utf8')).includes(first.token));
  await stop(); service = await activate();
  assert.ok(service.authenticate(first.token, audience));
  await service.renew(first.token, audience);
  await service.revoke(first.token, audience);
  await stop(); service = await activate();
  assert.equal(service.authenticate(first.token, audience), null);
  const second = await service.login('admin', password, { audience, client: 'test' });
  await service.changeCredentials(second.token, { audience, client: 'change' }, { currentPassword: password, username: 'renamed' });
  await stop(); service = await activate();
  assert.equal(service.authenticate(second.token, audience), null);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).sessions.length, 0);
  await assert.rejects(service.login('admin', password, { audience, client: 'test' }), { status: 401 });
  assert.ok((await service.login('renamed', password, { audience, client: 'test' })).token);
});
