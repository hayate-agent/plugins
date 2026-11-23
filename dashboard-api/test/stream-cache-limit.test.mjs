import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamCache } from '../stream-cache.mjs';
test('invalid cache repair limits miss instead of throwing or silently coercing', () => {
 const cache = createStreamCache();
 for (let seq = 1; seq <= 3; seq++) cache.ingest('p', 'a', { session: 's', epoch: 'e', seq, kind: 'text', data: {} });
 for (const limit of [NaN, 0, -1, 1.5, Infinity, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(cache.since('p', 'a', 's', 0, 'e', limit), undefined);
 }
 assert.equal(cache.since('p', 'a', 's', 0, 'e', 1).events.length, 1);
 assert.equal(cache.since('p', 'a', 's', 0, 'e').events.length, 3);
 assert.equal(cache.since('p', 'a', 's', 0, 'e', Number.MAX_SAFE_INTEGER).events.length, 3);
 assert.equal(cache.stats().misses, 8);
});
