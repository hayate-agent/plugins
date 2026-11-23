import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../service.mjs';

async function setup(t) {
 const home = await mkdtemp(path.join(os.tmpdir(), 'fork-lifecycle-'));
 let pause = false, release, reached;
 const entered = new Promise(resolve => { reached = resolve; });
 const gate = new Promise(resolve => { release = resolve; });
 const service = new Workspace({ home, cwd: home, executionContexts: { async bind() { if (pause) { reached(); await gate; } } } });
 await service.open();
 t.after(async () => { release(); await service.stop(); await rm(home, { recursive: true, force: true }); });
 const project = await service.createProject('operator', { title: 'Project', cwd: home });
 const source = await service.createStream('operator', { title: 'Source', projectId: project.id });
 return { service, source, project, pause() { pause = true; }, entered, release };
}
for (const kind of ['stream', 'project']) for (const flag of ['archived', 'deleted']) {
 test(`fork rechecks ${kind} ${flag} after context binding`, async t => {
  const { service, source, project, pause, entered, release } = await setup(t);
  pause();
  const attempt = service.forkStream('operator', source.id, { idempotencyKey: randomUUID() });
  const rejected = assert.rejects(attempt, /Restore the (chat|project) before forking/);
  await entered;
  await service.update('operator', kind, kind === 'stream' ? source.id : project.id, { [flag]: true });
  release(); await rejected;
  assert.equal(service.store.read().streams.filter(s => s.forkSource === source.id).length, 0);
 });
}
test('ordinary forks and accepted retries survive later source archive', async t => {
 const { service, source } = await setup(t);
 const input = { idempotencyKey: randomUUID() };
 const fork = await service.forkStream('operator', source.id, input);
 await service.update('operator', 'stream', source.id, { archived: true });
 assert.equal((await service.forkStream('operator', source.id, input)).id, fork.id);
 assert.equal(service.store.read().streams.filter(s => s.forkSource === source.id).length, 1);
});
