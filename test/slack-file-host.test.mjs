import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const core = process.env.HARNESS_CORE_ROOT;

test('actual Core file tool snapshots bytes and sends through configured Slack in a new channel post',
  { skip: !core || !existsSync(path.join(core, 'src/outbound-files.ts')) ? 'Requires Core outbound attachment contract' : false }, async () => {
  const { Harness } = await import(pathToFileURL(path.join(core, 'src/harness.ts')));
  const { SettingsService } = await import(pathToFileURL(path.join(core, 'src/settings.ts')));
  const { GatewayManager } = await import(pathToFileURL(path.join(core, 'src/gateway-manager.ts')));
  const { PluginHost } = await import(pathToFileURL(path.join(core, 'src/plugins.ts')));
  const { messagePlugin } = await import(pathToFileURL(path.join(core, 'src/message-plugin.ts')));
  const { FakeRuntime } = await import(pathToFileURL(path.join(core, 'test/fakes.ts')));
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'slack-file-host-')));
  const home = path.join(root, 'agent'), cwd = path.join(root, 'work'); await mkdir(home); await mkdir(cwd);
  const bytes = Buffer.from([0, 255, 17, 42]); await writeFile(path.join(cwd, 'binary.dat'), bytes);
  const names = ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_TEAM_ID', 'SLACK_CHANNEL_IDS'];
  const saved = names.map(name => process.env[name]), savedFetch = globalThis.fetch, savedSocket = globalThis.WebSocket;
  for (const name of names) delete process.env[name];
  process.env.SLACK_APP_TOKEN = 'fixture-app'; process.env.SLACK_BOT_TOKEN = 'fixture-bot';
  let transfers = 0, completion;
  class Socket extends EventTarget {
    readyState = 0;
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
    send() {}
  }
  globalThis.WebSocket = Socket;
  globalThis.fetch = async (url, init) => {
    if (url.startsWith('https://files.slack.com/')) { transfers++; assert.deepEqual(init.body, bytes); return { ok: true }; }
    const method = new URL(url).pathname.split('/').pop();
    const result = method === 'auth.test' ? { team_id: 'T1', user_id: 'UBOT' }
      : method === 'apps.connections.open' ? { url: 'wss://example.test' }
      : method === 'files.getUploadURLExternal' ? { upload_url: 'https://files.slack.com/upload/file', file_id: 'F123' }
      : {};
    if (method === 'files.completeUploadExternal') completion = JSON.parse(init.body);
    return { ok: true, json: async () => ({ ok: true, ...result }) };
  };
  const settings = new SettingsService(path.join(home, 'settings.yaml'), { gateways: { overrides: { slack: {
    conversation: { allowedChannels: '*', defaults: { users: '*', activation: 'open', replyLocation: 'channel' } },
  } } } }); await settings.load();
  await settings.setGatewayPlugin('slack', { module: new URL('../src/slack-gateway.mjs', import.meta.url).pathname });
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, gateways: settings.effective().gateways }); harness.onStateChange = async () => {};
  const manager = new GatewayManager(harness, settings, { home, agent: 'any', approvers: [], inboundAttachments: 1, outboundAttachments: 1 }, {});
  try {
    await manager.load(); await harness.start();
    assert.equal(manager.messagingCapabilities()[0].messaging.files, true);
    assert.equal(manager.messagingCapabilities()[0].messaging.conversation.defaults.activation, 'open');
    const plugins = new PluginHost(); await plugins.load([messagePlugin(home, manager)], { home, cwd, agent: 'any' }, []);
    const tool = plugins.tools.get('plugin_message');
    const input = { action: 'send', gateway: 'slack', target: 'C1', text: 'caption', file: { path: 'binary.dat' }, requestId: 'binary-1' };
    const receipt = JSON.parse(await tool.execute(input, { sessionKey: 'api:origin', cwd })); assert.equal(receipt.status, 'delivered');
    assert.equal(completion.channel_id, 'C1'); assert.equal(completion.thread_ts, undefined); assert.equal(completion.initial_comment, 'caption');
    await tool.execute(input, { sessionKey: 'api:origin', cwd }); assert.equal(transfers, 1);
  } finally {
    await harness.stop(); globalThis.fetch = savedFetch; globalThis.WebSocket = savedSocket;
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
    await rm(root, { recursive: true, force: true });
  }
});
