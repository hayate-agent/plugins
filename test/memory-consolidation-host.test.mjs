import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { MemoryConsolidation } from '../src/memory-consolidation.mjs';

const root = process.env.HARNESS_CORE_ROOT;
test('capture -> due batch -> isolated host -> durable provider -> recall', { skip: !root && 'Set HARNESS_CORE_ROOT to Core with consolidation host adapter' }, async () => {
  const load = file => import(pathToFileURL(path.join(root, 'src', file)).href);
  const { FileMemoryStore } = await load('memory-worker.ts');
  const { memoryConfig } = await load('memory.ts');
  const { memoryConsolidationHost } = await load('memory-consolidation-host.ts');
  const home = await mkdtemp(path.join(os.tmpdir(), 'consolidation-e2e-'));
  const provider = new FileMemoryStore(path.join(home, 'memory'), memoryConfig());
  let now = 0, service, stop, prompts = 0;
  const opened = [];
  try {
    await provider.start();
    const memory = {
      provider,
      async capture(turn) { await provider.put({ sessionKey: turn.sessionKey }, { key: turn.id, title: 'Raw report', text: turn.reply, kind: 'operation', source: turn.id }); },
      async recall(sessionKey, query) { return provider.search({ sessionKey }, query); },
    };
    const runtime = { async open(key, options) {
      opened.push({ key, options });
      return {
        async prompt(text, options) {
          prompts++;
          assert.match(text, /untrusted|Untrusted/);
          assert.match(text, /Reported artifact mismatch/);
          assert.deepEqual(options, { model: 'test/cheap', thinking: 'off' });
          return 'Reported lesson: reconcile running artifact before declaring success.';
        },
        async abort() {}, async dispose() {},
      };
    } };
    await memoryConsolidationHost({ tier: 'frontier', model: 'test/cheap' }, runtime, memory, () => {}).activate({
      registerService(name, version, value) { assert.equal(name, 'memory-consolidation'); service = value; },
      onStop(fn) { stop = fn; },
    });
    const worker = new MemoryConsolidation({ home, tier: service.tier, backend: service, now: () => now });
    await worker.start();
    const turn = { sessionKey: 'private-one', id: 'source-one', text: 'Validate deployment', reply: 'Reported artifact mismatch', outcome: 'failed' };
    await service.capture(turn);
    await worker.capture(turn);
    assert.equal(await worker.tick(), false);
    now = 7200000;
    assert.equal(await worker.tick(), true);
    assert.equal(prompts, 1);
    assert.deepEqual(opened[0].options, { ephemeral: true });
    assert.ok(!opened[0].key.includes(turn.sessionKey));
    const hits = await service.recall(turn.sessionKey, 'reconcile');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].entry.verification, 'reported');
    assert.deepEqual(hits[0].entry.links, []);
    assert.match(hits[0].entry.text, /source-one/);
    assert.match(hits[0].entry.text, /not independent verification/);
    assert.equal((await service.recall('different-session', 'reconcile')).length, 0);
    assert.equal((await service.recall(turn.sessionKey, 'mismatch')).length, 1);
    await provider.reindex();
    assert.equal((await service.recall(turn.sessionKey, 'reconcile')).length, 1);
    await stop();
  } finally {
    if (stop) await stop();
    await provider.close();
    await rm(home, { recursive: true, force: true });
  }
});
