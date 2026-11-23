import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamCache } from '../stream-cache.mjs';
test('bounded cache repair stops inspecting sequences after its result limit', () => {
 const cache = createStreamCache(); let reads = 0;
 for (let n = 1; n <= 100; n++) cache.ingest('p', 'a', { session: 's', epoch: 'e', get seq() { reads++; return n; }, kind: 'text', data: { n } });
 reads = 0;
 const result = cache.since('p', 'a', 's', 0, 'e', 1);
 assert.equal(reads, 3); // one selection read plus seq and truncated metadata
 assert.equal(result.seq, 1); assert.equal(result.events.length, 1);
 assert.equal(result.truncated, true); assert.equal(result.more, true);
 const middle = cache.since('p', 'a', 's', 49, 'e', 2);
 assert.deepEqual(middle.events.map(event => event.seq), [50, 51]);
 const end = cache.since('p', 'a', 's', 99, 'e', 512);
 assert.equal(end.seq, 100); assert.equal(end.truncated, false);
});
