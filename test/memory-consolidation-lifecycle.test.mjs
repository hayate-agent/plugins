import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import plugin from '../src/memory-consolidation.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function setup(t, overrides = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-lifecycle-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let tick, stop, orchestrator, fenced = false, foreground = 0;
  t.mock.method(globalThis, 'setInterval', fn => { tick = fn; return { unref() {} }; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const backend = { tier: 'frontier', summarize: async () => 'lesson', put: async () => {}, capture: async () => {}, recall: async () => [], ...overrides };
  await plugin.activate({ home, services: new Map([['memory-consolidation', { version: 1, implementation: backend }]]),
    registerMemoryOrchestrator(name, value) { assert.equal(name, 'consolidating'); orchestrator = value; },
    onStop(fn) { stop = fn; },
    async foregroundWork(fn) { if (fenced) throw Error('update admission'); foreground++; try { return await fn(); } finally { foreground--; } },
  });
  return { backend, orchestrator, tick: () => tick(), stop: () => stop(), fence: () => { fenced = true; }, foreground: () => foreground };
}

test('consolidation declares ownership and fences recall, capture and timer work before dispatch', async t => {
  assert.equal(plugin.updateAdmission, 'foreground-owned');
  let called = 0;
  const f = await setup(t, { recall: async () => { called++; }, capture: async () => { called++; }, summarize: async () => { called++; } });
  f.fence();
  await assert.rejects(f.orchestrator.recall('s', 'text'), /update admission/);
  await assert.rejects(f.orchestrator.capture({ sessionKey: 's', text: 'input', reply: 'reply' }), /update admission/);
  f.tick();
  await f.stop();
  assert.equal(called, 0);
  assert.equal(f.foreground(), 0);
});

test('stop drains the entire accepted capture, then rejects new calls', async t => {
  const gate = deferred(), entered = deferred();
  const f = await setup(t, { capture: async () => { entered.resolve(); await gate.promise; } });
  const capture = f.orchestrator.capture({ sessionKey: 's', text: 'input', reply: 'reply' });
  await entered.promise;
  assert.equal(f.foreground(), 1);
  let stopped = false;
  const stopping = f.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  await assert.rejects(f.orchestrator.capture({}), /stopped/);
  await assert.rejects(f.orchestrator.recall('s', 'text'), /stopped/);
  gate.resolve();
  await capture; await stopping;
  assert.equal(f.foreground(), 0);
});

test('stop drains accepted provider recall even when the provider fails', async t => {
  const gate = deferred(), entered = deferred();
  const f = await setup(t, { recall: async () => { entered.resolve(); await gate.promise; throw Error('provider failure'); } });
  const recalled = assert.rejects(f.orchestrator.recall('s', 'text'), /provider failure/);
  await entered.promise;
  let stopped = false;
  const stopping = f.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  gate.resolve(); await recalled; await stopping;
  assert.equal(f.foreground(), 0);
});
