import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from '../../agent-link/vendor/websocket.mjs';
import { WebUIChannel } from '../index.mjs';
test('browser live channel pushes authorized revisions; GET/HEAD reads forbid mutations and clean subscriptions', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'browser-live-')); const subscribers = new Set(), requests = []; let revision = 'one', releaseSubscription;
 const released = new Promise(resolve => { releaseSubscription = resolve; });
 const relay = { subscribe(owner, listener) { assert.equal(owner, 'operator'); subscribers.add(listener); return () => { subscribers.delete(listener); releaseSubscription(); }; }, revision: () => revision };
 const hub = { async request(owner, agent, capability, input) { requests.push({ owner, agent, capability, input }); return { messages: [] }; } };
 const services = { get: name => ['agent-link-relay', 'agent-hub'].includes(name) ? { version: 1, implementation: name === 'agent-hub' ? hub : relay } : undefined };
 const channel = new WebUIChannel({ home, port: 0, services }); await channel.start(async () => {}); let socket;
 try {
  socket = new WebSocket(channel.url.replace('http:', 'ws:') + '/api/workspace/live', 'hayate.workspace.v1', { origin: channel.url });
  const first = JSON.parse((await once(socket, 'message'))[0]); assert.equal(first.revision, 'one');
  const changed = once(socket, 'message'); revision = 'two'; for (const send of subscribers) send({ type: 'changed', revision });
  assert.equal(JSON.parse((await changed)[0]).revision, 'two');
  const head = await fetch(channel.url + '/api/workspace/revision', { method: 'HEAD', headers: { 'If-None-Match': '"two"' } });
  assert.equal(head.status, 304); assert.equal(requests.length, 0, 'revision HEAD must not read remote transcripts');
  const query = new URLSearchParams({ capability: 'messages', input: JSON.stringify({ action: 'read', streamId: 'session' }) });
  assert.equal((await fetch(channel.url + '/api/workspace/agents/agent/read?' + query)).status, 200);
  assert.equal(requests[0].owner, 'operator');
  query.set('input', JSON.stringify({ action: 'send', streamId: 'session', text: 'forbidden' }));
  assert.equal((await fetch(channel.url + '/api/workspace/agents/agent/read?' + query)).status, 405); assert.equal(requests.length, 1);
  const closed = once(socket, 'close'); socket.close(); await closed;
  await released; assert.equal(subscribers.size, 0);
 } finally { socket?.terminate(); await channel.stop(); await rm(home, { recursive: true, force: true }); }
});

test('browser live channel forwards stream envelopes only for the principal\'s registered relay agent', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'browser-stream-')); const subscribers = new Set(), requests = [];
 const relay = { subscribe(owner, listener) { subscribers.add(listener); return () => subscribers.delete(listener); }, revision: () => 'one' };
 let registered = true, denied = false;
 const hub = { list: owner => owner === 'operator' && registered ? [{ id: 'hub-agent', adapter: 'hayate-wss', endpoint: 'https://relay.example/agents/relay-target' }] : [], async request(...args) { requests.push(args); if (denied) throw Object.assign(Error('Stream is not shared'), { status: 403 }); return args[3]?.action === 'changes' ? { epoch: 'e', session: 's', seq: args[3].since + 1, events: [{ v: 1, epoch: 'e', session: 's', seq: args[3].since + 1, kind: 'turn.status', data: { busy: false } }], more: false } : {}; } };
 const services = { get: name => ['agent-link-relay', 'agent-hub'].includes(name) ? { version: 1, implementation: name === 'agent-hub' ? hub : relay } : undefined };
 const channel = new WebUIChannel({ home, port: 0, services }); await channel.start(async () => {}); let socket;
 try {
  assert.equal((await (await fetch(channel.url + '/api/workspace/capabilities')).json())['browser-stream-v1'], 1);
  socket = new WebSocket(channel.url.replace('http:', 'ws:') + '/api/workspace/live', 'hayate.workspace.v1', { origin: channel.url });
  await once(socket, 'message');
  const envelope = { v: 1, epoch: 'e', session: 's', seq: 1, kind: 'text.delta', data: { delta: 'hi' } };
  const next = once(socket, 'message');
  for (const send of subscribers) { send({ type: 'event', relayAgent: 'unknown-target', envelope }); send({ type: 'event', relayAgent: 'relay-target', envelope }); }
  assert.deepEqual(JSON.parse((await next)[0]), { type: 'event', agentId: 'hub-agent', envelope });
  assert.equal(requests.length, 0, 'deltas never trigger agent reads');
  const query = new URLSearchParams({ capability: 'messages', input: JSON.stringify({ action: 'changes', streamId: 's', since: 0 }) });
  assert.equal((await fetch(channel.url + '/api/workspace/agents/hub-agent/read?' + query)).status, 200, 'changes fallback is a read');
  assert.equal(requests.length, 1, 'without a cached epoch the agent answers');
  const cached = new URLSearchParams({ capability: 'messages', input: JSON.stringify({ action: 'changes', streamId: 's', since: 0, epoch: 'e' }) });
  const body = await (await fetch(channel.url + '/api/workspace/agents/hub-agent/read?' + cached)).json();
  assert.deepEqual(body.events.map(event => event.seq), [1, 2], 'cached window plus the agent-confirmed head');
  assert.equal(body.more, false); assert.equal(body.cached, 1);
  assert.equal(requests.length, 2); assert.equal(requests[1][3].since, 1, 'agent is asked only for events after the cached head');
  // Combined answer stays inside one page budget (≤128 events, ≤200000 bytes).
  const big = 'x'.repeat(60_000);
  for (let seq = 2; seq <= 6; seq++) for (const send of subscribers) send({ type: 'event', relayAgent: 'relay-target', envelope: { v: 1, epoch: 'e', session: 's', seq, kind: 'text.delta', data: { delta: big } } });
  await new Promise(resolve => setTimeout(resolve, 50));
  const bounded = await (await fetch(channel.url + '/api/workspace/agents/hub-agent/read?' + cached)).json();
  assert.ok(JSON.stringify(bounded.events).length <= 200_000); assert.equal(bounded.more, true, 'truncated answer reports more');
  assert.deepEqual(bounded.events.map(event => event.seq), [1, 2, 3, 4], 'contiguous prefix only');
  assert.equal(bounded.seq, 4, 'cursor of a truncated answer is its last event');
  const nextQuery = new URLSearchParams({ capability: 'messages', input: JSON.stringify({ action: 'changes', streamId: 's', since: bounded.seq, epoch: 'e' }) });
  const following = await (await fetch(channel.url + '/api/workspace/agents/hub-agent/read?' + nextQuery)).json();
  assert.equal(following.events[0].seq, 5, 'resuming from the cursor continues without a gap');
  assert.deepEqual(following.events.map(event => event.seq), [5, 6, 7]);
  // More than 128 cached events: the answer stays contiguous and reports more,
  // even if the agent claims nothing newer than the cached cursor.
  for (let seq = 8; seq <= 300; seq++) for (const send of subscribers) send({ type: 'event', relayAgent: 'relay-target', envelope: { v: 1, epoch: 'e', session: 's', seq, kind: 'text.delta', data: { delta: 'y' } } });
  await new Promise(resolve => setTimeout(resolve, 50));
  const deep = new URLSearchParams({ capability: 'messages', input: JSON.stringify({ action: 'changes', streamId: 's', since: 7, epoch: 'e' }) });
  const deepAnswer = await (await fetch(channel.url + '/api/workspace/agents/hub-agent/read?' + deep)).json();
  assert.equal(deepAnswer.events.length, 128); assert.equal(deepAnswer.events[0].seq, 8); assert.equal(deepAnswer.seq, 135);
  assert.equal(deepAnswer.more, true, 'truncated cache window always reports more');
  assert.ok(deepAnswer.events.every((event, index) => event.seq === 8 + index), 'contiguous');
  // Revocation at the target: the agent denies and nothing cached is returned.
  denied = true;
  const revoked = await fetch(channel.url + '/api/workspace/agents/hub-agent/read?' + cached);
  assert.equal(revoked.status, 403); assert.doesNotMatch(await revoked.text(), /"delta"/);
  denied = false; registered = false;
  await fetch(channel.url + '/api/workspace/agents/hub-agent/read?' + cached);
  assert.equal(requests.at(-1)[3].since, 0, 'unregistered agent: no cache use, the hub decides');
 } finally { socket?.terminate(); await channel.stop(); await rm(home, { recursive: true, force: true }); }
});

test('a browser that cannot keep up with stream events is disconnected for resync, not silently skipped', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'browser-stream-slow-')); const subscribers = new Set();
 const relay = { subscribe(owner, listener) { subscribers.add(listener); return () => subscribers.delete(listener); }, revision: () => 'one' };
 const hub = { list: () => [{ id: 'hub-agent', adapter: 'hayate-wss', endpoint: 'https://relay.example/agents/relay-target' }], async request() { return {}; } };
 const services = { get: name => ['agent-link-relay', 'agent-hub'].includes(name) ? { version: 1, implementation: name === 'agent-hub' ? hub : relay } : undefined };
 const channel = new WebUIChannel({ home, port: 0, services }); await channel.start(async () => {}); let socket;
 try {
  socket = new WebSocket(channel.url.replace('http:', 'ws:') + '/api/workspace/live', 'hayate.workspace.v1', { origin: channel.url });
  await once(socket, 'message'); socket.pause();
  const closed = once(socket, 'close');
  const data = { delta: 'x'.repeat(60000) };
  for (let seq = 1; seq <= 64; seq++) for (const send of subscribers) send({ type: 'event', relayAgent: 'relay-target', envelope: { v: 1, epoch: 'e', session: 's', seq, kind: 'text.delta', data } });
  socket.resume();
  const [code] = await closed; assert.equal(code, 1013);
 } finally { socket?.terminate(); await channel.stop(); await rm(home, { recursive: true, force: true }); }
});

test('closed immutable history pages revalidate with a stable ETag; open pages and other reads stay no-store', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'immutable-pages-')); const calls = [];
 const hub = { list: () => [], async request(owner, agent, capability, input) { calls.push(input); return input.before ? { messages: [{ id: 'old', role: 'user', text: 'old' }], before: null, immutable: input.before !== 'fake' ? true : undefined } : { messages: [{ id: 'new', role: 'user', text: 'new' }], before: 'old', busy: false, stream: { epoch: 'e', seq: 1 } }; } };
 const services = { get: name => name === 'agent-hub' ? { version: 1, implementation: hub } : undefined };
 const channel = new WebUIChannel({ home, port: 0, services }); await channel.start(async () => {});
 const read = input => fetch(channel.url + '/api/workspace/agents/peer/read?' + new URLSearchParams({ capability: 'messages', input: JSON.stringify({ action: 'read', streamId: 's', ...input }) }));
 try {
  const open = await read({});
  assert.equal(open.headers.get('cache-control'), 'no-store', 'the open (latest) page changes and is never cached');
  const closed = await read({ before: 'cursor' });
  assert.equal(closed.headers.get('cache-control'), 'private, no-cache', 'kept by the browser but revalidated (authorization) on every use');
  assert.equal(closed.headers.get('vary'), 'Cookie'); assert.ok(closed.headers.get('etag'));
  const before = calls.length;
  const revalidated = await fetch(channel.url + '/api/workspace/agents/peer/read?' + new URLSearchParams({ capability: 'messages', input: JSON.stringify({ action: 'read', streamId: 's', before: 'cursor' }) }), { headers: { 'if-none-match': closed.headers.get('etag') } });
  assert.equal(revalidated.status, 304, 'unchanged closed page: no body');
  assert.equal(calls.length, before + 1, 'revalidation is authorized by the agent');
  assert.equal((await read({ before: 'fake' })).headers.get('cache-control'), 'no-store', 'only pages the agent declares immutable');
 } finally { await channel.stop(); await rm(home, { recursive: true, force: true }); }
});
