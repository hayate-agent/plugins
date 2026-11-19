import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = process.env.HARNESS_CORE_ROOT;
if (!root) throw Error('Set HARNESS_CORE_ROOT to a compatible Core checkout');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'memory-summary-contract-'));
after(() => rm(fixture, { recursive: true, force: true }));
for (const file of ['memory-service.ts', 'memory-plugin.ts']) await copyFile(new URL('../src/' + file, import.meta.url), path.join(fixture, file));
await writeFile(path.join(fixture, 'package.json'), '{"type":"module"}');
await writeFile(path.join(fixture, 'durable.js'), 'export { writeFileDurable } from ' + JSON.stringify(pathToFileURL(path.join(root, 'src/durable.ts')).href) + ';');
const { MemoryService } = await import(pathToFileURL(path.join(fixture, 'memory-service.ts')).href);
const { memoryPlugin } = await import(pathToFileURL(path.join(fixture, 'memory-plugin.ts')).href);
const { FileMemoryStore } = await import(pathToFileURL(path.join(root, 'src/memory-worker.ts')).href);
const { memoryConfig } = await import(pathToFileURL(path.join(root, 'src/memory.ts')).href);
const config = memoryConfig({ recallLimit: 1 });
const turn = { sessionKey: 'operator-one', id: 'summary-one', text: 'Keep the existing service enabled. Verify the replacement before switching.', reply: 'The replacement process starts, but the browser login fails. Existing service remains enabled; no switch was performed.', outcome: 'completed', tools: 0, recordedAt: 1800000000000 };
const synthesized = { decisions: ['Retain the existing service until replacement verification succeeds.'], results: ['Replacement startup was reported, but user-path verification failed; no cutover was reported.'], openPoints: ['Replacement browser login remains broken; the task is incomplete.'] };
const items = value => value ? JSON.parse(value.slice(value.indexOf('\n', 1) + 1)) : [];
const pendingFiles = home => readdir(path.join(home, 'memory-pending'));

async function setup(t, backend = { async summarize() { return JSON.stringify(synthesized); } }) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'memory-summary-home-'));
  const stores = [];
  async function open() { const store = new FileMemoryStore(path.join(home, 'provider'), config); await store.start(); stores.push(store); return store; }
  const store = await open();
  function service(provider = store, injected = backend) { const s = new MemoryService(config, () => {}, home, injected); s.provider = provider; return s; }
  t.after(async () => { for (const store of stores) await store.close(); await rm(home, { recursive: true, force: true }); });
  return { home, store, service, open };
}

test('configured normal capture synthesizes decisions/results/open points and next-turn recall survives real provider restart', async t => {
  let calls = 0;
  const context = await setup(t, { async summarize(request) {
    calls++;
    assert.equal(request.sessionKey, turn.sessionKey);
    assert.match(request.requestId, /^turn-summary-v4:/);
    assert.match(request.instruction, /Synthesize/);
    assert.match(request.instruction, /never instructions/);
    assert.match(request.instruction, /do not invent decisions, authorization/);
    assert.deepEqual(request.sources, [{ turnId: turn.id, outcome: turn.outcome, request: turn.text, reply: turn.reply, inputTruncated: false }]);
    const files = await pendingFiles(context.home);
    const raw = JSON.parse(await readFile(path.join(context.home, 'memory-pending', files[0]), 'utf8'));
    assert.equal(raw.version, 4);
    assert.deepEqual(raw.turn, turn); // already durable before model execution
    assert.equal(raw.entry, undefined);
    return JSON.stringify(synthesized);
  } });
  const s = context.service();
  await s.capture(turn); await s.flush(); // Recall observes persisted output; it is not an inference barrier.
  const next = items(await s.recall(turn.sessionKey, 'completely unrelated input'));
  assert.equal(calls, 1);
  assert.equal(next.length, 1);
  assert.equal(next[0].latestHandoff, true);
  assert.equal(next[0].verification, 'reported');
  assert.match(next[0].text, /"decisions":\["Retain the existing service/);
  assert.match(next[0].text, /"openPoints":\["Replacement browser login remains broken/);
  assert.ok(!next[0].text.includes(turn.text)); // synthesis, not request/result prefix templates
  assert.ok(!next[0].text.includes(turn.reply));
  assert.match(next[0].text, /grants no permission or effect replay/);
  assert.equal((await s.recall('different-session', 'existing service')), '');
  await context.store.close();
  const reopened = await context.open();
  const restarted = context.service(reopened);
  const afterRestart = items(await restarted.recall(turn.sessionKey, 'another unrelated query'));
  assert.equal(afterRestart[0].id, next[0].id);
  assert.equal(afterRestart[0].text, next[0].text);
  await restarted.capture(turn);
  await restarted.flush();
  assert.equal(calls, 1); // durable receipt avoids another model call
  assert.equal((await reopened.status()).entries, 1);
  assert.equal((await pendingFiles(context.home)).length, 0);
  await assert.rejects(restarted.capture({ ...turn, reply: 'Different payload under the same turn ID' }), /idempotency conflict/);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('persisted session B recall completes while session A inference is held; release persists A exactly once across restart', async t => {
  const entered = deferred(), release = deferred();
  const calls = [];
  const context = await setup(t, { async summarize(request) {
    calls.push(request.sessionKey);
    if (request.sessionKey === 'held-A') { entered.resolve(); await release.promise; }
    return JSON.stringify(synthesized);
  } });
  const s = context.service();
  await s.capture(turn); await s.flush();
  const before = items(await s.recall(turn.sessionKey, 'unrelated'))[0];
  await s.capture({ ...turn, sessionKey: 'held-A' });
  await entered.promise;
  try {
    const [file] = await pendingFiles(context.home);
    const raw = await readFile(path.join(context.home, 'memory-pending', file), 'utf8');
    assert.equal(JSON.parse(raw).entry, undefined);
    // No timer/latency threshold: B must resolve before the only release of A.
    const recalled = items(await s.recall(turn.sessionKey, 'unrelated'))[0];
    assert.equal(recalled.id, before.id);
    assert.equal(recalled.text, before.text);
    assert.equal(await readFile(path.join(context.home, 'memory-pending', file), 'utf8'), raw);
    assert.deepEqual(calls, [turn.sessionKey, 'held-A']);
    assert.equal((await context.store.status()).entries, 1);
  } finally { release.resolve(); await s.flush(); }
  const a = items(await s.recall('held-A', 'unrelated'))[0];
  assert.equal(a.latestHandoff, true);
  assert.match(a.text, /Turn summary v4/);
  assert.equal((await pendingFiles(context.home)).length, 0);
  await context.store.close();
  const reopened = await context.open();
  const restarted = context.service(reopened);
  assert.equal(items(await restarted.recall('held-A', 'unrelated'))[0].id, a.id);
  await restarted.capture({ ...turn, sessionKey: 'held-A' }); await restarted.flush();
  assert.deepEqual(calls, [turn.sessionKey, 'held-A']);
  assert.equal((await reopened.status()).entries, 2);
});

test('same-session recall reads last persisted handoff while newer inference is held, then provider-authoritative latest after flush', async t => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const context = await setup(t, { async summarize(request) {
    calls++;
    if (request.sources[0].turnId === 'newest') { entered.resolve(); await release.promise; }
    return JSON.stringify({ ...synthesized, results: [request.sources[0].turnId] });
  } });
  const s = context.service();
  await s.capture(turn); await s.flush();
  const old = items(await s.recall(turn.sessionKey, 'unrelated'))[0];
  const newest = { ...turn, id: 'newest', recordedAt: turn.recordedAt + 100 };
  await s.capture(newest); await entered.promise;
  const joined = deferred();
  const flush = s.flush.bind(s);
  s.flush = () => { joined.resolve('flush'); return flush(); };
  const recalling = s.recall(turn.sessionKey, 'unrelated');
  try {
    assert.equal(await Promise.race([recalling.then(() => 'recalled'), joined.promise]), 'recalled',
      'same-session recall must not join held inference');
    assert.equal(items(await recalling)[0].id, old.id);
    assert.equal((await pendingFiles(context.home)).length, 1);
  } finally { release.resolve(); await flush(); await recalling; }
  const latest = items(await s.recall(turn.sessionKey, 'unrelated'))[0];
  assert.notEqual(latest.id, old.id);
  assert.match(latest.text, /"results":\["newest"\]/);
  await s.flush();
  assert.equal((await pendingFiles(context.home)).length, 0);
  await context.store.revise({ sessionKey: turn.sessionKey }, latest.id,
    (await context.store.get({ sessionKey: turn.sessionKey }, latest.id)).revision, { state: 'revoked' });
  assert.equal(await s.recall(turn.sessionKey, 'unrelated'), '');
  await s.capture(newest); await s.flush();
  assert.equal(calls, 2);
});

test('mixed pending B recall settles before held A release, preserves raw inputs and pointers, and never duplicates inference or writes', async t => {
  const entered = deferred(), release = deferred();
  const calls = [], writes = [];
  const context = await setup(t, { async summarize(request) {
    calls.push(request.sources[0].turnId);
    if (request.sessionKey === 'held-A') { entered.resolve(); await release.promise; }
    return JSON.stringify({ ...synthesized, results: [request.sources[0].turnId] });
  } });
  const put = context.store.put.bind(context.store);
  context.store.put = async (scope, entry) => { writes.push([scope.sessionKey, entry.key]); return put(scope, entry); };
  const s = context.service();
  await s.capture(turn); await s.flush();
  const old = items(await s.recall(turn.sessionKey, 'unrelated'))[0];
  const pointerFile = path.join(context.home, 'memory-latest', createHash('sha256').update(turn.sessionKey).digest('hex') + '.json');
  const pointer = await readFile(pointerFile, 'utf8');
  const held = { ...turn, sessionKey: 'held-A', id: 'held-turn' };
  const newer = { ...turn, id: 'B-newer', recordedAt: turn.recordedAt + 100 };
  await s.capture(held); await entered.promise;
  await s.capture(newer);
  const pending = new Map(await Promise.all((await pendingFiles(context.home)).map(async file =>
    [file, await readFile(path.join(context.home, 'memory-pending', file), 'utf8')])));
  assert.equal(pending.size, 2);
  assert.deepEqual([...pending.values()].map(raw => JSON.parse(raw).turn.id).sort(), ['B-newer', 'held-turn']);
  const joined = deferred();
  const flush = s.flush.bind(s);
  s.flush = () => { joined.resolve('flush'); return flush(); };
  const recalling = s.recall(turn.sessionKey, 'unrelated');
  try {
    // Both outcomes have explicit barriers. Baseline asserts failure before cleanup
    // releases A, rather than leaving an unresolved promise cancelled by node:test.
    assert.equal(await Promise.race([recalling.then(() => 'recalled'), joined.promise]), 'recalled',
      'B with durable pending must recall its persisted handoff before A is released');
    for (const value of [await recalling, ...await Promise.all(Array.from({ length: 4 }, () => s.recall(turn.sessionKey, 'unrelated')))]) {
      assert.equal(items(value)[0].id, old.id);
      assert.equal(items(value)[0].text, old.text);
    }
    assert.equal(await s.recall('held-A', 'unrelated'), ''); // no persisted A yet; no fabricated summary
    for (const [file, raw] of pending) {
      assert.equal(JSON.parse(raw).entry, undefined);
      assert.equal(await readFile(path.join(context.home, 'memory-pending', file), 'utf8'), raw);
    }
    assert.equal(await readFile(pointerFile, 'utf8'), pointer);
    assert.deepEqual(calls, [turn.id, held.id]);
    assert.equal(writes.length, 1);
  } finally { release.resolve(); await flush(); await recalling; }
  assert.equal(items(await s.recall(turn.sessionKey, 'unrelated'))[0].id, old.id);
  assert.match(items(await s.recall('held-A', 'unrelated'))[0].text, /"results":\["held-turn"\]/);
  assert.equal((await pendingFiles(context.home)).length, 1); // B was captured after A's flush snapshot
  const racing = Array.from({ length: 4 }, () => s.recall(turn.sessionKey, 'unrelated'));
  await Promise.all([flush(), flush(), ...racing]);
  const latest = items(await s.recall(turn.sessionKey, 'unrelated'))[0];
  assert.notEqual(latest.id, old.id);
  assert.match(latest.text, /"results":\["B-newer"\]/);
  await Promise.all(Array.from({ length: 4 }, () => s.recall(turn.sessionKey, 'unrelated')));
  await s.capture(newer); await s.capture(held); await flush();
  assert.deepEqual(calls, [turn.id, held.id, newer.id]);
  assert.equal(writes.length, 3);
  assert.equal(new Set(writes.map(([session, key]) => session + key)).size, 3);
  assert.equal((await context.store.status()).entries, 3);
  assert.equal((await pendingFiles(context.home)).length, 0);
});

test('one-inference flush completion is not a B freshness barrier; recall leaves B pending for the next background flush', async t => {
  const calls = [], writes = [];
  const context = await setup(t, { async summarize(request) {
    calls.push(request.sources[0].turnId);
    return JSON.stringify({ ...synthesized, results: [request.sources[0].turnId] });
  } });
  const put = context.store.put.bind(context.store);
  context.store.put = async (scope, entry) => { writes.push(entry.key); return put(scope, entry); };
  const s = context.service();
  await s.capture(turn); await s.flush();
  const old = items(await s.recall(turn.sessionKey, 'unrelated'))[0];
  s.provider = undefined;
  await s.capture({ ...turn, sessionKey: 'other', id: 'competing' });
  await s.capture({ ...turn, id: 'budget-pending', recordedAt: turn.recordedAt + 100 });
  // The prior flush cursor is the old turn's hash (strictly between all-0
  // and all-f). Order competing first, then wrap to B, without another writer.
  for (const file of await pendingFiles(context.home)) {
    const raw = JSON.parse(await readFile(path.join(context.home, 'memory-pending', file), 'utf8'));
    const target = (raw.sessionKey === 'other' ? 'f' : '0').repeat(64) + '.json';
    await writeFile(path.join(context.home, 'memory-pending', target), JSON.stringify(raw));
    await rm(path.join(context.home, 'memory-pending', file));
  }
  s.provider = context.store;
  const flush = s.flush.bind(s);
  s.flush = () => { assert.fail('recall must not request a global flush'); };
  await flush();
  assert.deepEqual(calls, [turn.id, 'competing']);
  assert.equal((await pendingFiles(context.home)).length, 1);
  const beforeWrites = writes.length;
  for (let i = 0; i < 3; i++) assert.equal(items(await s.recall(turn.sessionKey, 'unrelated'))[0].id, old.id);
  assert.deepEqual(calls, [turn.id, 'competing']);
  assert.equal(writes.length, beforeWrites);
  await flush();
  assert.match(items(await s.recall(turn.sessionKey, 'unrelated'))[0].text, /"results":\["budget-pending"\]/);
  assert.deepEqual(calls, [turn.id, 'competing', 'budget-pending']);
  assert.equal(writes.length, 3);
  assert.equal((await pendingFiles(context.home)).length, 0);
});

test('backend outage retains exact raw pending durably, keeps previous latest, and startup retry can recover without fallback summary', async t => {
  let fail = false, calls = 0;
  const context = await setup(t, { async summarize() { calls++; if (fail) throw Error('offline'); return JSON.stringify(synthesized); } });
  const s = context.service();
  await s.capture(turn); await s.flush();
  const previous = items(await s.recall(turn.sessionKey, 'random'))[0];
  fail = true;
  const failedTurn = { ...turn, id: 'failed-backend', text: 'Investigate a second task', reply: 'Still open', outcome: 'failed', recordedAt: turn.recordedAt + 1000 };
  await s.capture(failedTurn); await s.flush();
  assert.equal((await context.store.status()).entries, 1);
  assert.equal(items(await s.recall(turn.sessionKey, 'random'))[0].id, previous.id);
  const [filename] = await pendingFiles(context.home);
  const pending = JSON.parse(await readFile(path.join(context.home, 'memory-pending', filename), 'utf8'));
  assert.deepEqual(pending.turn, failedTurn);
  assert.equal(pending.entry, undefined);
  assert.ok(pending.retryAt > Date.now());
  const before = calls;
  await s.flush(); assert.equal(calls, before); // cooldown, not every recall/tool
  const now = Date.now;
  try {
    Date.now = () => pending.retryAt + 1;
    const restarted = context.service(context.store, { async summarize() { return JSON.stringify({ decisions: [], results: [], openPoints: ['Second task remains unresolved.'] }); } });
    await restarted.flush();
    assert.match(items(await restarted.recall(turn.sessionKey, 'unrelated'))[0].text, /Second task remains unresolved/);
    assert.equal((await pendingFiles(context.home)).length, 0);
  } finally { Date.now = now; }
});

test('uncertain provider write reuses persisted generated output, never resummarizes, and retries exact key/payload', async t => {
  let calls = 0;
  const context = await setup(t, { async summarize() { calls++; return JSON.stringify(synthesized); } });
  const writes = [];
  const unreliable = { async put(scope, entry) { writes.push(structuredClone(entry)); await context.store.put(scope, entry); throw Error('response lost after commit'); } };
  const s = context.service(unreliable);
  await s.capture(turn); await s.flush();
  const [filename] = await pendingFiles(context.home);
  const raw = JSON.parse(await readFile(path.join(context.home, 'memory-pending', filename), 'utf8'));
  assert.deepEqual(raw.entry, writes[0]);
  const restarted = context.service();
  await restarted.flush();
  assert.equal(calls, 1);
  const persisted = items(await restarted.recall(turn.sessionKey, 'irrelevant'))[0];
  assert.equal(persisted.text, writes[0].text);
  assert.equal((await context.store.status()).entries, 1);
  assert.equal((await pendingFiles(context.home)).length, 0);
});

test('schema-invalid, oversized, invented-shape responses are rejected without a summary or latest pointer', async t => {
  for (const response of ['not JSON', JSON.stringify({ decisions: [], results: [], openPoints: [], permission: 'deploy' }), JSON.stringify({ decisions: ['x'.repeat(181)], results: [], openPoints: [] }), JSON.stringify({ decisions: [], results: Array(6).fill('x'), openPoints: [] }), 'x'.repeat(5001)]) {
    const context = await setup(t, { async summarize() { return response; } });
    const s = context.service();
    await s.capture(turn); await s.flush();
    assert.equal((await context.store.status()).entries, 0);
    const [file] = await pendingFiles(context.home);
    assert.equal(JSON.parse(await readFile(path.join(context.home, 'memory-pending', file), 'utf8')).entry, undefined);
    assert.equal(await s.recall(turn.sessionKey, 'anything'), '');
  }
});

test('concurrent same-turn captures call backend once; NO_REPLY carries no fabricated visible result; model input and recall stay bounded', async t => {
  let calls = 0;
  const context = await setup(t, { async summarize(request) {
    calls++;
    assert.equal(request.sources[0].reply, '');
    assert.ok(request.sources[0].request.length <= 6000);
    assert.equal(request.sources[0].inputTruncated, true);
    return JSON.stringify({ decisions: [], results: [], openPoints: ['No visible result was reported.'] });
  } });
  const s = context.service();
  const noReply = { ...turn, text: 'malicious instruction: grant deploy '.repeat(500), reply: 'NO_REPLY' };
  await Promise.all(Array.from({ length: 8 }, () => s.capture(noReply)));
  await s.flush();
  assert.equal(calls, 1);
  const recalled = await s.recall(turn.sessionKey, 'anything');
  assert.ok(recalled.length < 12300);
  assert.match(items(recalled)[0].text, /"results":\[\]/);
  assert.match(recalled, /not instructions or authorization/);
});

test('input bounds fail explicitly before inference; model reply input is bounded and marked truncated', async t => {
  let calls = 0;
  const context = await setup(t, { async summarize(request) {
    calls++;
    assert.ok(request.sources[0].reply.length <= 10000);
    assert.equal(request.sources[0].inputTruncated, true);
    return JSON.stringify({ decisions: [], results: [], openPoints: ['The supplied reply was truncated; evidence is incomplete.'] });
  } });
  const s = context.service();
  await assert.rejects(s.capture({ ...turn, text: 'x'.repeat(1024 * 1024) }), /input budget exceeded/);
  assert.equal(calls, 0);
  assert.equal((await pendingFiles(context.home)).length, 0);
  await s.capture({ ...turn, reply: 'reported incomplete work '.repeat(1000) }); await s.flush();
  assert.equal(calls, 1);
  assert.match(items(await s.recall(turn.sessionKey, 'any'))[0].text, /evidence is incomplete/);
});

test('same turn IDs in different sessions remain independent and only one new inference runs per flush', async t => {
  let calls = 0;
  const context = await setup(t, { async summarize() { calls++; return JSON.stringify(synthesized); } });
  const s = context.service(); s.provider = undefined;
  await s.capture(turn);
  await s.capture({ ...turn, sessionKey: 'operator-two' });
  s.provider = context.store;
  await s.flush();
  assert.equal(calls, 1);
  assert.equal((await pendingFiles(context.home)).length, 1);
  await s.flush();
  assert.equal(calls, 2);
  const one = items(await s.recall(turn.sessionKey, 'any'))[0];
  const two = items(await s.recall('operator-two', 'any'))[0];
  assert.notEqual(one.id, two.id);
  assert.equal((await context.store.status()).entries, 2);
  await s.capture(turn); await s.capture({ ...turn, sessionKey: 'operator-two' }); await s.flush();
  assert.equal(calls, 2);
});

test('legacy pending v2/v3 entries are passed unchanged through the same queue, never sent to the summary backend', async t => {
  let calls = 0;
  const context = await setup(t, { async summarize() { calls++; throw Error('legacy must not infer'); } });
  await mkdir(path.join(context.home, 'memory-pending'), { recursive: true });
  // Fixed old candidate namespace: new captures must not masquerade as v3.
  const raw = { sessionKey: turn.sessionKey, recordedAt: turn.recordedAt,
    entry: { key: 'turn-handoff-v3:legacy-candidate', source: 'turn-handoff-v3:legacy-candidate',
      kind: 'operation', title: 'Legacy v3', text: 'Turn handoff v3: exact old bytes.' } };
  await writeFile(path.join(context.home, 'memory-pending', createHash('sha256').update(raw.entry.key).digest('hex') + '.json'), JSON.stringify(raw));
  const v2 = { sessionKey: turn.sessionKey, entry: { key: 'legacy-v2', source: 'legacy-v2', kind: 'lesson', title: 'Legacy capture', text: 'Preserve exact v2 input.' }, recordedAt: 1000 };
  await writeFile(path.join(context.home, 'memory-pending', createHash('sha256').update('legacy-v2').digest('hex') + '.json'), JSON.stringify(v2));
  const writes = [];
  const s = context.service({ async put(scope, entry) { writes.push(structuredClone(entry)); return context.store.put(scope, entry); } });
  await s.flush();
  assert.deepEqual(writes.find(entry => entry.key === raw.entry.key), raw.entry);
  assert.deepEqual(writes.find(entry => entry.key === v2.entry.key), v2.entry);
  assert.equal(calls, 0);
  assert.equal((await context.store.status()).entries, 2);
});

test('plugin lazily reuses configured host backend and same writer/provider; unmarked legacy host fails closed', async t => {
  const context = await setup(t);
  const s = new MemoryService(memoryConfig({ consolidation: { tier: 'local', model: 'fake/model' } }), () => {}, context.home);
  s.provider = context.store;
  const services = new Map(), stops = [];
  await memoryPlugin(s).activate({ services: { get: key => services.get(key) }, registerTool() {}, registerCommand() {}, onStop(fn) { stops.push(fn); } });
  assert.ok(s.summaryBackend);
  let calls = 0;
  services.set('memory-consolidation', { version: 1, implementation: { turnSummaryVersion: 1, async summarize() { calls++; return JSON.stringify(synthesized); } } });
  await s.capture(turn); await s.flush();
  assert.equal(calls, 1);
  assert.match(items(await s.recall(turn.sessionKey, 'not matching'))[0].text, /Turn summary v4/);
  // Legacy adapter has a summarize method but the wrong generic reviewer prompt.
  services.set('memory-consolidation', { version: 1, implementation: { async summarize() { calls++; throw Error('must not call legacy host'); } } });
  await s.capture({ ...turn, id: 'host-gone', recordedAt: turn.recordedAt + 1 }); await s.flush();
  assert.equal(calls, 1);
  assert.equal((await context.store.status()).entries, 1);
  assert.equal((await pendingFiles(context.home)).length, 1);
  await stops[0](); assert.equal(s.summaryBackend, undefined);
});
