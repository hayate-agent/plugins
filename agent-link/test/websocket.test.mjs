import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setup } from './fixture.mjs';
import { AgentRelay } from '../websocket-relay.mjs';
import { OutboundAgentLink } from '../websocket-client.mjs';
import { CAPABILITIES } from '../workspace-protocol.mjs';
import { WebSocket } from '../vendor/websocket.mjs';

async function wait(fn, timeout = 5000) { const until = Date.now() + timeout; while (!fn()) { if (Date.now() > until) throw Error('Condition did not become true'); await new Promise(resolve => setTimeout(resolve, 15)); } }
async function fixture(t, options = {}, clientOptions = {}) {
  const f = await setup(t); await f.server.stop(); // The target has NO listening HTTPS endpoint.
  const tls = { key: await readFile(f.config.keyFile), cert: await readFile(f.config.certFile) };
  let relay = new AgentRelay({ home: f.centralHome, origin: f.origin, host: '127.0.0.1', port: f.config.port, tls, heartbeatMs: 100, ...options }); await relay.open();
  f.central.registerAdapter('hayate-wss', { pair: args => relay.adapter.pair(args), request: args => relay.adapter.request(args), revoke: args => relay.adapter.revoke(args) });
  const client = new OutboundAgentLink({ home: f.targetHome, agent: 'Outbound target', workspace: f.workspace, credentials: f.targetVault,
    config: { projects: { 'central-project': f.project.id }, capabilities: CAPABILITIES, relays: [{ origin: f.origin, caFile: f.config.certFile }] }, reconnectMinMs: 50, reconnectMaxMs: 100, ...clientOptions }); await client.open();
  t.after(async () => { await client.stop(); await relay.stop(); });
  return { ...f, tlsCert: tls.cert, client, get relay() { return relay; }, async restartRelay() { await relay.stop(); relay = new AgentRelay({ home: f.centralHome, origin: f.origin, host: '127.0.0.1', port: f.config.port, tls, heartbeatMs: 100, ...options }); await relay.open(); return relay; } };
}
async function register(f) {
  const invite = await f.relay.invite('operator', { name: 'Remote over WSS' });
  const connection = await f.client.enroll(f.origin, invite.code);
  await wait(() => f.client.status().connected && f.relay.list('operator')[0]?.connected);
  const agent = await f.relay.accept('operator', connection.id, f.central);
  return { invite, connection, agent };
}

test('outbound WSS works with no target listener, requires manual approval and keeps project/identity scope', async t => {
  const f = await fixture(t);
  const invite = await f.relay.invite('operator', { name: 'NAT target' });
  assert.equal(f.central.list('operator').length, 0);
  const connection = await f.client.enroll(f.origin, invite.code);
  await wait(() => f.relay.list('operator')[0]?.connected);
  assert.equal(f.relay.list('operator')[0].approved, false);
  assert.equal(f.central.list('operator').length, 0, 'A socket must not automatically register an agent');
  await assert.rejects(f.relay.accept('other', connection.id, f.central), /refused/);
  const agent = await f.relay.accept('operator', connection.id, f.central);
  const projects = await f.central.request('operator', agent.id, 'projects', { action: 'list' });
  assert.deepEqual(projects.projects.map(p => p.id), [f.project.id]);
  const stream = await f.central.request('operator', agent.id, 'streams', { action: 'create', projectId: f.project.id, title: 'Behind NAT', idempotencyKey: randomUUID() });
  await assert.rejects(f.central.request('operator', agent.id, 'streams', { action: 'create', projectId: f.other.id, title: 'Forbidden', idempotencyKey: randomUUID() }), /refused/);
  await f.central.request('operator', agent.id, 'messages', { action: 'send', streamId: stream.id, id: randomUUID(), text: 'Use outbound channel' });
  const result = await f.central.request('operator', agent.id, 'messages', { action: 'read', streamId: stream.id });
  assert.equal(result.messages.at(-1).text, 'Remote answer'); assert.equal(f.received.length, 1);
  // A cursor beyond the retained window resolves to a bounded page reload.
  const changes = await f.central.request('operator', agent.id, 'messages', { action: 'changes', streamId: stream.id, since: 999 });
  assert.equal(changes.reset, true); assert.deepEqual(changes.events, []); assert.equal(f.received.length, 1, 'changes never resubmits work');
  assert.equal(f.bindings.get(`plugin:workspaces:${stream.id}`).cwd, f.targetHome);
  assert.equal(f.relay.list('other').length, 0);
  assert.doesNotMatch(await readFile(path.join(f.centralHome, 'agent-link-relay/state.json'), 'utf8'), new RegExp(invite.code));
  assert.doesNotMatch(JSON.stringify(f.relay.list('operator')), /clientDigest|hubDigest|approvalDigest|token|credential/);
  assert.doesNotMatch(JSON.stringify(f.client.status()), /credential|token/);
});

test('TLS verification, one-use invitation and operator scope are enforced', async t => {
  const f = await fixture(t); const invite = await f.relay.invite('operator', { name: 'Scoped', capabilities: ['activity'] });
  const invalid = new OutboundAgentLink({ home: path.join(f.home, 'untrusted'), agent: 'Untrusted', workspace: f.workspace, credentials: f.targetVault, config: { projects: {}, capabilities: ['activity'], allowOperatorRelays: true } }); await invalid.open();
  await assert.rejects(invalid.enroll(f.origin, invite.code), /failed/); await invalid.stop();
  const { connection, agent } = await (async () => { const connection = await f.client.enroll(f.origin, invite.code); await wait(() => f.client.status().connected); const agent = await f.relay.accept('operator', connection.id, f.central); return { connection, agent }; })();
  assert.deepEqual(connection.capabilities, ['activity']);
  await assert.rejects(f.central.request('operator', agent.id, 'messages', { action: 'send' }), /unavailable/);
  assert.deepEqual((await f.central.request('operator', agent.id, 'activity', { action: 'list' })).streams, []);
  const second = new OutboundAgentLink({ home: path.join(f.home, 'replay'), agent: 'Replay', workspace: f.workspace, credentials: f.targetVault, config: { projects: {}, capabilities: ['activity'], relays: [{ origin: f.origin, caFile: f.config.certFile }] } }); await second.open();
  await assert.rejects(second.enroll(f.origin, invite.code), /refused/); await second.stop();
});

test('connection loss rejects uncertain work; reconnect never replays a productive request', async t => {
  const f = await fixture(t); const { agent } = await register(f);
  const stream = await f.central.request('operator', agent.id, 'streams', { action: 'create', projectId: f.project.id, title: 'Pending acknowledgement', idempotencyKey: randomUUID() });
  let entered, release; const active = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  await f.workspace.channel.start(async message => { f.received.push(message); entered(); await gate; });
  const request = f.central.request('operator', agent.id, 'messages', { action: 'send', streamId: stream.id, id: randomUUID(), text: 'Exactly one productive request' });
  const rejected = assert.rejects(request, /unknown/); await active;
  await f.relay.stop(); await rejected; release();
  await f.restartRelay(); await wait(() => f.relay.list('operator')[0]?.connected);
  const response = await f.central.request('operator', agent.id, 'streams', { action: 'list' });
  assert.equal(response.streams.length, 1); assert.equal(f.received.length, 1);
  await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(f.received.length, 1);
});

test('removal revokes outbound authorization, closes the live socket and survives restart', async t => {
  const f = await fixture(t); const { agent } = await register(f);
  await f.central.remove('operator', agent.id);
  await wait(() => !f.client.status().connected && f.client.status().revoked);
  assert.equal(f.relay.list('operator')[0].revoked, true);
  await f.restartRelay(); await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.relay.list('operator')[0].connected, false);
  await f.client.disconnect(); assert.equal(f.client.status().configured, false);
});

test('authenticated frames are bounded and malformed protocols are refused without productive work', async t => {
  const f = await fixture(t); await register(f); const record = f.client.store.read().connection;
  await f.client.stop();
  const socket = await f.targetVault.withSecret('operator', record.credential, token => new Promise((resolve, reject) => {
    const socket = new WebSocket(f.origin.replace('https:', 'wss:') + '/api/agent-link/v1/connect', 'hayate.agent-link.v1', { ca: undefined, headers: { Authorization: 'Bearer ' + token, 'X-Hayate-Agent-ID': record.id }, rejectUnauthorized: true });
    socket.once('open', () => resolve(socket)); socket.once('error', reject);
  })).catch(() => null);
  assert.equal(socket, null, 'A raw client without the explicit fixture CA is refused');
  const open = () => f.targetVault.withSecret('operator', record.credential, token => new Promise((resolve, reject) => {
    const socket = new WebSocket(f.origin.replace('https:', 'wss:') + '/api/agent-link/v1/connect', 'hayate.agent-link.v1', { ca: f.tlsCert, headers: { Authorization: 'Bearer ' + token, 'X-Hayate-Agent-ID': record.id } });
    socket.once('open', () => resolve(socket)); socket.once('error', reject);
  }));
  const malformed = await open();
  const closed = new Promise(resolve => malformed.once('close', resolve)); malformed.send(JSON.stringify({ type: 'request', id: randomUUID() }));
  assert.equal(await closed, 1008); assert.equal(f.received.length, 0);
  const oversized = await open(); oversized.on('error', () => {});
  const limited = new Promise(resolve => oversized.once('close', resolve)); oversized.send('x'.repeat(300000));
  assert.equal(await limited, 1009); assert.equal(f.received.length, 0);
});

test('stop drains entered target work rather than releasing ownership on socket close', async t => {
  const f = await fixture(t); const { agent } = await register(f);
  const stream = await f.central.request('operator', agent.id, 'streams', { action: 'create', projectId: f.project.id, title: 'Drain', idempotencyKey: randomUUID() });
  let entered, release; const active = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await f.workspace.channel.start(async () => { entered(); await gate; });
  const request = f.central.request('operator', agent.id, 'messages', { action: 'send', streamId: stream.id, id: randomUUID(), text: 'Keep ownership' }); const rejected = assert.rejects(request, /unknown/);
  await active; let stopped = false; const stop = f.client.stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(stopped, false);
  release(); await stop; await rejected; assert.equal(stopped, true);
});


test('missing server heartbeats destroy a silent channel without revoking or replaying work', async t => {
  const f = await fixture(t, { heartbeatMs: 10000 }, { heartbeatTimeoutMs: 200 });
  await register(f);
  let reconnects = 0; const original = f.targetVault.withSecret.bind(f.targetVault);
  f.targetVault.withSecret = (...args) => { reconnects++; return original(...args); };
  await wait(() => reconnects > 0);
  assert.notEqual(f.client.status().revoked, true);
  assert.equal(f.workspace.snapshot('operator').streams.length, 0);
});

test('regular server pings keep idle channels live without productive ownership', async t => {
  const f = await fixture(t, { heartbeatMs: 50 }, { heartbeatTimeoutMs: 300 });
  await register(f);
  await new Promise(resolve => setTimeout(resolve, 750));
  assert.equal(f.client.status().connected, true);
  assert.equal(f.relay.list('operator')[0].connected, true);
  assert.equal(f.client.status().activeRequests, 0);
});

test('Hayate agents stream seq events over outbound WSS like the PI connector, and repair via changes', async t => {
  const f = await fixture(t); const { agent } = await register(f);
  const events = []; const stop = f.relay.subscribe('operator', event => { if (event.type === 'event') events.push(event.envelope); });
  t.after(stop);
  const stream = await f.central.request('operator', agent.id, 'streams', { action: 'create', projectId: f.project.id, title: 'Streaming', idempotencyKey: randomUUID() });
  const before = await f.central.request('operator', agent.id, 'messages', { action: 'read', streamId: stream.id });
  assert.ok(before.stream?.epoch && before.stream.seq === 0, 'a read page carries the stream head');
  await f.central.request('operator', agent.id, 'messages', { action: 'send', streamId: stream.id, id: randomUUID(), text: 'Stream me' });
  await wait(() => events.some(e => e.kind === 'entry.appended' && e.data.message.role === 'assistant'));
  assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1), 'contiguous per-session seq');
  assert.ok(events.every(e => e.session === stream.id && e.epoch === before.stream.epoch && e.v === 1));
  assert.equal(events[0].data.message.role, 'user');
  // `changes` returns exactly the missing events; an unknown epoch resets.
  const repair = await f.central.request('operator', agent.id, 'messages', { action: 'changes', streamId: stream.id, since: 1, epoch: before.stream.epoch });
  assert.deepEqual(repair.events.map(e => e.seq), events.slice(1).map(e => e.seq));
  const stale = await f.central.request('operator', agent.id, 'messages', { action: 'changes', streamId: stream.id, since: 1, epoch: 'other' });
  assert.equal(stale.reset, true);
  // Streams outside the shared project never leak into the event feed.
  const hidden = await f.workspace.createStream('operator', { projectId: f.other.id, title: 'Hidden' });
  const count = events.length; f.workspace.events.append(hidden.id, 'turn.status', { busy: true });
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(events.length, count);
});

test('read pages are bounded and paginate with an immutable before cursor', async t => {
  const f = await fixture(t); const { agent } = await register(f);
  const stream = await f.central.request('operator', agent.id, 'streams', { action: 'create', projectId: f.project.id, title: 'Long', idempotencyKey: randomUUID() });
  await f.workspace.store.change(data => { const s = data.streams.find(x => x.id === stream.id); for (let i = 0; i < 100; i++) s.messages.push({ id: randomUUID(), role: i % 2 ? 'assistant' : 'user', text: 'm' + i, at: i + 1 }); });
  const newest = await f.central.request('operator', agent.id, 'messages', { action: 'read', streamId: stream.id });
  assert.equal(newest.messages.length, 40); assert.equal(newest.messages.at(-1).text, 'm99'); assert.equal(newest.historyTruncated, true);
  const older = await f.central.request('operator', agent.id, 'messages', { action: 'read', streamId: stream.id, before: newest.before });
  assert.equal(older.messages.at(-1).text, 'm59'); assert.equal(older.immutable, true);
  const oldest = await f.central.request('operator', agent.id, 'messages', { action: 'read', streamId: stream.id, before: older.before });
  assert.equal(oldest.messages.length, 20); assert.equal(oldest.historyTruncated, false); assert.equal(oldest.before, null);
});

test('long messages are delivered complete (page and live event), repair answers are byte-bounded, legacy changes reset', async t => {
  const f = await fixture(t); const { agent } = await register(f);
  const events = []; t.after(f.relay.subscribe('operator', event => { if (event.type === 'event') events.push(event.envelope); }));
  const stream = await f.central.request('operator', agent.id, 'streams', { action: 'create', projectId: f.project.id, title: 'Long text', idempotencyKey: randomUUID() });
  const long = 'x'.repeat(30000) + 'END';
  await f.central.request('operator', agent.id, 'messages', { action: 'send', streamId: stream.id, id: randomUUID(), text: long });
  await wait(() => events.some(e => e.kind === 'entry.appended' && e.data.message.role === 'user'));
  assert.equal(events.find(e => e.data.message?.role === 'user').data.message.text, long, 'live event carries the full text');
  const page = await f.central.request('operator', agent.id, 'messages', { action: 'read', streamId: stream.id });
  assert.equal(page.messages.find(m => m.role === 'user').text, long, 'page carries the full text');
  for (let i = 0; i < 20; i++) f.workspace.events.append(stream.id, 'text.delta', { delta: 'y'.repeat(30000) });
  const repair = await f.central.request('operator', agent.id, 'messages', { action: 'changes', streamId: stream.id, since: 0, epoch: page.stream.epoch });
  assert.ok(JSON.stringify(repair).length < 200000 && repair.more === true, 'bounded repair answer continues with more');
  assert.equal(repair.seq, repair.events.at(-1).seq, 'a truncated answer continues from its last returned event');
  // Following the cursor page by page yields every event exactly once, in order.
  const seen = []; let cursor = 0, pages = 0, result;
  do { result = await f.central.request('operator', agent.id, 'messages', { action: 'changes', streamId: stream.id, since: cursor, epoch: page.stream.epoch }); seen.push(...result.events.map(e => e.seq)); cursor = result.events.at(-1)?.seq ?? cursor; pages++; } while (result.more && pages < 20);
  assert.ok(pages > 1, 'needed more than one page');
  assert.deepEqual(seen, Array.from({ length: seen.length }, (_, i) => i + 1), 'no event skipped or repeated across pages');
  assert.equal(seen.at(-1), f.workspace.events.head(stream.id).seq);
});

test('event streaming needs the messages capability on both the grant and the target configuration', async t => {
  for (const mode of ['grant', 'config']) {
    const f = await fixture(t, {}, mode === 'config' ? {} : {});
    let subscriptions = 0; const original = f.workspace.events.subscribe;
    f.workspace.events.subscribe = listener => { subscriptions++; const stop = original(listener); return () => { subscriptions--; stop(); }; };
    const restricted = mode === 'grant' ? ['projects', 'streams', 'activity'] : CAPABILITIES;
    if (mode === 'config') { await f.client.stop(); }
    const client = mode === 'config' ? new OutboundAgentLink({ home: path.join(f.home, 'restricted'), agent: 'Restricted', workspace: f.workspace, credentials: f.targetVault, config: { projects: { 'central-project': f.project.id }, capabilities: ['projects', 'streams', 'activity'], relays: [{ origin: f.origin, caFile: f.config.certFile }] }, reconnectMinMs: 50, reconnectMaxMs: 100 }) : f.client;
    if (mode === 'config') { await client.open(); t.after(() => client.stop()); }
    const invite = await f.relay.invite('operator', { name: 'Restricted ' + mode, capabilities: restricted.filter(c => CAPABILITIES.includes(c)) });
    const connection = await client.enroll(f.origin, invite.code);
    await wait(() => client.status().connected && f.relay.list('operator')[0]?.connected);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(subscriptions, 0, `${mode}: a connection without messages never subscribes to workspace events`);
    assert.ok(connection.capabilities.length > 0);
  }
});
