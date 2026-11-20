import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentRead } from '../workspace-http.mjs';
test('image-read is a read-only browser operation, uploads and sends are not', () => {
 const input = { action: 'image-read', streamId: 's', messageId: 'm', index: 0, offset: 0 };
 assert.deepEqual(validateAgentRead('messages', input), { capability: 'messages', input });
 for (const action of ['media-chunk', 'send', 'fork']) assert.throws(() => validateAgentRead('messages', { action }), { status: 405 });
 assert.throws(() => validateAgentRead('projects', input), { status: 405 });
});
