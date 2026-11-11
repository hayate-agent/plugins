import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const core = process.env.HARNESS_CORE_ROOT;
test('actual Core hot replacement removes legacy Slack admission blocker without overlapping receivers',
  { skip: !core && 'Set HARNESS_CORE_ROOT to the materialized Core checkout' }, async () => {
  const { Harness } = await import(pathToFileURL(path.join(core, 'src/harness.ts')));
  const { GatewayManager } = await import(pathToFileURL(path.join(core, 'src/gateway-manager.ts')));
  const { FakeRuntime } = await import(pathToFileURL(path.join(core, 'test/fakes.ts')));
  const moduleUrl = new URL('../src/slack-gateway.mjs', import.meta.url).href;
  const home = await mkdtemp(path.join(os.tmpdir(), 'slack-owner-host-'));
  const saved = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket,
    app: process.env.SLACK_APP_TOKEN, bot: process.env.SLACK_BOT_TOKEN };
  let active = 0, maximum = 0, connections = 0;
  class Socket extends EventTarget {
    readyState = 0;
    constructor() { super(); connections++; active++; maximum = Math.max(maximum, active);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    close() { if (this.readyState === 3) return; this.readyState = 3; active--; this.dispatchEvent(new Event('close')); }
    send() {}
  }
  globalThis.WebSocket = Socket;
  globalThis.fetch = async url => ({ ok: true, json: async () => url.endsWith('auth.test')
    ? { ok: true, team_id: 'T1', user_id: 'UBOT' } : { ok: true, url: 'wss://example.test' } });
  process.env.SLACK_APP_TOKEN = 'fixture-app'; process.env.SLACK_BOT_TOKEN = 'fixture-bot';
  await writeFile(path.join(home, 'legacy.mjs'), `import plugin from ${JSON.stringify(moduleUrl)}; export default {apiVersion:1, create:plugin.create};`);
  let spec = { module: 'legacy.mjs' };
  const settings = { desired: () => ({ gatewayPlugins: { slack: spec } }), appliedPlugin() {} };
  let manager;
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000,
    updateBlockers: () => manager.updateBlockers() });
  harness.onStateChange = async () => {};
  manager = new GatewayManager(harness, settings, { home, agent: 'test', approvers: [], inboundAttachments: 1 }, {});
  try {
    await manager.load(); await harness.start();
    assert.equal(harness.updateAdmissionStatus().status, 'unavailable');
    assert.deepEqual(manager.updateBlockers(), ['unsupported update owner: gateway slack']);
    spec = { module: new URL(moduleUrl).pathname };
    await manager.request('slack'); await manager.tick();
    assert.deepEqual(manager.updateBlockers(), []);
    assert.equal(connections, 2); assert.equal(active, 1); assert.equal(maximum, 1);
    const admission = harness.acquireUpdateAdmission(30000);
    assert.equal(admission.status, 'admitted'); assert.deepEqual(admission.blockers, []);
    assert.ok(admission.lease_id);
  } finally {
    await harness.stop();
    globalThis.fetch = saved.fetch; globalThis.WebSocket = saved.WebSocket;
    for (const [name, value] of [['SLACK_APP_TOKEN', saved.app], ['SLACK_BOT_TOKEN', saved.bot]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
  assert.equal(active, 0);
});
