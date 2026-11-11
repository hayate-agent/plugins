import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryConsolidation } from '../src/memory-consolidation.mjs';

for (const failure of ['summarize', 'put']) {
  test(`${failure} failure cannot starve another conversation; cooldown survives restart`, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'memory-fairness-'));
    let now = 0, failing = true;
    const attempts = [], writes = [];
    const backend = {
      async summarize(request) {
        attempts.push(request);
        if (failing && request.sessionKey === 'broken' && failure === 'summarize') throw Error('offline');
        return `Reported lesson for ${request.sessionKey}`;
      },
      async put(ctx, entry) {
        if (failing && ctx.sessionKey === 'broken' && failure === 'put') throw Error('offline');
        writes.push({ ctx, entry });
      },
    };
    const make = () => new MemoryConsolidation({ home, tier: 'frontier', backend, now: () => now });
    try {
      let worker = make(); await worker.start();
      for (const sessionKey of ['broken', 'healthy']) await worker.capture({ sessionKey, id: sessionKey, text: 'request', reply: 'raw report', outcome: 'failed' });
      now = 7200000;
      await assert.rejects(worker.tick(), /offline/);
      const original = Object.values(worker.state.sessions).find(s => s.sessionKey === 'broken').batch;
      worker = make(); await worker.start();
      assert.equal(await worker.tick(), true);
      assert.equal(writes[0].ctx.sessionKey, 'healthy');
      assert.equal(await worker.tick(), false);
      now += 60000;
      await assert.rejects(worker.tick(), /offline/);
      const pending = Object.values(worker.state.sessions).find(s => s.sessionKey === 'broken');
      assert.deepEqual(pending.batch, original);
      assert.equal(pending.retryAt, now + 120000);
      now += 120000; failing = false;
      assert.equal(await worker.tick(), true);
      assert.equal(writes[1].ctx.sessionKey, 'broken');
      assert.equal(writes[1].entry.key, original.key);
      if (failure === 'put') assert.equal(attempts.filter(a => a.sessionKey === 'broken').length, 1);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}
