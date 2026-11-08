import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SlackFiles, imageType } from '../src/slack-files.mjs';
const descriptor = { id: 'F123', name: '../../unsafe.png', size: 8, url_private: 'https://files.slack.com/files-pri/T1-F123/file' };
const png = Buffer.from([137,80,78,71,13,10,26,10]);
const session = 'slack:T1:C1:1';
test('private binary download is durable, session bound and survives reopening', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'slack-files-'));
  try {
    let init;
    const store = new SlackFiles({ root, botToken: 'secret', fetch: async (_, request) => { init = request; return new Response(png); } });
    const ref = await store.download(descriptor, undefined, session);
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, 'Bearer secret');
    assert.equal(ref.mimeType, 'image/png'); assert.equal(path.dirname(path.dirname(ref.path)), root);
    assert.deepEqual(await readFile(ref.path), png);
    assert.deepEqual(await new SlackFiles({ root }).read(ref, session), png);
    await assert.rejects(store.read(ref, 'slack:T1:C2:1'), /session mismatch/);
    assert.equal(ref.sha256, (await store.download(descriptor, undefined, session)).sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('untrusted download URLs cannot receive the bot token', async () => {
  let calls = 0;
  const store = new SlackFiles({ root: '/unused', botToken: 'secret', fetch: async () => { calls++; } });
  for (const url of ['https://evil.test/x', 'http://files.slack.com/x', 'https://files.slack.com.evil.test/x', 'https://user:pass@files.slack.com/x']) {
    await assert.rejects(store.download({ ...descriptor, url_private: url }, undefined, session), /Untrusted/);
  }
  assert.equal(calls, 0);
});
test('declared, streamed and truncated size failures are rejected before persistence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'slack-files-'));
  try {
    const store = new SlackFiles({ root, maxBytes: 8, fetch: async () => new Response(Buffer.alloc(9)) });
    await assert.rejects(store.download({ ...descriptor, size: 9 }, undefined, session), /limit/);
    await assert.rejects(store.download(descriptor, undefined, session), /oversized/);
    store.fetch = async () => new Response(Buffer.alloc(2));
    await assert.rejects(store.download(descriptor, undefined, session), /mismatch/);
    store.fetch = async () => new Response('', { status: 302, headers: { Location: 'https://evil.test/' } });
    await assert.rejects(store.download(descriptor, undefined, session), /failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('binary content rather than filename determines image type', () => {
  assert.equal(imageType(Buffer.from('not a png')), undefined);
  assert.equal(imageType(Buffer.from([255,216,255,0])), 'image/jpeg');
  assert.equal(imageType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(imageType(Buffer.from('RIFFxxxxWEBP')), 'image/webp');
});
