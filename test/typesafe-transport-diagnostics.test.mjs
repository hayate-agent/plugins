import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTypeSafeAPI } from '../src/typesafe-api-plugin.ts';
import { typeSafeDecisionPlugin, COMPLETION_BANK } from '../src/typesafe-decision-plugin.ts';
import { assessCompletion } from '../src/completion-validator-plugin.ts';
import { createTypeSafeProvider } from '../src/typesafe-validator-provider.ts';

async function fixture(t, timeoutMs = 100) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ts-diagnostic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'key'); await writeFile(file, 'synthetic-private-credential', { mode: 0o600 });
  const config = { endpoint: 'http://127.0.0.1:1/v1/systemone', model: 'fixture', bearerTokenFile: file, timeoutMs };
  const api = createTypeSafeAPI(config), providers = [];
  typeSafeDecisionPlugin.activate({ registerValidatorProvider: p => providers.push(p), registerDispatchDecisionProvider() {}, services: { get: () => ({ version: 1, implementation: api }) } });
  return { config, api, provider: providers[0] };
}
async function assess(env, signal = new AbortController().signal) {
  let fallback = 0; const diagnostic = [];
  const result = await assessCompletion({ review: async () => { fallback++; throw Error('No fallback'); } }, { source: 'host', sessionKey: 'fixture', text: 'scope' }, 'actual receipt',
    { task: 'Original scope', expiresAt: Date.now() + 10000 }, signal, undefined, Date.now, () => 'bounded evidence', (category, detail) => diagnostic.push({ category, detail }), 1000, env.provider, 'bounded evidence');
  assert.equal(result, undefined); assert.equal(fallback, 0); return diagnostic;
}

for (const mode of ['http503', 'http504', 'timeout', 'malformed', 'uncertain']) test(`public factory provider propagates ${mode} without fallback or private text`, async t => {
  const bank = { id: 'fixture_v1', instructions: 'Classify isolated fixture', choices: { done: { description: 'complete', category: 'completed' }, unknown: { description: 'uncertain', category: 'uncertain' } } };
  const provider = createTypeSafeProvider({ endpoint: 'http://127.0.0.1:1/v1/systemone', model: 'fixture', timeoutMs: 25, questionbank: bank });
  t.mock.method(globalThis, 'fetch', mode === 'timeout' ? () => new Promise(() => {}) : async () => mode.startsWith('http') ? new Response('PRIVATE provider body', { status: Number(mode.slice(4)) }) : mode === 'malformed' ? Response.json({ wrong: true }) : Response.json({ model: 'fixture', answers: { fixture_v1: { type: 'choice', choice: 'done', confidence: .4, probabilities: { done: 1, unknown: 0 } } } }));
  const expected = mode.startsWith('http') ? { category: 'technical', detail: { cause: 'provider_error', status: Number(mode.slice(4)) } } : mode === 'timeout' ? { category: 'technical', detail: { cause: 'timeout', code: 'ETIMEDOUT' } } : mode === 'uncertain' ? { category: 'inconclusive', detail: undefined } : { category: 'invalid_response', detail: { cause: 'invalid_shape' } };
  assert.deepEqual(await assess({ provider }), [expected]);
});

test('technical timeout is publicly timeout, not malformed model output', async t => {
  const env = await fixture(t, 30); t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  assert.deepEqual(await assess(env), [{ category: 'technical', detail: { cause: 'timeout', code: 'ETIMEDOUT' } }]);
});
for (const status of [401, 403, 429, 503, 504]) test(`HTTP ${status} remains technical with bounded status and zero fallback`, async t => {
  const env = await fixture(t); t.mock.method(globalThis, 'fetch', async () => new Response('PRIVATE echoed request and credentials', { status }));
  const diagnostic = await assess(env);
  assert.deepEqual(diagnostic, [{ category: 'technical', detail: { cause: 'provider_error', status } }]);
  assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE'));
});
test('malformed JSON is still invalid_response; network exceptions are technical and private text is hidden', async t => {
  const env = await fixture(t); const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ wrong: true }));
  assert.deepEqual(await assess(env), [{ category: 'invalid_response', detail: { cause: 'invalid_shape' } }]);
  fetch.mock.mockImplementation(async () => { throw Error('PRIVATE endpoint credential'); });
  assert.deepEqual(await assess(env), [{ category: 'technical', detail: { cause: 'provider_error' } }]);
});
test('caller cancellation is not reported as a provider timeout and grants no work', async t => {
  const env = await fixture(t); t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  const signal = new AbortController(), details = []; const pending = env.api.choose(COMPLETION_BANK, 'synthetic', signal.signal, d => details.push(d));
  signal.abort(); assert.equal(await pending, undefined); assert.deepEqual(details, []);
});
test('supports bounded real assessment budgets while explicit short deadlines stay exact', async t => {
  const env = await fixture(t);
  for (const ms of [10001, 30000, 60000, 120000]) assert.doesNotThrow(() => createTypeSafeAPI({ ...env.config, timeoutMs: ms }));
  for (const ms of [0, 120001, Infinity, 1.5]) assert.throws(() => createTypeSafeAPI({ ...env.config, timeoutMs: ms }));
  const response = () => Response.json({ model: 'fixture', answers: { [COMPLETION_BANK.id]: { type: 'choice', choice: 'done', confidence: .99, probabilities: { done: 1, more: 0, waiting: 0, blocked: 0, unknown: 0 } } } });
  t.mock.method(globalThis, 'fetch', async () => { await new Promise(r => setTimeout(r, 35)); return response(); });
  assert.equal(await createTypeSafeAPI({ ...env.config, timeoutMs: 5 }).choose(COMPLETION_BANK, 'synthetic', new AbortController().signal), undefined);
  const { timeoutMs, ...defaults } = env.config;
  assert.equal(await createTypeSafeAPI(defaults).choose(COMPLETION_BANK, 'synthetic', new AbortController().signal), 'done');
});
