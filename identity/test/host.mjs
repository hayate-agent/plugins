import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { passwordRecord } from '../service.mjs';
const core = path.resolve(process.argv[2]); const load = file => import(pathToFileURL(path.join(core, file)).href);
const { Harness } = await load('src/harness.ts'); const { FakeRuntime } = await load('test/fakes.ts'); const { PluginHost } = await load('src/plugins.ts');
const home = await mkdtemp(path.join(os.tmpdir(), 'identity-host-'));
const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 }); const plugins = new PluginHost();
try {
  const password = 'fixture-password-long';
  await writeFile(path.join(home, 'identity.json'), JSON.stringify({ username: 'admin', password: await passwordRecord(password) }), { mode: 0o600 });
  await plugins.load([fileURLToPath(new URL('../index.mjs', import.meta.url))], { home, cwd: home, agent: 'Fixture', foregroundWork: work => harness.withForegroundWork(work) }, []);
  await harness.start(); const identity = plugins.services.get('identity').implementation;
  const login = identity.login('admin', password, { audience: 'https://agent.example', client: 'test' });
  assert.notEqual(harness.acquireUpdateAdmission(1000).status, 'admitted', 'Password derivation owns admission');
  const session = await login; assert.equal(identity.authenticate(session.token, 'https://agent.example').principal, 'operator');
  await identity.changeCredentials(session.token, { audience: 'https://agent.example', client: 'change' }, { username: 'renamed', currentPassword: password, newPassword: 'changed-password-long' });
  await plugins.stop(); assert.equal(identity.authenticate(session.token, 'https://agent.example'), null);
  const next = new PluginHost();
  await next.load([fileURLToPath(new URL('../index.mjs', import.meta.url))], { home, cwd: home, agent: 'Fixture', foregroundWork: work => harness.withForegroundWork(work) }, []);
  const restored = next.services.get('identity').implementation;
  assert.ok((await restored.login('renamed', 'changed-password-long', { audience: 'https://agent.example', client: 'restart' })).token);
  await next.stop();
  assert.equal(harness.acquireUpdateAdmission(1000).status, 'admitted');
  console.log('Identity native host: service registration, foreground-work admission and stop-time session revocation passed.');
} finally { await harness.stop(); await plugins.stop(); await rm(home, { recursive: true, force: true }); }
