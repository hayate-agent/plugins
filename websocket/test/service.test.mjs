import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSockets } from '../service.mjs';
import plugin from '../index.mjs';

async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  assert.fail('Timed out');
}

test('persistent client/server, ordered text and binary events, owner isolation and replies', async t => {
  const events = []; const service = new WebSockets({ deliver: async event => { events.push(event); } });
  t.after(() => service.stop());
  const listener = await service.listen('server', {});
  const client = await service.connect('client', { url: `ws://127.0.0.1:${listener.address.port}` });
  await service.send('client', client.id, 'hello');
  await service.send('client', client.id, 'AAEC', 'base64');
  await until(() => events.length === 2);
  assert.equal(events[0].session, 'server');
  assert.equal(JSON.parse(events[0].text).data, 'hello');
  assert.equal(JSON.parse(events[1].text).encoding, 'base64');
  assert.equal(JSON.parse(events[1].text).data, 'AAEC');
  const peer = JSON.parse(events[0].text).connection;
  await assert.rejects(service.send('other', peer, 'bad'), /Unknown/);
  assert.equal(service.list('other').connections.length, 0);
  await service.send('server', peer, 'reply');
  await until(() => events.length === 3);
  assert.equal(events[2].session, 'client');
  service.close('server', listener.id);
  await until(() => service.list('client').connections.length === 0);
});

test('auth rejection is sanitized, failed connects clean up, shutdown idempotent', async t => {
  const service = new WebSockets(); t.after(() => service.stop());
  const listener = await service.listen('owner', { token: 'private-test-token' });
  const url = `ws://127.0.0.1:${listener.address.port}`;
  await assert.rejects(service.connect('client', { url }), /^Error: WebSocket connection failed$/);
  assert.equal(service.list('client').connections.length, 0);
  await service.connect('client', { url, headers: { Authorization: 'Bearer private-test-token' } });
  service.stop(); service.stop();
  assert.equal(service.connections.size, 0); assert.equal(service.listeners.size, 0);
  await assert.rejects(service.connect('client', { url }), /stopped/);
});

test('reconnect keeps client id without replaying sent frames', async t => {
  const events = []; const service = new WebSockets({ deliver: async e => events.push(e) });
  t.after(() => service.stop());
  const listener = await service.listen('server', {});
  const client = await service.connect('client', { url: `ws://127.0.0.1:${listener.address.port}`, reconnectMs: 15 });
  await service.send('client', client.id, 'once');
  await until(() => events.length === 1);
  const peer = service.list('server').connections[0];
  service.close('server', peer.id);
  await until(() => service.list('server').connections.some(row => row.id !== peer.id));
  assert.equal(service.list('client').connections[0].id, client.id);
  await delay(40); assert.equal(events.length, 1);
  await service.send('client', client.id, 'twice');
  await until(() => events.length === 2);
});

test('limits, cancelled connect and plugin registration/channel lifecycle', async t => {
  const service = new WebSockets({ maxPayload: 4 }); t.after(() => service.stop());
  const listener = await service.listen('server', {});
  const client = await service.connect('client', { url: `ws://127.0.0.1:${listener.address.port}` });
  await assert.rejects(service.send('client', client.id, 'too long'), /too large/);
  await assert.rejects(service.connect('client', { url: 'https://example.test' }), /ws or wss/);
  await assert.rejects(service.connect('client', { url: 'ws://127.0.0.1', signal: AbortSignal.abort() }), /cancelled/);
  let channel, tool, stop;
  plugin.activate({ registerChannel: c => { channel = c; }, registerTool: x => { tool = x; }, onStop: fn => { stop = fn; } });
  t.after(() => stop());
  await channel.start(async () => {});
  assert.equal(tool.name, 'plugin_websocket');
  const result = JSON.parse(await tool.execute({ action: 'listen' }, { sessionKey: 'owner' }));
  assert.equal(result.kind, 'listener');
  assert.equal(JSON.parse(await tool.execute({ action: 'list' }, { sessionKey: 'other' })).listeners.length, 0);
  await channel.stop(); await stop();
});
