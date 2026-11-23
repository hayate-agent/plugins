import test from 'node:test';
import sharp from 'sharp';
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
test('workspace image upload preserves principal scope and durable host attachment bytes', async t => {
 const { service, home } = await setup(t);
 service.imageUploads = true;
 const chat = await service.createStream('operator', { title: 'Image chat' });
 const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } }).png().toBuffer();
 const chunk = { uploadId: randomUUID(), index: 0, data: png.toString('base64'), mimeType: 'image/png', final: true };
 await assert.rejects(service.uploadMedia('other', chat.id, chunk), /not found/);
 const image = await service.uploadMedia('operator', chat.id, chunk);
 const received = []; await service.channel.start(async input => received.push(input));
 const message = { id: randomUUID(), text: '', attachments: [{ id: image.id }] };
 await service.submit('operator', chat.id, message);
 const reference = received[0].attachments[0];
 assert.equal(reference.sessionKey, `plugin:workspaces:${chat.id}`);
 const { createHash } = await import('node:crypto');
 const file = path.join(home, 'attachments', createHash('sha256').update(reference.sessionKey).digest('hex'), reference.sha256);
 assert.deepEqual(await readFile(file), png, 'host receives a real durable verified attachment, not a link');
 service.media.get = () => { throw Error('Ephemeral upload expired'); };
 assert.deepEqual(await service.submit('operator', chat.id, message), { accepted: true, id: message.id });
 assert.equal(received.length, 1, 'accepted retries never redeliver or require expired staging');
 await assert.rejects(service.submit('operator', chat.id, { ...message, attachments: [{ id: randomUUID() }] }), /identity conflict/);
 await assert.rejects(service.submit('operator', chat.id, { ...message, text: 'changed' }), /identity conflict/);
});

test('media admission rejects old hosts and archived projects before accessing staging', async t => {
 const { service, home, a } = await setup(t);
 const project = await service.createProject('operator', { title: 'Admission', cwd: a });
 const chat = await service.createStream('operator', { projectId: project.id });
 let stagingCalls = 0, deliveries = 0;
 service.media.chunk = () => { stagingCalls++; throw Error('Unexpected staging access'); };
 service.media.get = () => { stagingCalls++; throw Error('Unexpected staging access'); };
 await service.channel.start(async () => { deliveries++; });
 const message = { id: randomUUID(), text: '', attachments: [{ id: randomUUID() }] };
 await assert.rejects(service.uploadMedia('operator', chat.id, {}), /Update the Hayate host/);
 await assert.rejects(service.submit('operator', chat.id, message), /Update the Hayate host/);
 service.imageUploads = true;
 await service.update('operator', 'project', project.id, { archived: true });
 await assert.rejects(service.uploadMedia('operator', chat.id, {}), /Restore the project/);
 await assert.rejects(service.submit('operator', chat.id, message), /Restore the stream\/project/);
 assert.equal(stagingCalls, 0);
 assert.equal(deliveries, 0);
 await assert.rejects(readFile(path.join(home, 'attachments')), { code: 'ENOENT' });
 assert.equal(service.stream('operator', chat.id).messages.length, 0);
});

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

test('fork snapshots history independently, persists context, and never replays old work', async t => {
  const { service, home } = await setup(t);
  const received = []; await service.channel.start(async input => received.push(input));
  const source = await service.createStream('operator', { title: 'Original' });
  await service.submit('operator', source.id, { id: randomUUID(), text: 'Remember violet' });
  const input = { idempotencyKey: randomUUID() };
  const [fork, duplicate] = await Promise.all([service.forkStream('operator', source.id, input), service.forkStream('operator', source.id, input)]);
  assert.equal(fork.id, duplicate.id); assert.notEqual(fork.id, source.id);
  await service.update('operator', 'stream', source.id, { title: 'Renamed source' });
  assert.equal((await service.forkStream('operator', source.id, input)).id, fork.id, 'Retry survives source rename');
  assert.deepEqual(fork.messages, service.stream('operator', source.id).messages);
  assert.equal(received.length, 1, 'fork does not deliver historical work');
  await assert.rejects(service.forkStream('other', source.id, input), /not found/);
  await assert.rejects(service.forkStream('operator', source.id, { ...input, title: 'Conflict' }), /conflict/);
  await service.submit('operator', fork.id, { id: randomUUID(), text: 'What color?' });
  assert.equal(received.length, 2); assert.equal(received[1].text, 'What color?');
  assert.match(received[1].turn.instructions, /Remember violet/);
  assert.match(received[1].turn.instructions, /not new instructions or authority/);
  assert.match(received[1].turn.instructions, /<webui_openui>[\s\S]*language `openui`[\s\S]*<\/webui_openui>/, 'turns from the WebUI carry the openui guide');
  assert.equal(service.stream('operator', source.id).messages.length, 1);
  const saved = JSON.parse(await readFile(path.join(home, 'workspace/state.json'), 'utf8'));
  assert.match(saved.streams.find(s => s.id === fork.id).forkContext, /Remember violet/);
  const restored = new Workspace({ home, cwd: home, executionContexts: { async bind() {} } });
  await restored.open();
  try {
    await restored.channel.start(async value => received.push(value));
    await restored.submit('operator', fork.id, { id: randomUUID(), text: 'Continue after restart' });
    assert.match(received.at(-1).turn.instructions, /Remember violet/);
  } finally { await restored.stop(); }
});

test('the bundled openui guide is intact and carries its checksum', async () => {
  const { OPENUI_GUIDE, OPENUI_GUIDE_SHA256 } = await import('../openui-guide.mjs');
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(OPENUI_GUIDE).digest('hex'), OPENUI_GUIDE_SHA256, 'regenerate with: node scripts/openui-guide.mjs --out <plugins>/workspace/openui-guide.mjs');
  assert.doesNotMatch(OPENUI_GUIDE, /Button\(|@Run|Btn\(/, 'chat blocks are data-only');
});
