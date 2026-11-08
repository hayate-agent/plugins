import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../service.mjs';
import { Store } from '../../shared/store.mjs';

async function setup(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'workspace-'));
  const a = path.join(home, 'a'), b = path.join(home, 'b'); await mkdir(a); await mkdir(b);
  const bindings = new Map();
  const service = new Workspace({ home, cwd: home, executionContexts: { async bind(key, value) { bindings.set(key, value); }, get: key => bindings.get(key) } });
  await service.open(); t.after(async () => { await service.stop(); await rm(home, { recursive: true, force: true }); });
  return { service, home, a, b, bindings };
}
test('standalone chats can run, join and leave projects without changing context or activity order', async t => {
  const { service, home, a, bindings } = await setup(t);
  const chat = await service.createStream('operator', { title: 'Just a chat' });
  assert.equal(chat.projectId, null); assert.equal(chat.cwd, home);
  assert.equal(service.snapshot('operator').projects.length, 0);
  const binding = structuredClone(bindings.get(`plugin:workspaces:${chat.id}`));
  const project = await service.createProject('operator', { title: 'Organized', cwd: a, settings: { model: 'provider/project' } });
  await service.update('operator', 'stream', chat.id, { projectId: project.id });
  assert.equal(service.stream('operator', chat.id).projectId, project.id);
  await service.update('operator', 'stream', chat.id, { projectId: null, read: true });
  assert.equal(service.stream('operator', chat.id).projectId, null);
  assert.equal(service.stream('operator', chat.id).updatedAt, chat.updatedAt, 'Organizing/reading does not reorder conversations');
  assert.deepEqual(bindings.get(`plugin:workspaces:${chat.id}`), binding);
  await service.update('operator', 'global', null, { model: 'provider/global' });
  const received = []; await service.channel.start(async input => received.push(input));
  await service.submit('operator', chat.id, { id: randomUUID(), text: 'Keep original cwd' });
  assert.equal(received[0].turn.model, 'provider/global');
  assert.equal(service.stream('operator', chat.id).messages[0].text, 'Keep original cwd');
  await assert.rejects(service.update('other', 'stream', chat.id, { projectId: null }), /not found/);
});

test('projects and streams work without WebUI and bind their real cwd before ingress', async t => {
  const { service, a, b, bindings } = await setup(t);
  const p = await service.createProject('operator', { title: 'Two repositories', cwd: a, directories: [b] });
  const s = await service.createStream('operator', { title: 'Work in second checkout', projectId: p.id, cwd: b });
  assert.equal(bindings.get(`plugin:workspaces:${s.id}`).cwd, b);
  assert.deepEqual(bindings.get(`plugin:workspaces:${s.id}`).directories, [b, a]);
  const received = []; await service.channel.start(async message => { received.push(message); });
  await service.update('operator', 'global', null, { model: 'provider/global' });
  await service.update('operator', 'project', p.id, { settings: { model: 'provider/project' } });
  await service.update('operator', 'stream', s.id, { settings: { thinking: 'runtime-value' } });
  await service.submit('operator', s.id, { id: randomUUID(), text: 'inspect' });
  assert.equal(received[0].target, s.id); assert.equal(received[0].turn.model, 'provider/project');
  assert.equal(received[0].turn.thinking, 'runtime-value');
  assert.equal(service.stream('operator', s.id).messages[0].accepted, true);
});
test('principal isolation, hierarchy cycles, organizing moves and recoverable lifecycle', async t => {
  const { service, a, b } = await setup(t);
  const p = await service.createProject('alice', { title: 'Alice', cwd: a });
  const q = await service.createProject('alice', { title: 'Nested', cwd: b, parentId: p.id });
  const s = await service.createStream('alice', { projectId: p.id });
  assert.equal(service.snapshot('bob').projects.length, 0);
  assert.throws(() => service.stream('bob', s.id), /not found/);
  await assert.rejects(service.update('alice', 'project', p.id, { parentId: q.id }), /cycle/);
  await service.update('alice', 'stream', s.id, { projectId: q.id });
  assert.equal(service.stream('alice', s.id).cwd, a, 'Organizing does not retarget active execution context');
  await service.update('alice', 'stream', s.id, { deleted: true });
  await service.channel.start(async () => {});
  await assert.rejects(service.submit('alice', s.id, { id: randomUUID(), text: 'no' }), /Restore/);
  await service.update('alice', 'stream', s.id, { deleted: false });
  const converted = await service.convert('alice', s.id); assert.equal(converted.cwd, a);
  assert.equal(service.stream('alice', s.id).projectId, converted.id);
});
test('terminal turn revisions persist unread markers independently from transient streams', async t => {
  const { service, a, home } = await setup(t);
  const p = await service.createProject('operator', { title: 'Notifications', cwd: a });
  const s = await service.createStream('operator', { projectId: p.id });
  await service.channel.turnStatus({ target: s.id }, { id: 'turn-1' }, 'completed');
  await service.channel.turnStatus({ target: s.id }, { id: 'turn-1' }, 'completed');
  assert.equal(service.stream('operator', s.id).completed, 1);
  assert.equal(service.snapshot('operator').projects[0].unread, true);
  await service.update('operator', 'stream', s.id, { read: true });
  assert.equal(service.stream('operator', s.id).unread, false);
  const persisted = JSON.parse(await readFile(path.join(home, 'workspace/state.json'), 'utf8'));
  assert.equal(persisted.streams[0].read, 1);
});
test('directory picker refuses traversal and symlink escapes outside operator roots', async t => {
  const { service, home } = await setup(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(home, 'escape'));
  await assert.rejects(service.files.resolve(outside), /outside/);
  assert.equal((await service.files.browse(home)).entries.some(e => e.name === 'escape'), false);
  await assert.rejects(service.createProject('operator', { title: 'No', cwd: outside }), /outside/);
});
test('domain persistence commits before notifications and throwing subscribers cannot roll it back', async t => {
  const { home } = await setup(t);
  const file = path.join(home, 'separate.json'); const store = new Store(file, { version: 1, value: 0 });
  await store.load(); let notification;
  store.subscribe(() => { notification = readFile(file, 'utf8').then(JSON.parse); throw Error('subscriber failed'); });
  await store.change(data => { data.value = 1; });
  assert.equal((await notification).value, 1); assert.equal(store.read().value, 1);
  await store.stop(); await assert.rejects(store.change(() => {}), /stopping/);
  await writeFile(file, JSON.stringify({ version: 1 }));
  await assert.rejects(new Store(file, { version: 1, value: 0 }).load(), /Invalid/);
});

test('ambiguous ingress retry preserves its original settings even after an operator settings change', async t => {
  const { service, a } = await setup(t);
  const project = await service.createProject('operator', { title: 'Retry', cwd: a });
  const stream = await service.createStream('operator', { projectId: project.id });
  await service.update('operator', 'global', null, { model: 'provider/original' });
  const inputs = []; await service.channel.start(async input => { inputs.push(input); if (inputs.length === 1) throw Error('Lost acceptance response'); });
  const message = { id: randomUUID(), text: 'Execute once' };
  await assert.rejects(service.submit('operator', stream.id, message), /Lost/);
  await service.update('operator', 'global', null, { model: 'provider/changed' });
  await service.submit('operator', stream.id, message);
  assert.deepEqual(inputs[0], inputs[1]);
  assert.equal(service.stream('operator', stream.id).messages.length, 1);
});
