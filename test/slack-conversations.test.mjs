import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SlackGateway } from '../src/slack-gateway.mjs';
import { SlackThreads } from '../src/slack-threads.mjs';
const envelope = (event, id = 'Ev1') => JSON.stringify({ type: 'events_api', envelope_id: id, payload: { team_id: 'T1', event_id: id, event } });
const socket = { send() {} };
test('DM messages share a stable conversation without mentioning the bot', async () => {
  const received = [];
  const gateway = new SlackGateway({ teamId: 'T1' }); gateway.botId = 'UBOT';
  gateway.deliver = async input => received.push(input);
  for (const ts of ['1.001', '2.002']) await gateway.receive(envelope({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', ts, text: 'hello' }, ts), socket);
  assert.equal(received.length, 2);
  assert.equal(received[0].sessionKey, 'slack:T1:D1:dm');
  assert.equal(received[1].sessionKey, received[0].sessionKey);
  assert.deepEqual(received[0].replyTo, { channel: 'slack', target: 'D1' });
});
test('mention and message events for the same Slack message have the same durable dedup identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'slack-dedup-'));
  try {
    const inputs = [];
    const gateway = new SlackGateway({ teamId: 'T1', threads: new SlackThreads(root) }); gateway.botId = 'UBOT';
    gateway.deliver = async input => inputs.push(input);
    const event = { channel: 'C1', user: 'U1', ts: '2.002', thread_ts: '1.001', text: '<@UBOT> hello' };
    await gateway.receive(envelope({ ...event, type: 'app_mention' }, 'mention-event'), socket);
    await gateway.receive(envelope({ ...event, type: 'message' }, 'message-event'), socket);
    assert.equal(inputs.length, 2); // Core, not the adapter, performs durable deduplication.
    assert.equal(inputs[0].id, inputs[1].id);
    assert.equal(inputs[0].sessionKey, inputs[1].sessionKey);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('concurrent thread membership updates remain complete after reopening, with no temp files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'slack-atomic-'));
  try {
    const threads = new SlackThreads(root); const key = 'T1:C1:1.001';
    await Promise.all(Array.from({ length: 20 }, () => threads.add(key)));
    assert.equal(await new SlackThreads(root).has(key), true);
    const names = await readdir(root);
    assert.equal(names.length, 1); assert.equal(names[0].startsWith('.'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('foreign workspace events cannot consult or persist engaged-thread state', async () => {
  let lookups = 0;
  const gateway = new SlackGateway({ teamId: 'T2', threads: { has: async () => { lookups++; } } });
  await gateway.receive(envelope({ type: 'message', channel: 'C1', thread_ts: '1.001' }), socket);
  assert.equal(lookups, 0);
});
test('only explicitly engaged channel threads continue, including after reopening storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'slack-threads-'));
  try {
    const received = [];
    const gateway = new SlackGateway({ teamId: 'T1', threads: new SlackThreads(root) }); gateway.botId = 'UBOT';
    gateway.deliver = async input => received.push(input);
    const event = { type: 'message', channel: 'C1', user: 'U1', ts: '2.002', thread_ts: '1.001', text: 'continue' };
    await gateway.receive(envelope(event), socket); assert.equal(received.length, 0);
    await gateway.receive(envelope({ ...event, type: 'app_mention', ts: '1.001', thread_ts: undefined }), socket);
    gateway.options.threads = new SlackThreads(root);
    await gateway.receive(envelope(event, 'Ev2'), socket);
    assert.equal(received.length, 2);
    assert.equal(received[0].sessionKey, received[1].sessionKey);
    await gateway.receive(envelope({ ...event, thread_ts: '9.009' }, 'Ev3'), socket);
    assert.equal(received.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
