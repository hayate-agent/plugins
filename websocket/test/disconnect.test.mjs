import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSockets } from '../service.mjs';

for (const reconnectMs of [undefined, 0, 100]) {
  test(`remote close cancels terminal ingress, preserves reconnect (${reconnectMs})`, async () => {
    let release, started;
    const began = new Promise(resolve => { started = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    let effects = 0;
    const service = new WebSockets({ ingress: { async process(frame, context) {
      started(); await hold; context.signal.throwIfAborted(); effects++;
    } } });
    const socket = new EventEmitter(); socket.close = () => {};
    const row = { id: 'test', owner: 'owner', socket, pending: 0, closed: false,
      reconnectMs, controller: new AbortController() };
    service.connections.set(row.id, row); service.attach(row, socket);
    socket.emit('message', Buffer.from('frame'), false); await began;
    socket.emit('close'); release(); await row.tail;
    assert.equal(row.controller.signal.aborted, !reconnectMs);
    assert.equal(effects, reconnectMs ? 1 : 0);
    assert.equal(service.connections.has(row.id), !!reconnectMs);
    assert.equal(row.pending, 0);
  });
}

test('real remote client close aborts a blocked server ingress', async t => {
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  let captured;
  const service = new WebSockets({ ingress: { profile: () => ({}), async process(frame, context) {
    captured = context.signal; entered();
    if (!captured.aborted) await new Promise(resolve => captured.addEventListener('abort', resolve, { once: true }));
  } } });
  t.after(() => service.stop());
  const listener = await service.listen('server');
  const client = await service.connect('client', { url: `ws://127.0.0.1:${listener.address.port}` });
  await service.send('client', client.id, 'frame'); await began;
  service.close('client', client.id);
  for (let i = 0; i < 200 && !captured.aborted; i++) await delay(5);
  assert.equal(captured.aborted, true);
});
