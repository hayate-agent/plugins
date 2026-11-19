import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMemoryCacheStore, createStreamCache, CACHE_DEFAULTS } from '../stream-cache.mjs';

const envelope = (seq, epoch = 'e1', session = 's', delta = 'x') => ({ v: 1, epoch, session, seq, kind: 'text.delta', data: { delta } });

test('defaults are the agreed bounded disposable cache: 256 MiB global, 24 h idle, 2000 events / 8 MiB per session', () => {
 assert.equal(CACHE_DEFAULTS.maxBytes, 256 * 1024 * 1024); assert.equal(CACHE_DEFAULTS.idleTtlMs, 24 * 3600 * 1000);
 assert.equal(CACHE_DEFAULTS.maxEventsPerSession, 2000); assert.equal(CACHE_DEFAULTS.maxBytesPerSession, 8 * 1024 * 1024);
});

test('memory store evicts LRU over the byte cap and expires idle entries', () => {
 let time = 0; const store = createMemoryCacheStore({ maxBytes: 100, idleTtlMs: 1000, now: () => time });
 store.set('a', 1, 40); store.set('b', 2, 40); store.get('a'); store.set('c', 3, 40);
 assert.equal(store.get('b'), undefined, 'least recently used evicted'); assert.equal(store.get('a'), 1);
 assert.equal(store.set('huge', 0, 1000), false);
 time = 5000; assert.equal(store.get('a'), undefined); assert.equal(store.stats().entries, 0); assert.ok(store.stats().evictions >= 1);
});

test('cache serves changes inside its window, always defers the head to the agent and never invents completeness', () => {
 const cache = createStreamCache();
 for (let seq = 1; seq <= 5; seq++) cache.ingest('op', 'agent', envelope(seq));
 const hit = cache.since('op', 'agent', 's', 2, 'e1');
 assert.deepEqual(hit.events.map(e => e.seq), [3, 4, 5]); assert.equal(hit.more, true, 'client confirms the head with the agent');
 assert.equal(cache.since('op', 'agent', 's', 5, 'e1'), undefined, 'at the cached head only the agent can say nothing is newer');
 assert.equal(cache.since('op', 'agent', 's', 2, 'other-epoch'), undefined);
 assert.equal(cache.since('other', 'agent', 's', 2, 'e1'), undefined, 'scoped per principal');
 assert.equal(cache.ingest('op', 'agent', envelope(3)), false, 'duplicate ignored');
 cache.ingest('op', 'agent', envelope(9)); // gap: window restarts
 assert.equal(cache.since('op', 'agent', 's', 5, 'e1'), undefined, 'a gap in the relay stream is never bridged by the cache');
 assert.ok(cache.stats().hits >= 1 && cache.stats().misses >= 4);
});

test('per-session window is bounded by count and bytes', () => {
 const cache = createStreamCache({ maxEventsPerSession: 3 });
 for (let seq = 1; seq <= 10; seq++) cache.ingest('op', 'agent', envelope(seq));
 assert.equal(cache.since('op', 'agent', 's', 5, 'e1'), undefined, 'cursor older than the window');
 assert.deepEqual(cache.since('op', 'agent', 's', 7, 'e1').events.map(e => e.seq), [8, 9, 10]);
});

test('event sinks are async, bounded and isolated; event sources feed the cache', async () => {
 const received = []; let slowRelease;
 const cache = createStreamCache({ sinkQueue: 2, sinks: [{ onEvent: () => new Promise(resolve => { slowRelease = resolve; }) }, { onEvent() { throw Error('broken sink'); } }, { onEvent: (e, meta) => received.push([e.seq, meta.agentId]) }] });
 const source = new EventEmitter();
 const detach = cache.attach({ subscribe: listener => { source.on('event', listener); return () => source.off('event', listener); } }, 'op');
 for (let seq = 1; seq <= 5; seq++) source.emit('event', { agentId: 'agent', envelope: envelope(seq) });
 assert.equal(cache.since('op', 'agent', 's', 1, 'e1').events.length, 4, 'delivery is not blocked by a slow sink');
 assert.ok(cache.stats().sinkDropped >= 1, 'sink queue is bounded');
 slowRelease(); await new Promise(r => setTimeout(r, 10)); while (slowRelease && received.length < 3) { slowRelease(); await new Promise(r => setTimeout(r, 5)); }
 assert.ok(cache.stats().sinkFailures >= 1);
 assert.deepEqual(received[0], [1, 'agent']);
 detach(); source.emit('event', { agentId: 'agent', envelope: envelope(6) });
 assert.equal(cache.since('op', 'agent', 's', 4, 'e1').events.at(-1).seq, 5);
});

test('restart = empty cache, and every request falls through to the agent', () => {
 const cache = createStreamCache();
 assert.equal(cache.since('op', 'agent', 's', 0, 'e1'), undefined);
});

test('dropAgent revokes every cached session of a removed agent', () => {
 const cache = createStreamCache();
 for (let seq = 1; seq <= 3; seq++) { cache.ingest('op', 'agent', envelope(seq)); cache.ingest('op', 'agent', envelope(seq, 'e1', 'other')); cache.ingest('op', 'keep', envelope(seq)); }
 cache.dropAgent('op', 'agent');
 assert.equal(cache.since('op', 'agent', 's', 1, 'e1'), undefined); assert.equal(cache.since('op', 'agent', 'other', 1, 'e1'), undefined);
 assert.equal(cache.since('op', 'keep', 's', 1, 'e1').events.length, 2);
});

test('cache index is globally bounded and evicting it frees the stored window', () => {
 const cache = createStreamCache({ maxSessions: 2 });
 for (const session of ['a', 'b', 'c']) { cache.ingest('op', 'agent', envelope(1, 'e1', session)); cache.ingest('op', 'agent', envelope(2, 'e1', session)); }
 assert.equal(cache.stats().indexed, 2); assert.equal(cache.stats().entries, 2);
 assert.equal(cache.since('op', 'agent', 'a', 1, 'e1'), undefined);
 assert.equal(cache.since('op', 'agent', 'c', 1, 'e1').events.length, 1);
});

test('a truncated cached answer is marked truncated', () => {
 const cache = createStreamCache();
 for (let seq = 1; seq <= 10; seq++) cache.ingest('op', 'agent', envelope(seq));
 const page = cache.since('op', 'agent', 's', 0, 'e1', 4);
 assert.deepEqual(page.events.map(e => e.seq), [1, 2, 3, 4]); assert.equal(page.truncated, true); assert.equal(page.seq, 4);
 assert.equal(cache.since('op', 'agent', 's', 5, 'e1').truncated, false);
});
