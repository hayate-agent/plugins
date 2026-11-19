import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCompletion, legacyLLMProvider, validatorPlugin } from '../src/completion-validator-plugin.ts';
const input = { sessionKey: 'test', source: 'channel', text: 'Authorized task' };
const auth = { task: 'Authorized task', expiresAt: 2000 };
const signal = () => new AbortController().signal;
const prompt = () => 'existing budgeted prompt';
const assess = (provider, diagnostic) => assessCompletion({ review: async () => '{"state":"completed"}' }, input,
  'report', auth, signal(), undefined, () => 1000, prompt, diagnostic, 1000, provider, prompt());

test('completion validator is a real plugin registering a versioned replaceable LLM provider', async () => {
  let registered;
  validatorPlugin.activate({ registerValidatorProvider(value) { registered = value; } });
  assert.equal(registered, legacyLLMProvider);
  assert.equal(registered.apiVersion, 1); assert.equal(registered.version, 1);
  assert.deepEqual(await assess(registered), { state: 'completed' });
});
test('concrete provider orchestration preserves legacy continuation data', async () => {
  const value = { state: 'continue', next: 'test', progress: { advanced: true, fingerprint: 'tests:1' }, contextPreparation: 'compact' };
  const result = await assess({ ...legacyLLMProvider, async assess() { return value; } });
  assert.deepEqual(result, { ...value, expiresAt: 2000 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
test('unavailable, malformed and inconclusive providers cannot imply success or leak errors', async () => {
  for (const answer of [undefined, null, [], {}, { state: 'uncertain' }, { state: 'continue' }, { state: 'continue', next: 'x', contextPreparation: 'skip' }]) {
    assert.equal(await assess({ ...legacyLLMProvider, async assess() { return answer; } }), undefined);
  }
  const diagnostics = [];
  assert.equal(await assess({ ...legacyLLMProvider, async assess() { throw Error('secret'); } }, x => diagnostics.push(x)), undefined);
  assert.deepEqual(diagnostics, ['technical']);
});
test('legacy provider uses exactly the provided host model, signal and bounded prompt', async () => {
  const s = signal(); let call;
  const answer = await legacyLLMProvider.assess({ backend: { async review(...args) { call = args; return '{"state":"blocked"}'; } },
    input, reply: 'report', authorization: auth, signal: s, model: 'operator/model', now: () => 1000, prompt, promptText: prompt() });
  assert.deepEqual(answer, { state: 'blocked' });
  assert.deepEqual(call, [prompt(), 'operator/model', 'low', s]);
});
