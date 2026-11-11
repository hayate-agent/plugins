import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { SlackGateway } from '../src/slack-gateway.mjs';
const options = { teamId: 'T1', channels: ['C1'], appToken: 'app-secret', botToken: 'bot-secret' };
const event = (patch = {}) => JSON.stringify({ type: 'events_api', envelope_id: 'envelope-1', payload: {
  team_id: 'T1', event_id: 'Ev1', event: { type: 'app_mention', channel: 'C1', user: 'U1', ts: '123.456', text: '<@UBOT> Hello', ...patch },
} });
test('ack follows durable acceptance; thread and stable identities are preserved', async () => {
  const g = new SlackGateway(options); g.botId = 'UBOT';
  const sent = []; let input; let release;
  g.deliver = async value => { input = value; await new Promise(resolve => { release = resolve; }); };
  const work = g.receive(event(), { send: s => sent.push(JSON.parse(s)) });
  assert.equal(sent.length, 0);
  assert.equal(input.id, 'slack:T1:C1:123.456');
  assert.equal(input.sessionKey, 'slack:T1:C1:123.456');
  assert.equal(input.sender, 'slack:T1:U1');
  assert.equal(input.text, 'Hello');
  assert.deepEqual(input.replyTo, { channel: 'slack', target: 'C1', thread: '123.456' });
  release(); await work;
  assert.deepEqual(sent, [{ envelope_id: 'envelope-1' }]);
});
test('failed acceptance is not acknowledged; existing thread remains string', async () => {
  const g = new SlackGateway(options); g.botId = 'UBOT';
  let ack = false;
  g.deliver = async input => { assert.equal(input.replyTo.thread, '001.000002'); throw Error('disk failed'); };
  await assert.rejects(g.receive(event({ thread_ts: '001.000002' }), { send: () => { ack = true; } }), /disk failed/);
  assert.equal(ack, false);
});
test('bot, edited and unapproved-channel events are ignored and acknowledged', async () => {
  const g = new SlackGateway(options); g.botId = 'UBOT'; let calls = 0; let acks = 0;
  g.deliver = async () => { calls++; };
  for (const patch of [{ bot_id: 'B1' }, { user: 'UBOT' }, { subtype: 'message_changed' }, { channel: 'C2' }]) {
    await g.receive(event(patch), { send: () => { acks++; } });
  }
  assert.equal(calls, 0); assert.equal(acks, 4);
});
test('attachment references bind to the actual Slack thread before acceptance', async () => {
  let owner; let accepted;
  const g = new SlackGateway({ ...options, files: { download: async (_, __, key) => {
    owner = key; return { sha256: 'a'.repeat(64), size: 8, name: 'image.png' };
  } } });
  g.botId = 'UBOT'; g.deliver = async input => { accepted = input; };
  await g.receive(event({ files: [{ size: 8 }], thread_ts: '001.2' }), { send() {} });
  assert.equal(owner, 'slack:T1:C1:001.2');
  assert.equal(accepted.attachments[0].sessionKey, accepted.sessionKey);
  await assert.rejects(g.receive(event({ files: [{ size: 21 * 1024 * 1024 }] }), { send() {} }), /total/);
});

test('outbound reply stays in allowed thread and does not unfurl links', async () => {
  let request;
  const g = new SlackGateway(options, { fetch: async (url, init) => {
    request = { url, body: JSON.parse(init.body) }; return { ok: true, json: async () => ({ ok: true }) };
  } });
  await g.send({ channel: 'slack', target: 'C1', thread: '123.456' }, 'hello', { deliveryId: 'delivery-1' });
  assert.equal(request.body.thread_ts, '123.456'); assert.equal(request.body.unfurl_links, false);
  await assert.rejects(g.send({ channel: 'slack', target: 'C2', thread: '123' }, 'no'), /not allowed/);
  await assert.rejects(g.send({ channel: 'slack', target: 'C1', thread: '123.0' }, 'x'.repeat(40000)), /length/);
});
test('factory has no network side effects and returns undefined when unconfigured', async () => {
  const names = ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_TEAM_ID', 'SLACK_CHANNEL_IDS'];
  const saved = names.map(n => process.env[n]);
  try {
    for (const n of names) delete process.env[n];
    assert.equal(await plugin.create({}), undefined);
    process.env.SLACK_APP_TOKEN = 'x';
    await assert.rejects(plugin.create({}), /Incomplete/);
    Object.assign(process.env, { SLACK_APP_TOKEN: 'x', SLACK_BOT_TOKEN: 'y' });
    await assert.rejects(plugin.create({ home: '/test-home' }), /requires Core/);
    assert.equal((await plugin.create({ home: '/test-home', inboundAttachments: 1 })).channel.name, 'slack');
  } finally { names.forEach((n, i) => { if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i]; }); }
});
