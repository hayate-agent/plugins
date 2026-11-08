// Run: node --import <core>/node_modules/tsx/dist/loader.mjs workspace/test/host.mjs <core>
import assert from 'node:assert/strict';
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
const harness = new Harness({ runtime, tickMs: 60000, updateBlockers: () => host.updateBlockers() });
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
  assert.equal(workspace.stream('operator', stream.id).unread, true);
  assert.equal(harness.acquireUpdateAdmission(1000).status, 'admitted');
  console.log('Headless workspace: real host service/channel registration, commands, context binding, durable reply, deduplication and admission passed without WebUI.');
} finally { await harness.stop(1000); await host.stop(); await rm(home, { recursive: true, force: true }); }
