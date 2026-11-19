import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCompletion, legacyLLMProvider } from '../src/completion-validator-plugin.ts';
const input = { sessionKey: 'parent', source: 'channel', text: 'authorized task' };
async function run(assess, timeoutMs = 1000, authorization = { task: 'authorized task' }, now = Date.now) {
  const diagnostics = [];
  const result = await assessCompletion({ review: async () => 'unused' }, input, 'settled report', authorization,
    new AbortController().signal, undefined, now, () => 'bounded prompt', (...args) => diagnostics.push(args),
    timeoutMs, { ...legacyLLMProvider, assess }, 'bounded prompt');
  assert.equal(result, undefined);
  return diagnostics;
}
test('failure detail is fixed-vocabulary, excludes arbitrary exception properties and keeps old sink compatible', async () => {
  const secret = 'https://user:password@private.invalid/?token=private';
  assert.deepEqual(await run(async () => { throw Object.assign(new Error(secret), { code: 'ECONNRESET', status: 503 }); }),
    [['technical', { cause: 'provider_error', code: 'ECONNRESET', status: 503 }]]);
  assert.deepEqual(await run(async () => { throw { code: secret, status: secret, stack: secret }; }),
    [['technical', { cause: 'provider_error' }]]);
  assert.deepEqual(await run(async () => { throw { get code() { throw Error(secret); } }; }),
    [['technical', { cause: 'provider_error' }]]);
  let reads = 0;
  assert.deepEqual(await run(async () => { throw { get code() { return ++reads === 1 ? 'ECONNRESET' : secret; }, status: 503 }; }),
    [['technical', { cause: 'provider_error', code: 'ECONNRESET', status: 503 }]]);
  assert.equal(reads, 1, 'snapshot hostile properties before validation');
});
test('timeout, invalid shape, inconclusive and unavailable remain distinct and never become continue', async () => {
  assert.deepEqual(await run(() => new Promise(() => {}), 5), [['technical', { cause: 'timeout' }]]);
  assert.deepEqual(await run(async () => ({ state: 'continue', next: '' })), [['invalid_response', { cause: 'invalid_shape' }]]);
  assert.deepEqual(await run(async () => ({ state: 'uncertain' })), [['inconclusive']]);
  assert.deepEqual(await run(async () => ({}), 5, { task: '' }), [['unavailable']]);
  assert.deepEqual(await run(() => new Promise(() => {}), 1000, { task: 'authorized task', expiresAt: 1001 }, () => 1000), [['unavailable']]);
});
test('cancellation during provider rejection stays unavailable, not a provider fault', async () => {
  const controller = new AbortController();
  const diagnostics = [];
  const result = await assessCompletion({ review: async () => 'unused' }, input, 'settled report', { task: 'authorized task' },
    controller.signal, undefined, Date.now, () => 'bounded prompt', (...args) => diagnostics.push(args),
    1000, { ...legacyLLMProvider, assess: async () => { controller.abort(); throw Error('private'); } }, 'bounded prompt');
  assert.equal(result, undefined);
  assert.deepEqual(diagnostics, [['unavailable']]);
});
