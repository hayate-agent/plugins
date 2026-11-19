import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.HARNESS_CORE_ROOT;
if (!root) throw Error('Set HARNESS_CORE_ROOT to a compatible Core checkout');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'memory-pr102-source-'));
after(() => rm(fixture, { recursive: true, force: true }));
await copyFile(new URL('../src/memory-service.ts', import.meta.url), path.join(fixture, 'memory-service.ts'));
await writeFile(path.join(fixture, 'package.json'), '{"type":"module"}');
await writeFile(path.join(fixture, 'durable.js'), 'export { writeFileDurable } from ' + JSON.stringify(pathToFileURL(path.join(root, 'src/durable.ts')).href) + ';');
const { MemoryService } = await import(pathToFileURL(path.join(fixture, 'memory-service.ts')).href);
const { FileMemoryStore } = await import(pathToFileURL(path.join(root, 'src/memory-worker.ts')).href);
const { memoryConfig } = await import(pathToFileURL(path.join(root, 'src/memory.ts')).href);
const hash = text => createHash('sha256').update(text).digest('hex');
const config = { enabled: true, autoCapture: true, autoRecall: true, recallLimit: 1 };
const turn = { sessionKey: 'one', id: 'stable', text: 'Keep old service until verification.', reply: 'Browser login failed; do not switch.', outcome: 'completed', recordedAt: 1800000000000 };
const summary = JSON.stringify({ decisions: ['Keep old service.'], results: ['Login failure reported.'], openPoints: ['Verify before switching.'] });
const list = dir => readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
const items = text => text ? JSON.parse(text.slice(text.indexOf('\n', 1) + 1)) : [];
async function home(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-pr102-home-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function legacyFile(dir, name, value) { await mkdir(path.join(dir, name), { recursive: true }); const file = path.join(dir, name, hash(value.key ?? value.entry.key) + '.json'); const bytes = JSON.stringify(value, null, 2); await writeFile(file, bytes); return { file, bytes }; }
function provider(writes) { return { async put(ctx, entry) { writes.push(entry); return { ...entry, id: entry.key, sessionKey: ctx.sessionKey, createdAt: '2027-01-01T00:00:00.000Z' }; } }; }

for (const semantic of [false, true]) test(`knowledge-free filters have no inference, pending or provider writes (${semantic ? 'summary' : 'fallback'})`, async t => {
  const dir = await home(t), writes = []; let calls = 0;
  const service = new MemoryService(config, () => {}, dir, semantic ? { async summarize() { calls++; return summary; } } : undefined);
  service.provider = provider(writes);
  const excluded = [
    { text: '', reply: '' }, { text: ' ', reply: ' NO_REPLY ' },
    { text: 'Hallo!', reply: 'Hello.' }, { text: 'danke', reply: 'Gerne!' },
    { reply: 'Request timed out.', outcome: 'failed' }, { reply: '⚠️ Model request failed!', outcome: 'failed' },
  ];
  for (const tools of [undefined, 0, []]) for (const sample of excluded) await service.capture({ ...turn, ...sample, tools });
  await service.flush();
  assert.equal(calls, 0); assert.deepEqual(writes, []);
  assert.deepEqual(await list(path.join(dir, 'memory-pending')), []);
  assert.deepEqual(await list(path.join(dir, 'memory-summary-receipts')), []);
  assert.deepEqual(await list(path.join(dir, 'memory-latest')), []);
  // Similar words inside real results/errors and tool-backed exchanges survive.
  const retained = [
    { text: 'Hello, keep service active', reply: 'Hello; explicit stop remains' },
    { reply: 'Error: migration partially applied; do not rerun', outcome: 'failed' },
    { reply: 'Request timed out. Effect unknown; reconcile before retry.', outcome: 'failed' },
    { reply: 'NO_REPLY' }, { reply: '', outcome: 'failed' },
    { text: 'hi', reply: 'hello', tools: ['read'] },
    { reply: 'Request timed out', outcome: 'failed', tools: 1 },
  ];
  for (const [index, sample] of retained.entries()) { await service.capture({ ...turn, ...sample, id: 'retained-' + index }); await service.flush(); }
  assert.equal(writes.length, retained.length); assert.equal(calls, semantic ? retained.length : 0);
});

test('fallback v6 complete identity is stable without id/time in home and provider-only paths', async t => {
  for (const durable of [false, true]) {
    const dir = durable ? await home(t) : undefined, writes = [];
    const first = new MemoryService(config, () => {}, dir); first.provider = provider(writes);
    const missing = { ...turn, id: undefined, recordedAt: undefined };
    await first.capture(missing); await first.flush();
    const restarted = new MemoryService(config, () => {}, dir); restarted.provider = first.provider;
    await restarted.capture(missing); await restarted.flush();
    assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
    assert.match(writes[0].key, /^turn-handoff-v6:/); assert.equal(writes[0].reviewAfter, '1970-01-01T00:00:00.000Z');
    assert.match(writes[0].text, /task IDs, permissions, deadlines, budgets and explicit stops/);
    assert.match(writes[0].text, /never replay an effect or resume a stopped task/);
    const keys = new Set();
    for (const sample of [turn, { ...turn, text: 'Changed request' }, { ...turn, outcome: 'failed' }, { ...turn, reply: 'Changed reply' }, { ...turn, recordedAt: turn.recordedAt + 1 }, { ...turn, recordedAt: undefined }]) {
      await restarted.capture(sample); await restarted.flush(); keys.add(writes.at(-1).key);
    }
    assert.equal(keys.size, 6);
  }
});

test('v4 timestamp presence/value conflicts before and after restart, pending/output remain immutable', async t => {
  for (const timestamp of [undefined, turn.recordedAt]) {
    const dir = await home(t); const backend = { async summarize(request) {
      assert.match(request.instruction, /task IDs, permissions, deadlines, budgets and stops/);
      return summary;
    } };
    const original = { ...turn, recordedAt: timestamp }, changed = { ...turn, recordedAt: timestamp === undefined ? turn.recordedAt : undefined };
    const service = new MemoryService(config, () => {}, dir, backend);
    await service.capture(original);
    const [file] = await list(path.join(dir, 'memory-pending')), pendingPath = path.join(dir, 'memory-pending', file);
    const bytes = await readFile(pendingPath, 'utf8'); assert.equal(JSON.parse(bytes).inputHashVersion, 2);
    await assert.rejects(service.capture(changed), /idempotency conflict/);
    await assert.rejects(service.capture({ ...original, recordedAt: (timestamp ?? 0) + 1 }), /idempotency conflict/);
    assert.equal(await readFile(pendingPath, 'utf8'), bytes);
    let writes = []; service.provider = provider(writes); await service.flush();
    assert.equal(writes.length, 1); assert.equal(writes[0].reviewAfter, new Date(timestamp === undefined ? 0 : timestamp + 7 * 86400000).toISOString());
    const restarted = new MemoryService(config, () => {}, dir, backend); restarted.provider = service.provider;
    await restarted.capture(original); await restarted.flush(); assert.equal(writes.length, 1);
    await assert.rejects(restarted.capture(changed), /idempotency conflict/);
    assert.match(writes[0].text, /never replay an effect or resume a stopped task/);
  }
});

test('legacy v4 raw pending and persisted output keep old hash/bytes; legacy receipt replay fails closed', async t => {
  for (const output of [false, true]) {
    const dir = await home(t), key = 'turn-summary-v4:' + hash(turn.sessionKey + '\0' + turn.id);
    const inputHash = hash(JSON.stringify([turn.text, turn.reply, turn.outcome]));
    const oldEntry = { key, source: key, kind: 'operation', title: 'Old summary', text: 'Exact immutable legacy output', reviewAfter: '2027-01-01T00:00:00.000Z' };
    const pending = { version: 4, sessionKey: turn.sessionKey, key, inputHash, turn, ...(output ? { entry: oldEntry } : {}) };
    const { file, bytes } = await legacyFile(dir, 'memory-pending', pending);
    let calls = 0; const backend = { async summarize() { calls++; return summary; } };
    const service = new MemoryService(config, () => {}, dir, backend);
    await service.capture(turn); assert.equal(await readFile(file, 'utf8'), bytes);
    await assert.rejects(service.capture({ ...turn, recordedAt: turn.recordedAt + 1 }), /idempotency conflict/);
    const writes = []; service.provider = provider(writes); await service.flush();
    assert.equal(calls, output ? 0 : 1); if (output) assert.deepEqual(writes[0], oldEntry);
    const receiptPath = path.join(dir, 'memory-summary-receipts', hash(key) + '.json');
    const receiptBytes = await readFile(receiptPath, 'utf8'); const receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.inputHash, inputHash); assert.equal('inputHashVersion' in receipt, false);
    const restarted = new MemoryService(config, () => {}, dir, backend); restarted.provider = service.provider;
    await assert.rejects(restarted.capture(turn), /unverifiable legacy receipt/);
    await assert.rejects(restarted.capture({ ...turn, recordedAt: turn.recordedAt + 1 }), /idempotency conflict/);
    assert.equal(await readFile(receiptPath, 'utf8'), receiptBytes); assert.equal(writes.length, 1);
    assert.deepEqual(await list(path.join(dir, 'memory-pending')), []);
    // Crash recovery with old receipt plus old pending must not infer or put again.
    const recovered = await legacyFile(dir, 'memory-pending', pending);
    await restarted.flush();
    assert.deepEqual(await list(path.join(dir, 'memory-pending')), []);
    assert.equal(writes.length, 1); assert.equal(calls, output ? 0 : 1);
    assert.equal(await readFile(receiptPath, 'utf8'), receiptBytes);
    await assert.rejects(readFile(recovered.file), /ENOENT/);
  }
});

test('new unknown-time summaries require review and exact receipts prevent any repeat write or inference', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-epoch-'));
  const store = new FileMemoryStore(path.join(dir, 'provider'), memoryConfig({ enabled: true }));
  await store.start(); t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const writes = []; let calls = 0;
  const backend = { async summarize() { calls++; return summary; } };
  const missing = { ...turn, recordedAt: undefined };
  const service = new MemoryService(config, () => {}, dir, backend);
  service.provider = { ...provider(writes), async put(ctx, entry) { writes.push(entry); return store.put(ctx, entry); }, get: store.get.bind(store), search: store.search.bind(store) };
  await service.capture(missing); await service.flush();
  assert.equal(writes.length, 1); assert.equal(calls, 1);
  assert.equal(writes[0].reviewAfter, '1970-01-01T00:00:00.000Z');
  assert.equal(items(await service.recall(turn.sessionKey, 'unmatched'))[0].reviewDue, true);
  const receiptPath = path.join(dir, 'memory-summary-receipts', hash(writes[0].key) + '.json');
  const bytes = await readFile(receiptPath, 'utf8'), entryBytes = JSON.stringify(writes[0]);
  const restarted = new MemoryService(config, () => {}, dir, backend); restarted.provider = service.provider;
  await restarted.capture(missing); await restarted.flush();
  assert.equal(writes.length, 1); assert.equal(calls, 1);
  assert.equal(JSON.stringify(writes[0]), entryBytes); assert.equal(await readFile(receiptPath, 'utf8'), bytes);
});

test('pre-epoch v4 hash-v2 unknown-time pending, output and receipts are not retrofitted', async t => {
  for (const output of [false, true]) {
    const dir = await home(t), missing = { ...turn, recordedAt: undefined };
    const key = 'turn-summary-v4:' + hash(turn.sessionKey + '\0' + turn.id);
    const inputHash = hash(JSON.stringify([turn.text, turn.reply, turn.outcome, false, null]));
    const entry = { key, source: key, kind: 'operation', title: 'Old', text: 'Immutable pre-epoch summary' };
    const pending = { version: 4, inputHashVersion: 2, inputHash, sessionKey: turn.sessionKey, key, turn: missing, ...(output ? { entry } : {}) };
    const { file, bytes } = await legacyFile(dir, 'memory-pending', pending);
    let calls = 0; const writes = [], backend = { async summarize() { calls++; return summary; } };
    const service = new MemoryService(config, () => {}, dir, backend);
    await service.capture(missing); assert.equal(await readFile(file, 'utf8'), bytes);
    service.provider = provider(writes); await service.flush();
    assert.equal(writes.length, 1); assert.equal(calls, output ? 0 : 1);
    assert.equal('reviewAfter' in writes[0], false); if (output) assert.deepEqual(writes[0], entry);
    const receipt = path.join(dir, 'memory-summary-receipts', hash(key) + '.json'), receiptBytes = await readFile(receipt, 'utf8');
    const restarted = new MemoryService(config, () => {}, dir, backend); restarted.provider = service.provider;
    await restarted.capture(missing); await restarted.flush();
    await legacyFile(dir, 'memory-pending', pending); await restarted.flush();
    assert.equal(writes.length, 1); assert.equal(calls, output ? 0 : 1); assert.equal(await readFile(receipt, 'utf8'), receiptBytes);
  }
});

test('pre-epoch fallback v5 pending retains key and exact payload instead of a new v6 write', async t => {
  const dir = await home(t), missing = { ...turn, recordedAt: undefined }, writes = [];
  const key = 'turn-handoff-v5:' + hash(JSON.stringify({ sessionKey: missing.sessionKey, id: missing.id, text: missing.text, reply: missing.reply, outcome: missing.outcome, recordedAt: missing.recordedAt }));
  const entry = { key, source: key, kind: 'operation', title: 'Old', text: 'Immutable old fallback' };
  const { file, bytes } = await legacyFile(dir, 'memory-pending', { sessionKey: missing.sessionKey, entry });
  const service = new MemoryService(config, () => {}, dir);
  await service.capture(missing); assert.equal(await readFile(file, 'utf8'), bytes);
  assert.equal((await list(path.join(dir, 'memory-pending'))).length, 1);
  service.provider = provider(writes); await service.flush();
  assert.deepEqual(writes, [entry]);
});

test('actual PR102 turn-handover-v3 passes unchanged after failed put/restart and becomes scoped latest', async t => {
  // Payload/key construction from 378caecc; optional expiry additionally proves preservation.
  const dir = await home(t), key = 'turn-handover-v3:' + hash(JSON.stringify(turn));
  const entry = { key, source: key, kind: 'operation', title: `${turn.outcome}: ${turn.text}`,
    text: `Outcome reported by Hayate Agent: ${turn.outcome}. Working handover. This is not verification of operational claims or new authorization.\nOperator request (reported context): ${turn.text}\nReported result/decision: ${turn.reply}\nContinuation boundary: Preserve original task IDs, permissions, deadlines and budgets. Reconcile exact tool/effect evidence before any uncertain action; never replay an effect or resume a stopped task from this memory. A reported completed turn does not prove the overall task is complete.`,
    reviewAfter: new Date(turn.recordedAt + 7 * 86400000).toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' };
  const { file, bytes } = await legacyFile(dir, 'memory-pending', { sessionKey: turn.sessionKey, entry });
  const backend = { async summarize() { assert.fail('Legacy must not infer'); } };
  const first = new MemoryService(config, () => {}, dir, backend); first.provider = { async put() { throw Error('offline'); } };
  await first.flush(); assert.equal(await readFile(file, 'utf8'), bytes);
  const store = new FileMemoryStore(path.join(dir, 'memory'), memoryConfig({})); await store.start(); t.after(() => store.close());
  const put = store.put.bind(store); let writes = 0;
  store.put = async (ctx, value) => { writes++; assert.deepEqual(value, entry); return put(ctx, value); };
  const restarted = new MemoryService(config, () => {}, dir, backend); restarted.provider = store;
  await restarted.flush(); assert.equal(writes, 1); assert.deepEqual(await list(path.join(dir, 'memory-pending')), []);
  const [latest] = items(await restarted.recall(turn.sessionKey, 'no-search-match'));
  assert.equal(latest.latestHandoff, true); assert.equal(latest.text, entry.text);
  const saved = await store.get({ sessionKey: turn.sessionKey }, latest.id);
  assert.equal(saved.expiresAt, entry.expiresAt); assert.equal(saved.reviewAfter, entry.reviewAfter);
  assert.equal(await restarted.recall('other-session', 'no-search-match'), '');
});
