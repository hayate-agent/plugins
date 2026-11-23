import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDecoder, verifyDecodedImage } from '../media-decode.mjs';

test('decoded image values are independent of caller mutations across awaits', async () => {
 let release, entered, decoded;
 let gate = Promise.resolve();
 let ready = () => {};
 await loadDecoder(async () => ({ default: bytes => {
  decoded = bytes.toString('base64');
  return { metadata: async () => { ready(); await gate; return { width: 1, height: 1 }; }, raw: () => ({ toBuffer: async () => Buffer.from([0]) }) };
 } }));
 const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
 const original = { type: 'image', mimeType: 'image/png', data };
 const unchanged = await verifyDecodedImage(original);
 assert.deepEqual(unchanged, original);
 assert.notEqual(unchanged, original);
 gate = new Promise(resolve => { release = resolve; });
 const waiting = new Promise(resolve => { ready = resolve; });
 const pending = verifyDecodedImage(original);
 // Mutation before the decoder-load await resolves must also be isolated.
 original.data = 'replacement-before-load';
 await waiting;
 original.data = 'replacement-after-metadata'; original.mimeType = 'text/plain';
 release();
 const result = await pending;
 assert.equal(result.data, decoded);
 assert.equal(result.data, data);
 assert.equal(result.mimeType, 'image/png');
 assert.notEqual(result, original);
});
