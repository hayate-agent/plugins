import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = process.env.HARNESS_CORE_ROOT;
if (!root) throw Error('Set HARNESS_CORE_ROOT to a compatible Core checkout');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'memory-lifecycle-contract-'));
after(() => rm(fixture, { recursive: true, force: true }));
await copyFile(new URL('../src/memory-service.ts', import.meta.url), path.join(fixture, 'memory-service.ts'));
await writeFile(path.join(fixture, 'package.json'), '{"type":"module"}');
await writeFile(path.join(fixture, 'durable.js'), 'export { writeFileDurable } from ' + JSON.stringify(pathToFileURL(path.join(root, 'src/durable.ts')).href) + ';');
const { MemoryService } = await import(pathToFileURL(path.join(fixture, 'memory-service.ts')).href);
const { MemoryProviderLifecycle } = await import(pathToFileURL(path.join(root, 'src/memory-provider-lifecycle.ts')).href);
const { FileMemoryStore } = await import(pathToFileURL(path.join(root, 'src/memory-worker.ts')).href);
const { memoryConfig } = await import(pathToFileURL(path.join(root, 'src/memory.ts')).href);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));

test('invalid provider response retains exact pending payload even without reconnect', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'memory-invalid-provider-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const service = new MemoryService(memoryConfig(), () => {}, home);
  await service.capture({ id: 'invalid-response', sessionKey: 'one', text: 'input', reply: 'answer', outcome: 'failed' });
  const [file] = await readdir(path.join(home, 'memory-pending'));
  const pending = await readFile(path.join(home, 'memory-pending', file), 'utf8');
  // Reproduce CI159's old contract-invalid stub without any lifecycle race.
  service.provider = { async put() { return {}; } };
  await service.flush();
  assert.deepEqual(await readdir(path.join(home, 'memory-pending')), [file]);
  assert.equal(await readFile(path.join(home, 'memory-pending', file), 'utf8'), pending);
  await assert.rejects(readdir(path.join(home, 'memory-latest')), { code: 'ENOENT' });
});

for (const version of [5, 4]) test(`v${version} pending flush survives facade reconnect and recalls provider-authoritative data after restart`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'memory-lifecycle-home-'));
  const gate = deferred(), entered = deferred();
  let opens = 0, closes = 0, writes = 0, summaries = 0, unhealthy = false;
  const config = memoryConfig({ recallLimit: 1 });
  const lifecycle = new MemoryProviderLifecycle(async () => {
    const generation = ++opens;
    const store = new FileMemoryStore(path.join(home, 'store'), config);
    await store.start();
    const status = store.status.bind(store), put = store.put.bind(store), close = store.close.bind(store);
    store.status = async () => { if (generation === 1 && unhealthy) throw Error('offline'); return status(); };
    store.put = async (...args) => { writes++; entered.resolve(); await gate.promise; return put(...args); };
    store.close = async () => { await close(); closes++; };
    return store;
  });
  t.after(async () => { gate.resolve(); await lifecycle.close(); await rm(home, { recursive: true, force: true }); });
  const backend = version === 4 ? { async summarize() {
    summaries++;
    return JSON.stringify({ decisions: [], results: ['A write was reported.'], openPoints: ['User-path verification remains incomplete.'] });
  } } : undefined;
  const service = new MemoryService(config, () => {}, home, backend);
  const turn = { id: 'lease-turn', sessionKey: 'one', text: 'Preserve the write.', reply: 'Reported write; verification remains open.', outcome: 'failed', recordedAt: 1800000000000 };
  await service.capture(turn); // Queue first: no provider or inference yet.
  const [pendingName] = await readdir(path.join(home, 'memory-pending'));
  const queuedBytes = await readFile(path.join(home, 'memory-pending', pendingName), 'utf8');
  const queued = JSON.parse(queuedBytes);
  service.provider = lifecycle;
  await lifecycle.ensureConnected();
  const flushing = service.flush();
  await entered.promise;
  // Deterministic v5 payload is not rewritten; v4 has persisted exact synthesis before put.
  const beforePutBytes = await readFile(path.join(home, 'memory-pending', pendingName), 'utf8');
  if (version === 5) assert.equal(beforePutBytes, queuedBytes);
  else assert.match(JSON.parse(beforePutBytes).entry.text, /Turn summary v4/);
  unhealthy = true;
  const reconnect = lifecycle.ensureConnected();
  await tick();
  assert.equal(closes, 0); assert.equal(opens, 1);
  // New provider calls are fenced while the in-flight leased write drains.
  await assert.rejects(lifecycle.get({ sessionKey: 'one' }, 'not-yet'), /unavailable/);
  gate.resolve();
  await flushing; await reconnect;
  assert.equal(service.provider, lifecycle);
  assert.equal(writes, 1); assert.equal(opens, 2); assert.equal(closes, 1);
  assert.equal(summaries, version === 4 ? 1 : 0);
  assert.deepEqual(await readdir(path.join(home, 'memory-pending')), []);
  const restarted = new MemoryService(config, () => {}, home, backend);
  restarted.provider = lifecycle;
  const recalled = await restarted.recall('one', 'unmatched-query');
  assert.match(recalled, version === 4 ? /Turn summary v4/ : /Turn handoff v5/);
  assert.equal(await restarted.recall('other-session', 'verification'), '');
  const [pointerName] = await readdir(path.join(home, 'memory-latest'));
  const pointer = JSON.parse(await readFile(path.join(home, 'memory-latest', pointerName), 'utf8'));
  const entry = await lifecycle.get({ sessionKey: 'one' }, pointer.id);
  assert.equal(entry.sessionKey, 'one');
  assert.equal(pointer.recordedAt, turn.recordedAt);
  if (version === 5) {
    assert.equal(entry.text, queued.entry.text);
    assert.equal(entry.source, queued.entry.source);
  } else {
    assert.equal(entry.text, JSON.parse(beforePutBytes).entry.text);
    await restarted.capture(turn); await restarted.flush();
    assert.equal(summaries, 1); assert.equal(writes, 1);
  }
  // Latest pointer cannot bypass provider revocation after reconnect.
  await lifecycle.revise({ sessionKey: 'one' }, entry.id, entry.revision, { state: 'revoked' });
  assert.equal(await restarted.recall('one', 'verification'), '');
});
