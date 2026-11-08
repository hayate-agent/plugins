import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { SlackUploader } from '../src/slack-upload.mjs';
const sessionKey = 'slack:T1:C1:1.001';
const to = { channel: 'slack', target: 'C1', thread: '1.001' };
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'slack-upload-'));
  const bytes = Buffer.from([0, 255, 1, 2]); const sha256 = createHash('sha256').update(bytes).digest('hex');
  const directory = path.join(root, createHash('sha256').update(sessionKey).digest('hex'));
  await mkdir(directory); await writeFile(path.join(directory, sha256), bytes);
  return { root, bytes, reference: { sessionKey, sha256, size: bytes.length, name: 'binary.dat' } };
}
test('binary upload is scoped, byte exact and completion survives process recreation without replay', async () => {
  const f = await fixture(); const calls = []; let transfers = 0;
  try {
    const options = { root: f.root, api: async (method, body) => {
      calls.push({ method, body });
      return method === 'files.getUploadURLExternal' ? { upload_url: 'https://files.slack.com/upload/v1/opaque', file_id: 'F123' } : { ok: true };
    }, fetch: async (_, init) => {
      transfers++; assert.deepEqual(init.body, f.bytes); assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, undefined); return { ok: true };
    } };
    const input = { sessionKey, to, reference: f.reference, deliveryId: 'delivery-1' };
    assert.deepEqual(await new SlackUploader(options).send(input), { fileId: 'F123' });
    assert.deepEqual(calls[1].body, { files: [{ id: 'F123', title: 'binary.dat' }], channel_id: 'C1', thread_ts: '1.001' });
    await new SlackUploader(options).send(input);
    assert.equal(calls.length, 2); assert.equal(transfers, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('ambiguous completion is durably blocked rather than creating another Slack file', async () => {
  const f = await fixture(); let allocations = 0;
  try {
    const options = { root: f.root, api: async method => {
      if (method === 'files.getUploadURLExternal') { allocations++; return { upload_url: 'https://files.slack.com/upload/x', file_id: 'F123' }; }
      throw Error('network interrupted');
    }, fetch: async () => ({ ok: true }) };
    const input = { sessionKey, to, reference: f.reference, deliveryId: 'ambiguous' };
    await assert.rejects(new SlackUploader(options).send(input), /interrupted/);
    await assert.rejects(new SlackUploader(options).send(input), /uncertain/);
    assert.equal(allocations, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('foreign session references and mismatched destinations never allocate an upload', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const uploader = new SlackUploader({ root: f.root, api: async () => { calls++; } });
    await assert.rejects(uploader.send({ sessionKey, to, reference: { ...f.reference, sessionKey: 'slack:T1:C2:1.001' }, deliveryId: 'x' }), /Invalid scoped/);
    await assert.rejects(uploader.send({ sessionKey, to: { ...to, target: 'C2' }, reference: f.reference, deliveryId: 'x' }), /Invalid scoped/);
    assert.equal(calls, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
