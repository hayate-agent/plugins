// Run: node --import <core>/node_modules/tsx/dist/loader.mjs workspace/test/host.mjs <core>
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const core = path.resolve(process.argv[2]);
const load = file => import(pathToFileURL(path.join(core, file)).href);
const { Harness } = await load('src/harness.ts');
const { PluginHost } = await load('src/plugins.ts');
const { ExecutionContexts } = await load('src/execution-contexts.ts');
const { FakeRuntime } = await load('test/fakes.ts');
const home = await mkdtemp(path.join(os.tmpdir(), 'workspace-host-'));
const directory = path.join(home, 'repo'); await mkdir(directory);
const host = new PluginHost(); const runtime = new FakeRuntime();
const harness = new Harness({ runtime, attachmentRoot: path.join(home, 'attachments'), tickMs: 60000, updateBlockers: () => host.updateBlockers() });
const contexts = new ExecutionContexts(path.join(home, 'contexts.json'), home); await contexts.load();
const files = ['credentials/index.mjs', 'workspace/index.mjs'].map(file => pathToFileURL(path.resolve(new URL('../../', import.meta.url).pathname, file)).href);
try {
  await host.load(files.map(url => new URL(url).pathname), { home, cwd: home, agent: 'Test', executionContexts: {
    get: key => contexts.get(key), bind: (key, value) => harness.withForegroundWork(() => contexts.bind(key, value)),
  }, foregroundWork: work => harness.withForegroundWork(work) }, [], []);
  const workspace = host.services.get('workspaces').implementation;
  const command = host.commands.get('workspace');
  const project = JSON.parse(await command.run('project ' + JSON.stringify({ title: 'Headless project', cwd: directory }), { sessionKey: 'console:local' }));
  const stream = JSON.parse(await command.run('stream ' + JSON.stringify({ projectId: project.id }), { sessionKey: 'console:local' }));
  assert.equal(contexts.get(`plugin:workspaces:${stream.id}`).cwd, directory);
  for (const channel of host.channels.values()) harness.addChannel(channel);
  await harness.start();
  const message = { id: randomUUID(), streamId: stream.id, text: 'Headless delegated context' };
  await command.run('send ' + JSON.stringify(message), { sessionKey: 'console:local' }); await harness.drained();
  await command.run('send ' + JSON.stringify(message), { sessionKey: 'console:local' }); await harness.drained();
  assert.equal(runtime.sessions.get(`plugin:workspaces:${stream.id}`).prompts.length, 1);
  assert.equal(workspace.stream('operator', stream.id).messages.filter(m => m.role === 'assistant').length, 1);
  // drained() can precede the channel's persisted terminal status callback.
  // Duplicate acceptance no longer delivers again merely to wait for that callback.
  for (let i = 0; i < 100 && !workspace.stream('operator', stream.id).unread; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(workspace.stream('operator', stream.id).unread, true);
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } }).png().toBuffer();
  const chunk = { uploadId: randomUUID(), index: 0, data: png.toString('base64'), mimeType: 'image/png', final: true };
  if (workspace.imageUploads) {
   const media = await workspace.uploadMedia('operator', stream.id, chunk);
   await workspace.submit('operator', stream.id, { id: randomUUID(), text: '', attachments: [{ id: media.id }] });
   await harness.drained();
   const images = runtime.sessions.get(`plugin:workspaces:${stream.id}`).options.at(-1).images;
   assert.deepEqual(images, [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
   assert.deepEqual(workspace.snapshot('operator').streams.find(value => value.id === stream.id).features, ['image-prompt-v1']);
  } else {
   // Core without channel attachments: refuse explicitly, never drop images silently.
   await assert.rejects(workspace.uploadMedia('operator', stream.id, chunk), /Update the Hayate host/);
   await assert.rejects(workspace.submit('operator', stream.id, { id: randomUUID(), text: '', attachments: [{ id: 'x' }] }), /Update the Hayate host/);
   assert.deepEqual(workspace.snapshot('operator').streams.find(value => value.id === stream.id).features, []);
  }
  assert.equal(harness.acquireUpdateAdmission(1000).status, 'admitted');
  console.log('Headless workspace: real host service/channel registration, commands, context binding, durable reply, deduplication and admission passed without WebUI.');
} finally { await harness.stop(1000); await host.stop(); await rm(home, { recursive: true, force: true }); }
