import test from 'node:test';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../service.mjs';

async function setup(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'workspace-img-'));
  const bindings = new Map();
  const service = new Workspace({ home, cwd: home, executionContexts: { async bind(key, value) { bindings.set(key, value); }, get: key => bindings.get(key) } });
  await service.open(); t.after(async () => { await service.stop(); await rm(home, { recursive: true, force: true }); });
  service.imageUploads = true;
  return { service, home };
}
async function chatWithImage(service, extra = 0) {
  const chat = await service.createStream('operator', { title: 'Picture chat' });
  const { randomBytes } = await import('node:crypto');
  const png = extra
    ? await sharp(randomBytes(200 * 200 * 3), { raw: { width: 200, height: 200, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
    : await sharp({ create: { width: 32, height: 32, channels: 3, background: 'blue' } }).png().toBuffer();
  const uploadId = randomUUID(), step = 30000; let image;
  for (let i = 0, offset = 0; offset < png.length; i++, offset += step) {
    image = await service.uploadMedia('operator', chat.id, { uploadId, index: i, data: png.subarray(offset, offset + step).toString('base64'), mimeType: 'image/png', final: offset + step >= png.length });
  }
  await service.channel.start(async () => {});
  const message = { id: randomUUID(), text: 'look', attachments: [{ id: image.id }] };
  await service.submit('operator', chat.id, message);
  return { chat, message, png };
}
test('page lists image metadata only; imageChunk returns bounded chunks that reassemble exactly', async t => {
  const { service } = await setup(t);
  const { chat, message, png } = await chatWithImage(service, 1);
  const page = service.page('operator', chat.id);
  const shown = page.messages.find(item => item.id === message.id);
  assert.deepEqual(shown.images, [{ mimeType: 'image/png', bytes: png.length }]);
  assert.ok(!JSON.stringify(page).includes(png.toString('base64').slice(0, 40)), 'no bytes in the page');
  const parts = []; let offset = 0, guard = 0;
  for (;;) {
    const chunk = await service.imageChunk('operator', chat.id, message.id, 0, offset);
    assert.ok(Buffer.from(chunk.data, 'base64').length <= 60000);
    parts.push(Buffer.from(chunk.data, 'base64')); offset = chunk.next; if (chunk.done) break; assert.ok(++guard < 20);
  }
  assert.ok(parts.length >= 3); assert.equal(Buffer.concat(parts).compare(png), 0);
});
test('imageChunk is owner-scoped and refuses bad indexes, offsets, tampered or missing files', async t => {
  const { service, home } = await setup(t);
  const { chat, message, png } = await chatWithImage(service);
  await assert.rejects(service.imageChunk('other', chat.id, message.id, 0), /not found/i);
  await assert.rejects(service.imageChunk('operator', chat.id, 'nope', 0), { status: 404 });
  await assert.rejects(service.imageChunk('operator', chat.id, message.id, 1), { status: 404 });
  await assert.rejects(service.imageChunk('operator', chat.id, message.id, -1), { status: 404 });
  await assert.rejects(service.imageChunk('operator', chat.id, message.id, 0, png.length), { status: 400 });
  const item = service.stream('operator', chat.id).messages.find(m => m.id === message.id).attachments[0];
  const file = path.join(home, 'attachments', createHash('sha256').update(item.sessionKey).digest('hex'), item.sha256);
  await writeFile(file, Buffer.alloc(png.length, 1));
  await assert.rejects(service.imageChunk('operator', chat.id, message.id, 0), { status: 404 }, 'signature check refuses tampered bytes');
  await rm(file);
  await assert.rejects(service.imageChunk('operator', chat.id, message.id, 0), { status: 404 });
});
test('an attachment record pointing at another conversation\'s real image is never served', async t => {
  const { service } = await setup(t);
  const mine = await chatWithImage(service), theirs = await chatWithImage(service);
  const foreign = service.stream('operator', theirs.chat.id).messages.find(m => m.id === theirs.message.id).attachments[0];
  await service.store.change(data => { data.streams.find(s => s.id === mine.chat.id).messages.find(m => m.id === mine.message.id).attachments[0] = { ...foreign }; });
  await assert.rejects(service.imageChunk('operator', mine.chat.id, mine.message.id, 0), { status: 404 });
  assert.ok((await service.imageChunk('operator', theirs.chat.id, theirs.message.id, 0)).data, 'the rightful chat still reads it');
});
