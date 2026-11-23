import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { WebUIChannel } from '../index.mjs';
import { Workspace } from '../../workspace/service.mjs';

// A real, decodable PNG larger than one 60000-byte chunk, built without extra dependencies.
function png(side = 250) {
  const chunk = (type, body) => { const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(type, 4); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body]))); return Buffer.concat([head, body, tail]); };
  const rows = Buffer.concat(Array.from({ length: side }, () => Buffer.concat([Buffer.from([0]), randomBytes(side * 3)])));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'local-image-'));
  const bindings = new Map();
  const workspace = new Workspace({ home, cwd: home, executionContexts: { async bind(key, value) { bindings.set(key, value); }, get: key => bindings.get(key) } });
  await workspace.open(); workspace.imageUploads = true; await workspace.channel.start(async () => {});
  const channel = new WebUIChannel({ home, port: 0, services: { get: name => name === 'workspaces' ? { version: 1, implementation: workspace } : undefined } });
  await channel.start(async () => {});
  t.after(async () => { await channel.stop(); await workspace.stop(); await rm(home, { recursive: true, force: true }); });
  const post = (route, value) => fetch(channel.url + '/api/workspace' + route, { method: 'POST', headers: { Origin: channel.url, 'X-Hayate-WebUI': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const get = route => fetch(channel.url + '/api/workspace' + route);
  return { channel, workspace, post, get };
}
async function send(f, picture) {
  const stream = await (await f.post('/streams', { title: 'Pictures' })).json();
  const uploadId = randomUUID(); let image;
  for (let i = 0, offset = 0; offset < picture.length; i++, offset += 30000) image = await (await f.post(`/streams/${stream.id}/media`, { uploadId, index: i, data: picture.subarray(offset, offset + 30000).toString('base64'), mimeType: 'image/png', final: offset + 30000 >= picture.length })).json();
  const id = randomUUID();
  assert.equal((await f.post(`/streams/${stream.id}/messages`, { id, text: 'a picture', attachments: [{ id: image.id }] })).status, 202);
  return { stream, id };
}

test('own dashboard route: conversation lists image metadata only; image route returns bounded chunks that reassemble exactly', async t => {
  const f = await fixture(t); const picture = png();
  const { stream, id } = await send(f, picture);
  const conversation = await (await f.get(`/streams/${stream.id}`)).json();
  const shown = conversation.messages.find(message => message.id === id);
  assert.deepEqual(shown.images, [{ mimeType: 'image/png', bytes: picture.length }]);
  assert.ok(!JSON.stringify(conversation).includes(picture.toString('base64').slice(0, 60)), 'no bytes in the conversation');
  const parts = []; let offset = 0, guard = 0;
  for (;;) {
    const response = await f.get(`/streams/${stream.id}/image?message=${id}&index=0&offset=${offset}`);
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
    const chunk = await response.json(); const bytes = Buffer.from(chunk.data, 'base64');
    assert.ok(bytes.length <= 60000); parts.push(bytes); offset = chunk.next; if (chunk.done) break; assert.ok(++guard < 20);
  }
  assert.ok(parts.length >= 2); assert.equal(Buffer.concat(parts).compare(picture), 0);
});

test('own dashboard image route refuses unknown messages, bad indexes and other streams', async t => {
  const f = await fixture(t); const { stream, id } = await send(f, png(40));
  const other = await (await f.post('/streams', { title: 'Other' })).json();
  assert.equal((await f.get(`/streams/${stream.id}/image?message=nope&index=0&offset=0`)).status, 404);
  assert.equal((await f.get(`/streams/${stream.id}/image?message=${id}&index=9&offset=0`)).status >= 400, true);
  assert.equal((await f.get(`/streams/${stream.id}/image?message=${id}&index=abc&offset=0`)).status, 400);
  assert.equal((await f.get(`/streams/${stream.id}/image?index=0&offset=0`)).status, 400);
  assert.equal((await f.get(`/streams/${other.id}/image?message=${id}&index=0&offset=0`)).status, 404);
  assert.equal((await fetch(f.channel.url + `/api/workspace/streams/${stream.id}/image?message=${id}&index=0`, { method: 'POST', headers: { Origin: f.channel.url, 'X-Hayate-WebUI': '1', 'Content-Type': 'application/json' }, body: '{}' })).status >= 400, true);
});
