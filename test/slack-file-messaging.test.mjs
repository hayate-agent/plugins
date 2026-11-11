import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SlackGateway } from '../src/slack-gateway.mjs';
import { SlackFiles } from '../src/slack-files.mjs';

for (const target of ['C1', 'G1', 'D1']) test(`native file send from an API-origin conversation to ${target} is byte exact and survives recreation`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'slack-native-file-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sessionKey = 'api:operator-file-request'; const bytes = Buffer.from([0, 255, 42, 10]);
  const sha256 = createHash('sha256').update(bytes).digest('hex'); const directory = path.join(root, createHash('sha256').update(sessionKey).digest('hex'));
  await mkdir(directory); await writeFile(path.join(directory, sha256), bytes);
  const ref = { sessionKey, sha256, size: bytes.length, name: 'binary.dat' }, calls = []; let transfers = 0;
  const fetch = async (url, init) => {
    if (url.startsWith('https://files.slack.com/')) { transfers++; assert.deepEqual(init.body, bytes); assert.equal(init.headers.Authorization, undefined); return { ok: true }; }
    const parsed = new URL(url); const method = parsed.pathname.split('/').pop(); calls.push({ method, init });
    if (method === 'files.getUploadURLExternal') {
      assert.equal(init.method, 'GET'); assert.equal(parsed.searchParams.get('length'), '4');
      return { ok: true, json: async () => ({ ok: true, upload_url: 'https://files.slack.com/upload/exact', file_id: 'F123' }) };
    }
    assert.equal(method, 'files.completeUploadExternal'); const body = JSON.parse(init.body);
    assert.equal(body.channel_id, target); assert.equal(Object.hasOwn(body, 'thread_ts'), false); assert.equal(body.initial_comment, 'authorized caption');
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const options = { teamId: 'T1', botToken: 'private', attachmentRoot: root };
  const meta = { deliveryId: 'file-request', attachmentSessionKey: sessionKey, attachments: [ref] };
  await new SlackGateway(options, { fetch }).send({ channel: 'slack', target }, 'authorized caption', meta);
  await new SlackGateway(options, { fetch }).send({ channel: 'slack', target }, 'authorized caption', meta);
  assert.equal(calls.length, 2); assert.equal(transfers, 1);
  await assert.rejects(new SlackGateway(options, { fetch }).send({ channel: 'slack', target }, 'changed caption', meta), /different destination/);
  assert.equal(calls.length, 2);
});

test('partial file metadata is resolved by exact ID; attachment-only inbound is admitted without text', async () => {
  let lookups = 0;
  const files = new SlackFiles({ root: '/not-used', botToken: 'secret', info: async id => { lookups++; return { id, size: 4, name: 'image.png', url_private: 'https://files.slack.com/file' }; } });
  assert.equal((await files.metadata({ id: 'F1' })).size, 4); assert.equal(lookups, 1);
  const inputs = []; const gateway = new SlackGateway({ teamId: 'T1', conversation: { defaults: { activation: 'open' } },
    files: { metadata: file => files.metadata(file), download: async (_file, _signal, sessionKey) => ({ sessionKey, sha256: 'a'.repeat(64), size: 4, name: 'image.png' }) } });
  gateway.botId = 'UBOT'; gateway.deliver = async input => inputs.push(input);
  await gateway.receive(JSON.stringify({ type: 'events_api', envelope_id: 'e', payload: { team_id: 'T1', event_id: 'Ev1',
    event: { type: 'message', subtype: 'file_share', channel: 'C1', user: 'U1', ts: '1.001', files: [{ id: 'F1' }] } } }), { send() {} });
  assert.equal(inputs.length, 1); assert.equal(inputs[0].text, ''); assert.equal(inputs[0].attachments[0].size, 4);
});
