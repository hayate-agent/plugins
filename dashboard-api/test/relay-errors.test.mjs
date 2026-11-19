import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAgentFailure } from '../relay-errors.mjs';
import { createCommandLedger } from '../command-ledger.mjs';

const T0 = Date.now();
test('each relay failure gets its own operator-facing reason, never the generic retry text', () => {
  const cases = {
    'Outbound agent disconnected; no work sent': [503, /not connected/],
    'Agent disconnected; outcome unknown. No automatic retry': [502, /may or may not have been delivered/],
    'Agent response timed out; outcome unknown. No automatic retry': [504, /did not answer in time/],
    'Target refused the scoped request': [502, /older connector/],
    'Relay request limit reached': [503, /busy/],
  };
  for (const [message, [status, pattern]] of Object.entries(cases)) {
    const failure = describeAgentFailure(Error(message));
    assert.equal(failure.status, status, message); assert.match(failure.error, pattern, message);
    assert.doesNotMatch(failure.error, /retry with the same message ID/);
  }
});

test('unknown errors never leak their message; the ledger records the specific reason', async () => {
  assert.doesNotMatch(describeAgentFailure(Error('ECONNRESET 10.0.0.7 secret')).error, /10\.0\.0\.7|secret/);
  const ledger = createCommandLedger();
  const outcome = await ledger.run('operator', `${T0.toString(36)}-op-${'a'.padEnd(20, 'x')}`, {}, async () => { throw Error('Outbound agent disconnected; no work sent'); });
  assert.equal(outcome.ok, false); assert.equal(outcome.status, 503); assert.match(outcome.error, /not connected/);
});
