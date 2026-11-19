import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../index.mjs';
import { WebSockets } from '../service.mjs';
const until = async fn => { const end = Date.now() + 2000; while (!fn()) { if (Date.now() >= end) throw Error('Timed out'); await new Promise(r => setTimeout(r, 5)); } };

test('stock entrypoint uses host binding for Decision, Basic and socket-only Dispatcher events', async t => {
  const calls = [], replies = []; let tool, channel, stop, target = 'basic';
  const owner = 'original-operator';
  const binding = {
    async infer(request) {
      calls.push(request);
      if (request.mode === 'decision') return { status: 'decision', target };
      return { status: 'basic', text: 'basic reply' };
    },
    async dispatch(id, input, send) {
      assert.ok(id); assert.equal(JSON.parse(input).owner, owner);
      await send(JSON.stringify({ type: 'websocket.dispatch.result', text: 'worker result' }));
      return { id: 'durable-execution' };
    },
  };
  await plugin.activate({
    services: { get(name) { assert.equal(name, 'ingress'); return { version: 1, implementation: { bind(key) { assert.equal(key, owner); return binding; } } }; } },
    registerTool(value) { tool = value; }, registerChannel(value) { channel = value; }, onStop(value) { stop = value; },
  });
  const client = new WebSockets({ deliver: async e => replies.push(JSON.parse(e.text).data) });
  t.after(() => { client.stop(); stop(); });
  await channel.start(async () => { assert.fail('Traffic must not reach Main'); });
  const listener = JSON.parse(await tool.execute({ action: 'listen', profile: { handlers: [{ name: 'json-heartbeat' }],
    gateConfig: { decision: { model: 'test/decision' }, basic: { model: 'test/basic' } } } }, { sessionKey: owner }));
  const conn = await client.connect('peer', { url: `ws://127.0.0.1:${listener.address.port}` });
  await client.send('peer', conn.id, '{"type":"ping"}');
  await until(() => replies.length === 1);
  assert.equal(calls.length, 0);
  await client.send('peer', conn.id, 'simple event');
  await until(() => replies.includes('basic reply'));
  assert.deepEqual(calls.map(r => [r.mode, r.requested.model]), [['decision', 'test/decision'], ['basic', 'test/basic']]);
  target = 'dispatcher';
  await client.send('peer', conn.id, 'work event');
  await until(() => replies.some(x => x.includes('dispatch.accepted')));
  assert.ok(replies.some(x => x.includes('worker result')));
  assert.equal(calls.length, 3);
});
