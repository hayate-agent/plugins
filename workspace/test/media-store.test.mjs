import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMediaStore } from '../media.mjs';

test('unfinished uploads in one conversation never exhaust another conversation', () => {
 const store = createMediaStore();
 const start = scope => store.chunk(scope, { uploadId: randomUUID(), index: 0, data: 'AAAA', mimeType: 'image/png' });
 for (let i = 0; i < 4; i++) start('alice:agent:one');
 assert.throws(() => start('alice:agent:one'), /capacity/);
 assert.doesNotThrow(() => start('bob:agent:two'));
});

test('pending uploads are bounded globally', () => {
 const store = createMediaStore({ maxPending: 2 });
 store.chunk('a', { uploadId: randomUUID(), index: 0, data: 'AAAA', mimeType: 'image/png' });
 store.chunk('b', { uploadId: randomUUID(), index: 0, data: 'AAAA', mimeType: 'image/png' });
 assert.throws(() => store.chunk('c', { uploadId: randomUUID(), index: 0, data: 'AAAA', mimeType: 'image/png' }), /capacity/);
});
