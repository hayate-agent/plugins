// Optional integration against a sibling Core checkout; run with Core's tsx loader.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const core = path.resolve(process.argv[2] ?? '../../../core');
const fromCore = file => import(pathToFileURL(path.join(core, file)).href);
const { Harness } = await fromCore('src/harness.ts');
const { GatewayManager } = await fromCore('src/gateway-manager.ts');
const { SettingsService } = await fromCore('src/settings.ts');
const { PluginHost } = await fromCore('src/plugins.ts');
const { FakeRuntime } = await fromCore('test/fakes.ts');
const home = await mkdtemp(path.join(os.tmpdir(), 'webui-host-'));
const previousPort = process.env.HAYATE_WEBUI_PORT;
process.env.HAYATE_WEBUI_PORT = '0';
const runtime = new FakeRuntime();
const plugins = new PluginHost();
let manager;
const harness = new Harness({ runtime, tickMs: 60000, busyMode: 'queue',
  updateBlockers: () => [...plugins.updateBlockers(), ...(manager?.updateBlockers() ?? [])],
});
let releaseActive;
let eventsReader;
let mcp;
try {
  const module = fileURLToPath(new URL('../index.mjs', import.meta.url));
  const settings = new SettingsService(path.join(home, 'settings.local.yaml'), {});
  await settings.load(); await settings.setGatewayPlugin('webui', { module });
  manager = new GatewayManager(harness, settings, { home, agent: 'Test', approvers: [] }, {});
  await manager.load();
  await plugins.load([module], { home, agent: 'Test', cwd: home }, []);
  assert(plugins.tools.has('plugin_webui_settings'));
  assert.deepEqual(plugins.updateBlockers(), []);
  assert.deepEqual(manager.updateBlockers(), []);
  await harness.start();
  const channel = harness.channels.get('webui');
  const post = async (url, data) => {
    const response = await fetch(channel.url + url, { method: 'POST', headers: { Origin: channel.url, 'Content-Type': 'application/json', 'X-Hayate-WebUI': '1' }, body: JSON.stringify(data) });
    assert(response.ok, await response.clone().text()); return response.json();
  };
  const chat = await post('/api/chats', {});
  const message = { id: randomUUID(), text: 'Test actual host routing' };
  await post(`/api/chats/${chat.id}/messages`, message);
  await harness.drained();
  await post(`/api/chats/${chat.id}/messages`, message);
  await harness.drained();
  const transcript = await (await fetch(channel.url + `/api/chats/${chat.id}`)).json();
  assert.equal(transcript.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(transcript.messages.filter(m => m.role === 'assistant').length, 1);
  assert.match(transcript.messages.find(m => m.role === 'assistant').text, /Test actual host routing/);
  assert.equal(runtime.sessions.get(`webui:${chat.id}`).prompts.length, 1);
  // Browser connections are idle presentation resources, not permanent update blockers.
  const events = await fetch(channel.url + `/api/events?chat=${chat.id}`);
  eventsReader = events.body.getReader(); await eventsReader.read();
  assert.equal(harness.updateAdmissionStatus().status, 'idle');
  releaseActive = runtime.sessions.get(`webui:${chat.id}`).hold();
  const active = { id: randomUUID(), text: 'Held active work' };
  await post(`/api/chats/${chat.id}/messages`, active);
  assert.equal(harness.acquireUpdateAdmission(10000).status, 'busy');
  assert.equal(runtime.sessions.get(`webui:${chat.id}`).aborted, 0);
  releaseActive(); releaseActive = undefined; await harness.drained();
  const lease = harness.acquireUpdateAdmission(10000);
  assert.equal(lease.status, 'admitted'); assert(lease.lease_id);
  const retried = { id: randomUUID(), text: 'Retry after update lease' };
  const refused = await fetch(channel.url + `/api/chats/${chat.id}/messages`, {
    method: 'POST', headers: { Origin: channel.url, 'Content-Type': 'application/json', 'X-Hayate-WebUI': '1' }, body: JSON.stringify(retried),
  });
  assert.equal(refused.status, 500);
  assert.equal(harness.seenIds().includes(`webui:${chat.id}:${retried.id}`), false);
  assert.equal(runtime.sessions.get(`webui:${chat.id}`).prompts.length, 2);
  assert.equal(harness.releaseUpdateAdmission(lease.lease_id), true);
  await post(`/api/chats/${chat.id}/messages`, retried); await harness.drained();
  assert.equal(runtime.sessions.get(`webui:${chat.id}`).prompts.length, 3);
  if (typeof settings.setMcpEnabled === 'function') {
    const { McpManagement } = await fromCore('src/mcp-management.ts');
    const { installCommands } = await fromCore('src/commands.ts');
    mcp = new McpManagement({ agentDir: path.join(home, 'pi'), enabled: () => settings.effective().mcp?.enabled ?? false,
      setEnabled: value => settings.setMcpEnabled(value), changed: async () => {} });
    installCommands({ harness, mcp, approvals: { mode: 'off', tools: [] }, skills: () => [], reloadSkills: async () => { throw Error('MCP must not invoke skill discovery'); },
      personality: { available: async () => [], set: async () => {} }, admins: ['webui:local'], agent: 'Test', restart: async () => {}, cwdFor: () => home });
    const managed = await post('/api/chats', {});
    const submit = async text => { await post(`/api/chats/${managed.id}/messages`, { id: randomUUID(), text }); await harness.drained(); };
    await submit('/mcp add browser {"command":"node","enabled":false}');
    await submit('/mcp');
    let view = await (await fetch(channel.url + `/api/chats/${managed.id}`)).json();
    assert(view.messages.some(m => m.role === 'assistant' && /configuration saved/.test(m.text)));
    assert(view.messages.some(m => m.role === 'assistant' && /browser: disabled/.test(m.text)));
    assert.equal(runtime.sessions.has(`webui:${managed.id}`), false, 'browser MCP commands never open a model session');
    await submit('/mcp remove browser');
    view = await (await fetch(channel.url + `/api/chats/${managed.id}`)).json();
    assert(view.messages.some(m => m.role === 'assistant' && /browser: removed/.test(m.text)));
    console.log('Actual same-origin browser-to-Core /mcp add/status/remove passed without model turns.');
  } else console.log('MCP user-management integration not available in this older Core; not claimed tested.');
  const finalLease = harness.acquireUpdateAdmission(10000);
  assert.equal(finalLease.status, 'admitted');
  await harness.stop(1000); await plugins.stop();
  while (!(await eventsReader.read()).done) { /* ordered shutdown closes SSE */ }
  console.log('Actual Core checks passed: plugin/gateway loading, routing, deduplication, idle/busy admission, lease fencing, same-ID retry and shutdown with an open SSE connection.');
} finally {
  releaseActive?.();
  await mcp?.close();
  await eventsReader?.cancel().catch(() => {});
  await harness.stop(1000); await plugins.stop();
  if (previousPort === undefined) delete process.env.HAYATE_WEBUI_PORT; else process.env.HAYATE_WEBUI_PORT = previousPort;
  await rm(home, { recursive: true, force: true });
}
