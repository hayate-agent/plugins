import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createTypeSafeProvider, createTypeSafeValidatorPlugin } from '../src/typesafe-validator-provider.ts';
import { assessCompletion } from '../src/completion-validator-plugin.ts';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/typesafe-choice.json', import.meta.url)));
const bank = { id: 'completion_v1', instructions: 'Assess only the supplied synthetic evidence; choose unknown if inconclusive.', choices: {
  done: { description: 'Evidence supports completion', category: 'completed' },
  waiting: { description: 'Waiting for operator', category: 'waiting' },
  blocked: { description: 'Blocked', category: 'blocked' },
  unknown: { description: 'Uncertain or more work needed', category: 'uncertain' },
} };
const request = (signal = new AbortController().signal) => ({ backend: { review() { throw Error('no implicit LLM'); } },
  input: { source: 'channel', sessionKey: 'fixture', text: 'must not be exported' }, reply: 'synthetic',
  authorization: { task: 'synthetic local test' }, signal, now: Date.now, prompt: () => 'synthetic bounded prompt', promptText: 'synthetic bounded prompt' });
async function server(t, handler) {
  const s = createServer(handler);
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => { s.closeAllConnections(); s.close(); });
  return `http://127.0.0.1:${s.address().port}/v1/systemone`;
}
const config = endpoint => ({ endpoint, model: 'fixture-model', questionbank: bank, timeoutMs: 1000 });
const verdict = (p, r = request()) => assessCompletion(r.backend, r.input, r.reply, r.authorization, r.signal,
  undefined, r.now, r.prompt, undefined, 2000, p, r.promptText);

test('local SystemOne contract, fixture, plugin registration and native host interpretation', async t => {
  let sent, path;
  const endpoint = await server(t, async (req, res) => {
    path = req.url; let body = ''; for await (const chunk of req) body += chunk;
    sent = JSON.parse(body); res.end(JSON.stringify(fixture));
  });
  let registered;
  createTypeSafeValidatorPlugin(config(endpoint)).activate({ registerValidatorProvider(p) { registered = p; } });
  assert.equal(registered.apiVersion, 1);
  assert.deepEqual(await verdict(registered), { state: 'completed' });
  assert.equal(path, '/v1/systemone');
  assert.deepEqual(sent, { model: 'fixture-model', state: 'synthetic bounded prompt', questions: {
    completion_v1: { type: 'choice', instructions: bank.instructions, criteria: Object.fromEntries(Object.entries(bank.choices).map(([id,c]) => [id,c.description])) }
  } });
  assert.ok(!JSON.stringify(sent).includes('must not be exported'));
});

// https://docs.typesafe.ai/primitives/choice.md: department confidence 0.42,
// probabilities returns=0.61, billing=0.35, shipping=0.04.
// https://docs.typesafe.ai/confidence.md defines confidence as (pMax - 1/n)/(1 - 1/n),
// not pMax. Preserve the configured confidence floor rather than requiring equality.
test('documented unequal confidence example is accepted above configured floor', async t => {
  const questionbank = { ...bank, choices: { returns: { description: 'Returns', category: 'completed' }, billing: { description: 'Billing', category: 'waiting' }, shipping: { description: 'Shipping (uncertain for host completion)', category: 'uncertain' } } };
  const value = { model: 'fixture-model', answers: { completion_v1: { type: 'choice', choice: 'returns', confidence: 0.42, probabilities: { returns: 0.61, billing: 0.35, shipping: 0.04 } } } };
  const endpoint = await server(t, (_, res) => res.end(JSON.stringify(value)));
  assert.deepEqual(await createTypeSafeProvider({ ...config(endpoint), questionbank, minConfidence: 0.4 }).assess(request()), { state: 'completed' });
  assert.deepEqual(await createTypeSafeProvider({ ...config(endpoint), questionbank, minConfidence: 0.5 }).assess(request()), { state: 'uncertain' });
});

test('reported rounded confidence 0.9435 and selected probability 0.9867 are accepted', async t => {
  const value = structuredClone(fixture);
  Object.assign(value.answers.completion_v1, { confidence: 0.9435, probabilities: { done: 0.9867, waiting: 0.0032, blocked: 0.0001, unknown: 0.01 } });
  const endpoint = await server(t, (_, res) => res.end(JSON.stringify(value)));
  assert.deepEqual(await createTypeSafeProvider(config(endpoint)).assess(request()), { state: 'completed' });
});

// Redacted live shape observed on the OpenJEV service: confidence 0.9435, selected probability 0.9867 (gap about 0.043).
test('observed live shape with unequal confidence is accepted', async t => {
  const value = { model: 'openjev-0.1', answers: { completion_v1: { type: 'choice', choice: 'done', confidence: 0.9434794390177119, probabilities: { done: 0.9866541376043835, wait: 0.0031725064954654567, blocked: 2.420072764064103e-05, unknown: 0.010149155172510424 } } }, usage: { input_tokens: 141, output_tokens: 0 } };
  const bankLive = { ...bank, choices: { done: { description: 'd', category: 'completed' }, wait: { description: 'w', category: 'waiting' }, blocked: { description: 'b', category: 'blocked' }, unknown: { description: 'u', category: 'uncertain' } } };
  const endpoint = await server(t, (_, res) => res.end(JSON.stringify(value)));
  assert.deepEqual(await createTypeSafeProvider({ ...config(endpoint), questionbank: bankLive }).assess(request()), { state: 'completed' });
});

test('configured unknown answer is explicitly uncertain, not unavailable', async t => {
  const value = structuredClone(fixture);
  Object.assign(value.answers.completion_v1, { choice: 'unknown', confidence: 0.95, probabilities: { done: 0.01, waiting: 0.01, blocked: 0.01, unknown: 0.97 } });
  const endpoint = await server(t, (_, res) => res.end(JSON.stringify(value)));
  assert.deepEqual(await createTypeSafeProvider(config(endpoint)).assess(request()), { state: 'uncertain' });
});

for (const [name, mutate] of [
  ['invalid schema', v => { delete v.answers; }],
  ['unknown answer ID', v => { v.answers.other = v.answers.completion_v1; delete v.answers.completion_v1; }],
  ['extra answer ID', v => { v.answers.injected = v.answers.completion_v1; }],
  ['unknown category', v => { v.answers.completion_v1.choice = 'stop-host'; }],
  ['host authority injection', v => { v.answers.completion_v1.stop = true; }],
  ['noul not confidence', v => { v.answers.completion_v1 = { type: 'noul', confidence: 1 }; }],
  ['invalid probability', v => { v.answers.completion_v1.probabilities.done = 2; }],
  ['negative probability', v => { v.answers.completion_v1.probabilities.done = -1; }],
  ['nonfinite probability', v => { v.answers.completion_v1.probabilities.done = Infinity; }],
  ['nonfinite confidence', v => { v.answers.completion_v1.confidence = NaN; }],
  ['out of range confidence', v => { v.answers.completion_v1.confidence = 1.01; }],
  ['selected choice not maximum', v => { v.answers.completion_v1.choice = 'waiting'; v.answers.completion_v1.probabilities = {done:0.6,waiting:0.2,blocked:0.1,unknown:0.1}; }],
  ['probabilities not normalized', v => { v.answers.completion_v1.probabilities = {done:0.5,waiting:0.2,blocked:0.1,unknown:0.1}; }],
  ['low confidence', v => { v.answers.completion_v1.confidence = 0.6; v.answers.completion_v1.probabilities = {done:0.6,waiting:0,blocked:0,unknown:0.4}; }],
  ['uncertain result', v => { v.answers.completion_v1.choice = 'unknown'; v.answers.completion_v1.confidence = 1; v.answers.completion_v1.probabilities = {done:0,waiting:0,blocked:0,unknown:1}; }],
]) test(`${name}: no completed host verdict and no fallback`, async t => {
  const value = structuredClone(fixture); mutate(value);
  const endpoint = await server(t, (_, res) => res.end(JSON.stringify(value)));
  let calls = 0;
  const p = createTypeSafeProvider({ ...config(endpoint), fallback: { apiVersion:1,name:'explicit',version:1, async assess() { calls++; return {state:'completed'}; } } });
  const raw = await p.assess(request());
  if (['low confidence', 'uncertain result'].includes(name)) assert.deepEqual(raw, {state:'uncertain'});
  else assert.equal(raw, undefined);
  assert.equal(await verdict(p), undefined); assert.equal(calls, 0);
});

test('technical HTTP failure has no verdict and no implicit fallback', async t => {
  const endpoint = await server(t, (_, res) => { res.statusCode = 503; res.end('private upstream error'); });
  const diagnostics = [];
  assert.equal(await verdict(createTypeSafeProvider(config(endpoint), d => diagnostics.push(d))), undefined);
  assert.deepEqual(diagnostics, ['technical']);
});
test('malformed JSON and oversized body fail closed', async t => {
  for (const body of ['not json', 'x'.repeat(65537)]) {
    const endpoint = await server(t, (_, res) => res.end(body));
    assert.equal(await verdict(createTypeSafeProvider(config(endpoint))), undefined);
  }
});
test('timeout covers streaming body; no completed result', async t => {
  const endpoint = await server(t, (_, res) => { res.writeHead(200); res.write('{'); });
  const diagnostics = []; const start = Date.now();
  assert.equal(await verdict(createTypeSafeProvider({...config(endpoint), timeoutMs:30}, d => diagnostics.push(d))), undefined);
  assert.ok(Date.now() - start < 1000); assert.deepEqual(diagnostics, ['timeout']);
});
test('cancel aborts in flight promptly with no completed result', async t => {
  const c = new AbortController();
  const endpoint = await server(t, (_, res) => { res.writeHead(200); res.write('{'); c.abort(); });
  const diagnostics = [];
  assert.equal(await verdict(createTypeSafeProvider(config(endpoint), d => diagnostics.push(d)), request(c.signal)), undefined);
  assert.deepEqual(diagnostics, ['cancelled']);
});
test('pre-cancelled and expired requests cannot produce completed', async t => {
  let calls = 0; const endpoint = await server(t, (_, res) => { calls++; res.end(JSON.stringify(fixture)); });
  const p = createTypeSafeProvider(config(endpoint)); const c = new AbortController(); c.abort();
  assert.equal(await p.assess(request(c.signal)), undefined);
  const r = request(); r.authorization.expiresAt = Date.now() - 1;
  assert.equal(await p.assess(r), undefined); assert.equal(calls,0);
});
test('explicit fallback shares total budget even if it ignores abort', async t => {
  const endpoint = await server(t, (_, res) => { res.statusCode=503; res.end(); });
  const fallback = { apiVersion:1,name:'fixture',version:1, assess: () => new Promise(()=>{}) };
  const start = Date.now();
  assert.equal(await verdict(createTypeSafeProvider({...config(endpoint), timeoutMs:40, fallback})), undefined);
  assert.ok(Date.now()-start < 1000);
});
test('explicit fallback is replaceable and called only on transport failure', async t => {
  const endpoint = await server(t, (_,res) => {res.statusCode=503;res.end();}); let called = false;
  const p = createTypeSafeProvider({...config(endpoint), fallback:{apiVersion:1,name:'fixture',version:1,async assess(r){called=true;assert.ok(r.signal);return {state:'blocked'};}}});
  assert.deepEqual(await verdict(p),{state:'blocked'}); assert.equal(called,true);
});
test('authorization lifetime bounds primary request and fallback', async t => {
  const endpoint = await server(t, (_,res) => {res.writeHead(200);res.write('{');});
  const r = request(); r.authorization.expiresAt = Date.now() + 30;
  const start = Date.now();
  assert.equal(await createTypeSafeProvider(config(endpoint)).assess(r), undefined);
  assert.ok(Date.now()-start < 500);
});
test('published Core registry supports explicit selection without replacing native legacy provider', {skip: !process.env.HARNESS_CORE_ROOT}, async t => {
  const { ValidatorRegistry } = await import(pathToFileURL(path.join(process.env.HARNESS_CORE_ROOT, 'src/validator.ts')).href);
  const { legacyLLMProvider } = await import('../src/completion-validator-plugin.ts');
  const endpoint = await server(t, (_,res) => res.end(JSON.stringify(fixture)));
  const registry = new ValidatorRegistry(); registry.register(legacyLLMProvider);
  createTypeSafeValidatorPlugin(config(endpoint)).activate({registerValidatorProvider:p=>registry.register(p)});
  assert.throws(() => registry.current, /completionCheck.provider is required/);
  registry.select('legacy-llm'); assert.equal(registry.current.name,'legacy-llm'); registry.select('typesafe');
  assert.deepEqual(await verdict(registry.current),{state:'completed'});
  registry.select(false); assert.equal(registry.current,undefined);
  registry.select('missing'); assert.throws(() => registry.current, /not registered/);
});
test('completionCheck.provider makes valid TypeSafe config immediately effective without legacy fallback', {skip: !process.env.HARNESS_CORE_ROOT}, async t => {
  const { ValidatorRegistry } = await import(pathToFileURL(path.join(process.env.HARNESS_CORE_ROOT, 'src/validator.ts')).href);
  let legacyCalls = 0, requests = 0, fail = false;
  const endpoint = await server(t, (_, res) => {
    requests++;
    if (fail) { res.statusCode = 503; res.end(); }
    else res.end(JSON.stringify(fixture));
  });
  const registry = new ValidatorRegistry();
  registry.register({ apiVersion: 1, name: 'legacy-llm', version: 1, async assess() {
    legacyCalls++; return { state: 'completed' };
  } });
  createTypeSafeValidatorPlugin(config(endpoint)).activate({ registerValidatorProvider: p => registry.register(p) });
  const operatorConfig = { completionCheck: { provider: 'typesafe' } };
  // Same selection boundary as Core cli.ts; registration alone is not activation.
  registry.select(operatorConfig.completionCheck?.provider ?? 'legacy-llm');
  assert.equal(registry.current.name, 'typesafe');
  assert.deepEqual(await verdict(registry.current), { state: 'completed' });
  assert.equal(requests, 1);
  fail = true;
  assert.equal(await verdict(registry.current), undefined);
  assert.equal(requests, 2);
  assert.equal(legacyCalls, 0);
  registry.select('missing');
  assert.throws(() => registry.current, /not registered/);
  assert.equal(legacyCalls, 0);
});
test('invalid config/category rejected; no implicit endpoint', () => {
  for (const patch of [{endpoint:''},{timeoutMs:Infinity},{minConfidence:2},{questionbank:{...bank,choices:{done:{description:'x',category:'stop'}}}}]) {
    assert.throws(()=>createTypeSafeProvider({...config('http://127.0.0.1:1/v1/systemone'),...patch}));
  }
});
