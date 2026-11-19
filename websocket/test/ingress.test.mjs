import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Ingress, jsonHeartbeat, ruleGate } from '../ingress.mjs';
import { WebSockets } from '../service.mjs';
import { createWebSocketPlugin } from '../index.mjs';

const ctx = () => ({ owner: 'owner', connection: 'connection', eventId: 'event', send: async () => {} });
const frame = { encoding: 'utf8', data: 'job' };
async function until(fn) {
  for (let n = 0; n < 200; n++) { if (fn()) return; await delay(10); }
  assert.fail('Timed out');
}

test('plugin factory routes real incoming frames before Main via configured decision adapter', async t => {
  const dispatched = [], main = []; let tool, channel, stop;
  createWebSocketPlugin({ decide: async () => ({ target: 'dispatcher' }),
    routes: { dispatcher: async row => dispatched.push(row) } }).activate({
    registerTool: x => { tool = x; }, registerChannel: x => { channel = x; }, onStop: x => { stop = x; },
  });
  const client = new WebSockets();
  t.after(() => { client.stop(); stop(); });
  await channel.start(async event => main.push(event));
  const context = { sessionKey: 'owner' };
  const listener = JSON.parse(await tool.execute({ action: 'listen' }, context));
  const connection = await client.connect('client', { url: `ws://127.0.0.1:${listener.address.port}` });
  await client.send('client', connection.id, 'dispatch this');
  await until(() => dispatched.length === 1);
  assert.equal(main.length, 0); assert.equal(dispatched[0].owner, 'owner');
  await tool.execute({ action: 'configure', id: listener.id, profile: { gate: 'main' } }, context);
  await client.send('client', connection.id, 'explicit Main');
  await until(() => main.length === 1);
  assert.equal(dispatched.length, 1); assert.equal(main[0].target, dispatched[0].connection);
});

test('handler outcomes bypass decision, correlate explicitly, pass and normalize', async () => {
  let decisions = 0; const routed = [], correlated = [];
  const ingress = new Ingress({ decide: async () => { decisions++; return { target: 'dispatcher' }; },
    routes: { dispatcher: async x => routed.push(x) } });
  ingress.registerHandler('done', async () => ({ status: 'handled' }));
  ingress.registerHandler('reply', async () => ({ status: 'correlated', correlationId: 'job-1' }));
  ingress.registerHandler('skip', async () => ({ status: 'pass' }));
  ingress.registerHandler('normalize', async () => ({ status: 'forward', event: { task: 'normalized', owner: 'forged' } }));
  await ingress.process(frame, ctx(), ingress.profile({ handlers: [{ name: 'done' }] }));
  await ingress.process(frame, { ...ctx(), correlate: async x => correlated.push(x) }, ingress.profile({ handlers: [{ name: 'reply' }] }));
  assert.equal(decisions, 0); assert.equal(correlated[0].owner, 'owner');
  await ingress.process(frame, ctx(), ingress.profile({ handlers: [{ name: 'skip' }, { name: 'normalize' }] }));
  assert.equal(decisions, 1); assert.equal(routed[0].owner, 'owner');
  assert.equal(routed[0].event.task, 'normalized');
});

test('rules short-circuit decision fallback; all four targets are explicit adapters', async () => {
  let fallback = 0; const seen = [];
  const gate = ruleGate([event => event.data === 'known' ? { target: 'mechanical' } : null], async () => {
    fallback++; return { target: 'basic' };
  });
  const ingress = new Ingress({ routes: Object.fromEntries(['mechanical', 'basic', 'dispatcher', 'main'].map(x => [x, async () => seen.push(x)])) });
  ingress.registerGate('rules', gate);
  await ingress.process({ data: 'known' }, ctx(), ingress.profile({ gate: 'rules' }));
  await ingress.process(frame, ctx(), ingress.profile({ gate: 'rules' }));
  assert.equal(fallback, 1); assert.deepEqual(seen, ['mechanical', 'basic']);
  for (const target of ['dispatcher', 'main']) {
    ingress.registerGate(target + '-test', async () => ({ target }));
    await ingress.process(frame, ctx(), ingress.profile({ gate: target + '-test' }));
  }
  assert.deepEqual(seen, ['mechanical', 'basic', 'dispatcher', 'main']);
});

test('missing adapters, invalid results and cancelled processing never fall through to Main', async () => {
  const ingress = new Ingress();
  await assert.rejects(ingress.process(frame, ctx(), ingress.profile()), /Decision adapter/);
  ingress.registerGate('bad', async () => ({ target: 'unknown' }));
  await assert.rejects(ingress.process(frame, ctx(), ingress.profile({ gate: 'bad' })), /Invalid routing/);
  await assert.rejects(ingress.process(frame, ctx(), ingress.profile({ gate: 'main' })), /route adapter/);
  ingress.registerHandler('bad', async () => ({ status: 'mystery' }));
  await assert.rejects(ingress.process(frame, ctx(), ingress.profile({ handlers: [{ name: 'bad' }] })), /protocol result/);
  assert.throws(() => ingress.profile({ handlers: [{ name: 'missing' }] }), /Unknown protocol/);
  await assert.rejects(ingress.process(frame, { ...ctx(), signal: AbortSignal.abort() }, ingress.profile()));
});

test('loopback application heartbeat bypasses model; listener reconfiguration updates existing peers', async t => {
  let decisions = 0; const routed = [], raw = [];
  const ingress = new Ingress({ decide: async () => { decisions++; return { target: 'dispatcher' }; },
    routes: { dispatcher: async x => routed.push(x) } });
  ingress.registerHandler('json-heartbeat', jsonHeartbeat);
  const server = new WebSockets({ ingress });
  const client = new WebSockets({ deliver: async x => raw.push(x) });
  t.after(() => { server.stop(); client.stop(); });
  const listener = await server.listen('owner', { profile: { handlers: [{ name: 'json-heartbeat' }] } });
  const connection = await client.connect('client', { url: `ws://127.0.0.1:${listener.address.port}` });
  await client.send('client', connection.id, JSON.stringify({ type: 'ping', id: 'beat' }));
  await until(() => raw.length === 1);
  assert.equal(JSON.parse(JSON.parse(raw[0].text).data).type, 'pong');
  assert.equal(decisions, 0); assert.equal(routed.length, 0);
  server.configure('owner', listener.id, { handlers: [{ name: 'json-heartbeat', config: { requestType: 'beat', responseType: 'alive' } }] });
  await client.send('client', connection.id, JSON.stringify({ type: 'beat' }));
  await until(() => raw.length === 2);
  assert.equal(decisions, 0);
  await client.send('client', connection.id, 'actual job');
  await until(() => routed.length === 1);
  assert.equal(decisions, 1); assert.equal(routed[0].owner, 'owner');
  assert.throws(() => server.configure('stranger', listener.id, {}), /Unknown/);
});
