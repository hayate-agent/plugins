import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandLedger, issueOpId } from '../command-ledger.mjs';
test('invalid payload serialization refuses admission without executing or reserving identity', async () => {
 const ledger = createCommandLedger(); let calls = 0;
 const cyclic = {}; cyclic.self = cyclic;
 const execute = async () => { calls++; return { done: true }; };
 for (const payload of [cyclic, { value: 1n }, undefined, () => {}, { toJSON() { throw Error('fixture'); } }]) {
  const id = issueOpId();
  const refused = await ledger.run('operator', id, payload, execute);
  assert.deepEqual(refused, { ok: false, status: 400, executed: false, error: 'Serializable command payload required' });
  assert.equal(ledger.size, 0);
  assert.equal((await ledger.status('operator', id)).state, 'unknown');
 }
 assert.equal(calls, 0);
 const id = issueOpId(); const payload = { action: 'fixture' };
 assert.equal((await ledger.run('operator', id, payload, execute)).ok, true);
 assert.equal((await ledger.run('operator', id, payload, execute)).duplicate, true);
 assert.equal(calls, 1); await ledger.close();
});
