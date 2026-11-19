import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from '../../agent-link/vendor/websocket.mjs';
import { WebUIChannel } from '../index.mjs';
import { createCommandLedger } from '../command-ledger.mjs';

const T0 = Date.now(); const opId = (suffix, at = T0) => at.toString(36) + '-op-' + suffix.padEnd(20, 'x');

test('ledger executes an opId once, coalesces concurrent duplicates and rejects reused ids with other content', async () => {
 const ledger = createCommandLedger(); let calls = 0, release;
 const gate = new Promise(resolve => { release = resolve; });
 const first = ledger.run('operator', opId('a'), { text: 'hi' }, async () => { calls++; await gate; return { accepted: true } });
 const second = ledger.run('operator', opId('a'), { text: 'hi' }, async () => { calls++; return { accepted: 'twice' }; });
 assert.equal((await ledger.status('operator', opId('a'))).state, 'running');
 release();
 assert.deepEqual(await first, { ok: true, result: { accepted: true } });
 assert.deepEqual(await second, { ok: true, result: { accepted: true }, duplicate: true });
 assert.equal(calls, 1);
 assert.equal((await ledger.run('operator', opId('a'), { text: 'other' }, async () => { calls++; })).status, 409);
 assert.equal((await ledger.run('other-principal', opId('a'), { text: 'hi' }, async () => { calls++; return {}; })).ok, true, 'ledger is scoped per principal');
 assert.equal(calls, 2);
 const failed = await ledger.run('operator', opId('f'), {}, async () => { calls++; throw Error('upstream secret detail'); });
 assert.equal(failed.ok, false); assert.doesNotMatch(failed.error, /secret detail/);
 assert.equal((await ledger.run('operator', opId('f'), {}, async () => { calls++; return {}; })).ok, false, 'failed or unknown outcome is never re-executed under the same opId');
 assert.equal(calls, 3);
 assert.equal((await ledger.run('operator', 'short', {}, async () => {})).status, 400);
});

test('ledger keeps every outcome for its TTL and refuses new operations at capacity instead of losing dedup', async () => {
 let time = 0, calls = 0; const ledger = createCommandLedger({ maxEntries: 2, ttlMs: 1000, skewMs: 100, now: () => time });
 const opId = suffix => (0).toString(36) + '-op-' + suffix.padEnd(20, 'x');
 let release; const running = ledger.run('p', opId('run'), {}, () => new Promise(resolve => { release = resolve; }));
 await ledger.run('p', opId('b'), {}, async () => { calls++; return {}; });
 const refused = await ledger.run('p', opId('c'), {}, async () => { calls++; return {}; });
 assert.equal(refused.ok, false); assert.equal(refused.executed, false); assert.equal(refused.status, 503);
 assert.equal(calls, 1, 'refused operation never executes');
 assert.equal((await ledger.run('p', opId('b'), {}, async () => { calls++; return {}; })).duplicate, true, 'completed operation stays deduplicated under pressure');
 assert.equal(calls, 1);
 assert.equal((await ledger.status('p', opId('run'))).state, 'running');
 release({}); await running;
 time = 5000;
 await ledger.run('p', (5000).toString(36) + '-op-d'.padEnd(23, 'x'), {}, async () => ({}));
 assert.equal((await ledger.status('p', opId('b'))).state, 'unknown', 'expired after TTL');
 const retried = await ledger.run('p', opId('b'), {}, async () => { calls++; return {}; });
 assert.equal(retried.executed, false, 'a retry after expiry is refused by the issue-time window, never executed twice');
 assert.equal(calls, 1);
 assert.ok(ledger.size <= 2);
});

test('browser WebSocket commands are acknowledged and share the dedup ledger with the POST fallback', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'browser-commands-')); const calls = [];
 const relay = { subscribe() { return () => {}; }, revision: () => 'one' };
 const hub = { list: () => [], async request(owner, agent, capability, input) { calls.push({ owner, agent, capability, input }); return { accepted: true, id: input.id }; } };
 const services = { get: name => ['agent-link-relay', 'agent-hub'].includes(name) ? { version: 1, implementation: name === 'agent-hub' ? hub : relay } : undefined };
 const channel = new WebUIChannel({ home, port: 0, services }); await channel.start(async () => {}); let socket;
 try {
  assert.equal((await (await fetch(channel.url + '/api/workspace/capabilities')).json())['browser-commands-v1'], 1);
  socket = new WebSocket(channel.url.replace('http:', 'ws:') + '/api/workspace/live', 'hayate.workspace.v1', { origin: channel.url });
  await once(socket, 'message');
  const acks = []; socket.on('message', data => { const frame = JSON.parse(data); if (frame.type === 'ack') acks.push(frame); });
  const command = { type: 'command', opId: opId('send'), agentId: 'agent', capability: 'messages', input: { action: 'send', streamId: 's', id: 'm1', text: 'hello' } };
  socket.send(JSON.stringify(command)); socket.send(JSON.stringify(command));
  while (acks.length < 2) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(acks.map(a => [a.opId, a.ok, a.result.accepted]), [[command.opId, true, true], [command.opId, true, true]]);
  assert.equal(calls.length, 1, 'duplicate WS frame does not execute twice');
  assert.equal(calls[0].owner, 'operator');
  // The POST fallback with the same opId returns the recorded outcome.
  const post = await fetch(channel.url + '/api/workspace/agents/agent/request', { method: 'POST', headers: { 'content-type': 'application/json', origin: channel.url, 'x-hayate-webui': '1' }, body: JSON.stringify({ opId: command.opId, capability: command.capability, input: command.input }) });
  assert.equal(post.status, 200); assert.equal(post.headers.get('x-hayate-op-duplicate'), '1'); assert.equal(calls.length, 1, 'POST fallback shares the ledger');
  const conflict = await fetch(channel.url + '/api/workspace/agents/agent/request', { method: 'POST', headers: { 'content-type': 'application/json', origin: channel.url, 'x-hayate-webui': '1' }, body: JSON.stringify({ opId: command.opId, capability: 'messages', input: { ...command.input, text: 'changed' } }) });
  assert.equal(conflict.status, 409); assert.equal(calls.length, 1);
  const status = await (await fetch(channel.url + '/api/workspace/operations/' + command.opId)).json();
  assert.equal(status.state, 'completed');
  assert.equal((await (await fetch(channel.url + '/api/workspace/operations/' + opId('never'))).json()).state, 'unknown');
  const closed = once(socket, 'close'); socket.send('not json'); assert.equal((await closed)[0], 1008);
 } finally { socket?.terminate(); await channel.stop(); await rm(home, { recursive: true, force: true }); }
});

test('ledger byte budget reserves worst-case result size before executing', async () => {
 const ledger = createCommandLedger({ maxBytes: 4000, maxResultBytes: 1000 });
 let calls = 0; const releases = [];
 const first = ledger.run('p', opId('1'), {}, () => new Promise(resolve => { calls++; releases.push(resolve); }));
 const second = ledger.run('p', opId('2'), {}, () => new Promise(resolve => { calls++; releases.push(resolve); }));
 const third = await ledger.run('p', opId('3'), {}, async () => { calls++; return {}; });
 assert.equal(third.executed, false, 'no capacity for a third worst-case result');
 await new Promise(r => setImmediate(r)); assert.equal(calls, 2);
 for (const release of releases) release({ data: 'x'.repeat(900) });
 await Promise.all([first, second]);
});

test('stop() drains accepted WebSocket commands before returning', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'browser-commands-drain-')); let finished = false, started;
 const startedPromise = new Promise(resolve => { started = resolve; });
 const relay = { subscribe() { return () => {}; }, revision: () => 'one' };
 const hub = { list: () => [], async request() { started(); await new Promise(r => setTimeout(r, 200)); finished = true; return {}; } };
 const services = { get: name => ['agent-link-relay', 'agent-hub'].includes(name) ? { version: 1, implementation: name === 'agent-hub' ? hub : relay } : undefined };
 const channel = new WebUIChannel({ home, port: 0, services }); await channel.start(async () => {});
 const socket = new WebSocket(channel.url.replace('http:', 'ws:') + '/api/workspace/live', 'hayate.workspace.v1', { origin: channel.url });
 try {
  await once(socket, 'message');
  socket.send(JSON.stringify({ type: 'command', opId: opId('drain'), agentId: 'agent', capability: 'messages', input: { action: 'send' } }));
  await startedPromise;
  await channel.stop();
  assert.equal(finished, true, 'accepted host work completes before stop() resolves');
 } finally { socket.terminate(); await rm(home, { recursive: true, force: true }); }
});

test('an unserializable result still finishes the ledger entry', async () => {
 const ledger = createCommandLedger(); const cyclic = {}; cyclic.self = cyclic;
 const outcome = await ledger.run('p', opId('cyc'), {}, async () => cyclic);
 assert.equal(outcome.ok, true); assert.equal((await ledger.status('p', opId('cyc'))).state, 'completed');
});

test('journaled ledger survives restart: completed keeps its outcome, running becomes unknown and is never re-executed', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'ledger-journal-')); const file = path.join(home, 'webui', 'command-ledger.json');
 try {
  let calls = 0;
  const first = createCommandLedger({ file });
  assert.deepEqual(await first.run('p', opId('done'), { a: 1 }, async () => { calls++; return { accepted: true }; }), { ok: true, result: { accepted: true } });
  let release; const hanging = first.run('p', opId('crash'), { b: 1 }, () => { calls++; return new Promise(resolve => { release = resolve; }); });
  while (!release) await new Promise(r => setTimeout(r, 5));
  await new Promise(r => setTimeout(r, 20)); // begin record is durable before execution
  // "Restart": a new ledger over the same journal while the first never finished.
  const second = createCommandLedger({ file });
  const done = await second.run('p', opId('done'), { a: 1 }, async () => { calls++; return {}; });
  assert.equal(done.duplicate, true); assert.deepEqual(done.result, { accepted: true });
  const crashed = await second.run('p', opId('crash'), { b: 1 }, async () => { calls++; return {}; });
  assert.equal(crashed.ok, false); assert.equal(crashed.executed, 'unknown'); assert.equal(crashed.status, 409);
  assert.equal((await second.status('p', opId('crash'))).state, 'unknown-outcome');
  assert.equal(calls, 2, 'nothing re-executed after restart');
  // The unknown outcome never expires: even long after the TTL no re-execution.
  const later = createCommandLedger({ file, ttlMs: 1000, now: () => Date.now() + 86_400_000 });
  assert.equal((await later.run('p', opId('crash'), { b: 1 }, async () => { calls++; return {}; })).executed, 'unknown');
  const late = await later.run('p', opId('done'), { a: 1 }, async () => { calls++; return {}; });
  assert.equal(late.executed, false, 'after the record expired, a late retry is refused, never re-executed');
  assert.equal(calls, 2);
  release({});
  await hanging;
 } finally { await rm(home, { recursive: true, force: true }); }
});

test('an unreadable journal fails closed without executing', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'ledger-corrupt-')); const file = path.join(home, 'command-ledger.json');
 try {
  const { writeFile } = await import('node:fs/promises'); await writeFile(file, '{not json');
  let calls = 0; const ledger = createCommandLedger({ file });
  const outcome = await ledger.run('p', opId('x'), {}, async () => { calls++; return {}; });
  assert.equal(outcome.executed, false); assert.equal(outcome.status, 503); assert.equal(calls, 0);
 } finally { await rm(home, { recursive: true, force: true }); }
});

test('POST capacity and conflict responses carry executed', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'post-executed-'));
 const hub = { list: () => [], async request() { return { accepted: true }; } };
 const services = { get: name => name === 'agent-hub' ? { version: 1, implementation: hub } : undefined };
 const channel = new WebUIChannel({ home, port: 0, services }); await channel.start(async () => {});
 const post = body => fetch(channel.url + '/api/workspace/agents/agent/request', { method: 'POST', headers: { 'content-type': 'application/json', origin: channel.url, 'x-hayate-webui': '1' }, body: JSON.stringify(body) });
 try {
  assert.equal((await post({ opId: opId('p1'), capability: 'messages', input: { action: 'send' } })).status, 200);
  const conflict = await post({ opId: opId('p1'), capability: 'messages', input: { action: 'send', text: 'other' } });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).executed, false);
 } finally { await channel.stop(); await rm(home, { recursive: true, force: true }); }
});

test('a syntactically valid journal with a damaged entry fails closed', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'ledger-damaged-')); const file = path.join(home, 'command-ledger.json');
 try {
  const { writeFile } = await import('node:fs/promises');
  const fingerprint = 'a'.repeat(64), key = JSON.stringify(['p', opId('damaged')]);
  const damaged = [
   { key, running: false, unknown: false, finishedAt: Date.now(), outcome: { ok: true } },
   { key: 'not-a-key', fingerprint, running: false, unknown: false, finishedAt: Date.now(), outcome: { ok: true } },
   { key, fingerprint, running: false, unknown: false, finishedAt: 'yesterday', outcome: { ok: true } },
   { key, fingerprint, running: false, unknown: false, finishedAt: Date.now(), outcome: null },
   { key, fingerprint, running: false, finishedAt: Date.now(), outcome: { ok: true } },
   { key, fingerprint, running: false, unknown: false, finishedAt: Date.now(), outcome: { ok: true } },
   { key, fingerprint, running: false, unknown: false, finishedAt: Date.now(), outcome: { ok: false } },
   { key, fingerprint, running: false, unknown: false, finishedAt: Date.now(), outcome: { ok: false, status: 200, error: 'x' } },
   { key, fingerprint, running: false, unknown: true, finishedAt: Date.now(), outcome: { ok: true, result: {} } },
   { key, fingerprint, running: true, unknown: false, finishedAt: Date.now(), outcome: null },
  ];
  for (const record of damaged) {
   await writeFile(file, JSON.stringify({ version: 1, entries: [record] }));
   let calls = 0; const ledger = createCommandLedger({ file });
   const outcome = await ledger.run('p', opId('damaged'), {}, async () => { calls++; return {}; });
   assert.equal(outcome.executed, false, JSON.stringify(record)); assert.equal(calls, 0);
   assert.equal((await ledger.status('p', opId('damaged'))).state, 'unavailable');
  }
  await writeFile(file, JSON.stringify({ version: 1, entries: [{ key, fingerprint, running: false, unknown: false, finishedAt: Date.now(), outcome: { ok: true, result: {} } }, { key, fingerprint, running: true, unknown: false, finishedAt: null, outcome: null }] }));
  assert.equal((await createCommandLedger({ file }).run('p', opId('damaged'), {}, async () => ({}))).executed, false, 'duplicate keys fail closed');
 } finally { await rm(home, { recursive: true, force: true }); }
});

test('array, primitive and null results are journaled and reload after restart', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'ledger-results-')); const file = path.join(home, 'command-ledger.json');
 try {
  const values = [[1, 2], 'text', 7, false, null];
  const first = createCommandLedger({ file });
  for (const [index, value] of values.entries()) await first.run('p', opId('r' + index), {}, async () => value);
  await first.close();
  const second = createCommandLedger({ file }); let calls = 0;
  for (const [index, value] of values.entries()) {
   const outcome = await second.run('p', opId('r' + index), {}, async () => { calls++; return 'again'; });
   assert.equal(outcome.duplicate, true); assert.deepEqual(outcome.result, value ?? {});
  }
  assert.equal(calls, 0);
  assert.equal((await second.run('p', opId('new'), {}, async () => ({ ok: 1 }))).ok, true, 'ledger stays usable');
 } finally { await rm(home, { recursive: true, force: true }); }
});

test('opId issue-time window: future or expired ids are refused without executing', async () => {
 let time = 1_000_000; const ledger = createCommandLedger({ ttlMs: 10_000, skewMs: 1_000, now: () => time }); let calls = 0;
 const id = at => at.toString(36) + '-' + 'w'.repeat(20);
 assert.equal((await ledger.run('p', id(time + 5_000), {}, async () => { calls++; })).executed, false, 'future id refused');
 assert.equal((await ledger.run('p', id(time - 9_500), {}, async () => { calls++; })).executed, false, 'too old to guarantee dedup');
 assert.equal((await ledger.run('p', id(time - 500), {}, async () => { calls++; return {}; })).ok, true);
 assert.equal(calls, 1);
 // Kept at least ttl after arrival: any retry is either deduplicated or refused.
 for (const step of [1_000, 5_000, 9_000, 9_600, 20_000]) {
  time = 1_000_000 + step;
  const outcome = await ledger.run('p', id(1_000_000 - 500), {}, async () => { calls++; return {}; });
  assert.ok(outcome.duplicate === true || outcome.executed === false, 'step ' + step);
 }
 assert.equal(calls, 1);
});

test('after a failed journal write, queued and later operations never execute', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'ledger-failwrite-')); const dir = path.join(home, 'webui'); const file = path.join(dir, 'command-ledger.json');
 try {
  const ledger = createCommandLedger({ file }); await ledger.ready(); let calls = 0;
  // Make the journal directory unwritable after load, then queue two operations.
  const { chmod } = await import('node:fs/promises'); await chmod(dir, 0o500);
  const [a, b] = await Promise.all([ledger.run('p', opId('fa'), {}, async () => { calls++; return {}; }), ledger.run('p', opId('fb'), {}, async () => { calls++; return {}; })]);
  await chmod(dir, 0o700);
  assert.equal(a.executed, false); assert.equal(b.executed, false); assert.equal(calls, 0);
  assert.equal(ledger.state, 'failed');
  assert.equal((await ledger.run('p', opId('fc'), {}, async () => { calls++; return {}; })).executed, false, 'fails closed after recovery of the directory too');
  assert.equal(calls, 0);
 } finally { const { chmod } = await import('node:fs/promises'); await chmod(dir, 0o700).catch(() => {}); await rm(home, { recursive: true, force: true }); }
});

test('a large result is replayed exactly after a restart', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'ledger-large-')); const file = path.join(home, 'command-ledger.json');
 try {
  const large = { text: 'z'.repeat(150_000), items: [1, 2, 3] };
  const first = createCommandLedger({ file });
  assert.deepEqual((await first.run('p', opId('large'), {}, async () => large)).result, large);
  await first.close();
  const second = createCommandLedger({ file }); let calls = 0;
  const replay = await second.run('p', opId('large'), {}, async () => { calls++; return {}; });
  assert.equal(replay.duplicate, true); assert.deepEqual(replay.result, large); assert.equal(calls, 0);
 } finally { await rm(home, { recursive: true, force: true }); }
});

test('invalid commands are refused with executed:false on WebSocket and POST', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'invalid-command-'));
 const hub = { list: () => [], async request() { throw Error('must not execute'); } };
 const relay = { subscribe() { return () => {}; }, revision: () => 'one' };
 const services = { get: name => ['agent-link-relay', 'agent-hub'].includes(name) ? { version: 1, implementation: name === 'agent-hub' ? hub : relay } : undefined };
 const channel = new WebUIChannel({ home, port: 0, services }); await channel.start(async () => {}); let socket;
 try {
  const response = await fetch(channel.url + '/api/workspace/agents/agent/request', { method: 'POST', headers: { 'content-type': 'application/json', origin: channel.url, 'x-hayate-webui': '1' }, body: JSON.stringify({ opId: opId('bad'), capability: 'messages', input: 'not an object' }) });
  assert.equal(response.status, 400); assert.equal((await response.json()).executed, false);
  socket = new WebSocket(channel.url.replace('http:', 'ws:') + '/api/workspace/live', 'hayate.workspace.v1', { origin: channel.url });
  await once(socket, 'message');
  const ack = new Promise(resolve => socket.on('message', data => { const frame = JSON.parse(data); if (frame.type === 'ack') resolve(frame); }));
  socket.send(JSON.stringify({ type: 'command', opId: opId('badws'), agentId: 'agent', capability: 'messages', input: [] }));
  const frame = await ack; assert.equal(frame.ok, false); assert.equal(frame.status, 400); assert.equal(frame.executed, false);
 } finally { socket?.terminate(); await channel.stop(); await rm(home, { recursive: true, force: true }); }
});
