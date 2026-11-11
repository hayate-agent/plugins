import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryConsolidation } from '../src/memory-consolidation.mjs';

test('cancelled model work retains persisted raw batch and retries after restart', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'memory-interruption-'));
  let now = 0, writes = 0;
  const backend = { async summarize() { throw Error('Memory consolidation cancelled or timed out'); }, async put() { writes++; } };
  try {
    const first = new MemoryConsolidation({ home, tier: 'frontier', backend, now: () => now });
    await first.start();
    await first.capture({ sessionKey: 'one', id: 'source', text: 'Original request', reply: 'Original reported result', outcome: 'failed' });
    now = 7200000;
    await assert.rejects(first.tick(), /cancelled/);
    assert.equal(writes, 0);
    const state = JSON.parse(await readFile(path.join(home, 'memory-consolidation/state.json'), 'utf8'));
    const pending = Object.values(state.sessions)[0].batch;
    assert.equal(pending.sources[0].reply, 'Original reported result');
    assert.equal(pending.result, undefined);
    const next = new MemoryConsolidation({ home, tier: 'frontier', now: () => now, backend: {
      async summarize(request) { assert.equal(request.requestId, pending.key); assert.deepEqual(request.sources, pending.sources); return 'Reported lesson'; },
      async put() { writes++; },
    } });
    await next.start();
    assert.equal(await next.tick(), false);
    now += 60000;
    assert.equal(await next.tick(), true);
    assert.equal(writes, 1);
    assert.equal(await next.tick(), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
