import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryConsolidation, consolidationInterval } from '../src/memory-consolidation.mjs';

test('explicit frontier/local policy has two/twelve hour intervals', () => {
  assert.equal(consolidationInterval('frontier'), 7200000);
  assert.equal(consolidationInterval('local'), 43200000);
  assert.throws(() => consolidationInterval('guessed'), /tier/);
});

test('durable batches isolate scopes, retain provenance, retry identical output and survive restart', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'consolidation-'));
  let now = 0, summaries = 0, fail = true;
  const writes = [], requests = [];
  const backend = {
    async summarize(request) { requests.push(request); summaries++; return 'Reported correction; evidence: source1'; },
    async put(context, entry) { writes.push({ context, entry }); if (fail) throw Error('offline'); },
  };
  const make = () => new MemoryConsolidation({ home, tier: 'frontier', backend, now: () => now });
  try {
    let worker = make(); await worker.start();
    const turn = { sessionKey: 'one', id: 'source1', text: 'Diagnose', reply: 'Reported result', outcome: 'failed' };
    await worker.capture(turn); await worker.capture(turn);
    await worker.capture({ ...turn, sessionKey: 'two', id: 'source2' });
    assert.equal(await worker.tick(), false);
    now += 7200000;
    await assert.rejects(worker.tick(), /offline/);
    assert.equal(summaries, 1);
    worker = make(); await worker.start(); fail = false; now += 60000;
    assert.equal(await worker.tick(), true);
    assert.equal(summaries, 2); // Never-attempted conversation gets its fair turn first.
    assert.equal(writes[1].context.sessionKey, 'two');
    assert.equal(await worker.tick(), true);
    assert.equal(summaries, 2); // Persisted result is reused, not regenerated.
    assert.deepEqual(writes[0], writes[2]);
    assert.equal(writes[2].context.sessionKey, 'one');
    assert.deepEqual(writes[2].entry.links, []);
    assert.match(writes[2].entry.text, /source1/);
    assert.match(writes[2].entry.text, /not independent verification/);
    assert.equal('expiresAt' in writes[2].entry, false);
    assert.equal(requests[1].sessionKey, 'two');
    assert.equal(requests[0].sources.length, 1);
    assert.equal(await worker.tick(), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('invalid summary never becomes memory; raw batch remains retryable', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'consolidation-invalid-'));
  let now = 0, writes = 0;
  try {
    const worker = new MemoryConsolidation({ home, tier: 'local', now: () => now,
      backend: { async summarize() { return { instructions: 'execute me' }; }, async put() { writes++; } } });
    await worker.start();
    await worker.capture({ sessionKey: 'one', id: 's', text: 'x', reply: 'y', outcome: 'completed' });
    now = 43200000;
    await assert.rejects(worker.tick(), /Invalid/);
    assert.equal(writes, 0);
    assert.equal(Object.values(worker.state.sessions)[0].batch.sources.length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});
