import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../index.mjs';
import { WebSockets } from '../service.mjs';

const until = async fn => {
  const end = Date.now() + 2000;
  while (!fn()) {
    if (Date.now() >= end) throw Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

for (const mode of ['success', 'unavailable', 'rejected']) {
  test(`host-bound Main ${mode}: socket-only, no channel fallback`, async t => {
    let tool, channel, stop, attempts = 0, fallback = 0;
    const replies = [], requests = [];
    const owner = 'original-operator';
    const binding = {
      async infer() { return { status: 'decision', target: 'main' }; },
    };
    if (mode !== 'unavailable') binding.main = async (id, input, send, target) => {
      attempts++;
      const event = JSON.parse(input);
      assert.equal(event.owner, owner);
      assert.equal(event.eventId, id);
      assert.equal(event.connection, target);
      assert.equal(event.event.data, 'main event');
      requests.push(id);
      if (mode === 'rejected') throw Error('Source mandate revoked');
      await send('main socket reply');
    };
    await plugin.activate({
      services: { get() { return { version: 1, implementation: { bind(key) {
        assert.equal(key, owner); return binding;
      } } }; } },
      registerTool(value) { tool = value; },
      registerChannel(value) { channel = value; },
      onStop(value) { stop = value; },
    });
    const client = new WebSockets({ deliver: async event => replies.push(JSON.parse(event.text).data) });
    t.after(() => { client.stop(); stop(); });
    await channel.start(async () => { fallback++; });
    const listener = JSON.parse(await tool.execute({ action: 'listen', profile: {
      gateConfig: { decision: { model: 'test/decision' } },
    } }, { sessionKey: owner }));
    const connection = await client.connect('peer', { url: `ws://127.0.0.1:${listener.address.port}` });
    const socket = client.connections.get(connection.id).socket;
    const closed = new Promise(resolve => socket.once('close', code => resolve(code)));
    await client.send('peer', connection.id, 'main event');
    if (mode === 'success') await until(() => replies.length > 0);
    else {
      const timeout = setTimeout(() => socket.terminate(), 2000);
      try { assert.equal(await closed, 1011); }
      finally { clearTimeout(timeout); }
    }
    assert.equal(fallback, 0);
    assert.equal(attempts, mode === 'unavailable' ? 0 : 1);
    if (mode === 'success') {
      assert.deepEqual(replies, ['main socket reply']);
      assert.equal(requests.length, 1);
    } else {
      assert.ok(!replies.includes('main socket reply'));
    }
  });
}
