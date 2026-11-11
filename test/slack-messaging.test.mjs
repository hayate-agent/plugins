import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackGateway } from '../src/slack-gateway.mjs';

const options = { teamId: 'T1', botToken: 'private-bot' };
test('new public/private channel posts omit thread_ts; exact thread replies remain threaded', async () => {
  const requests = [];
  const gateway = new SlackGateway(options, { fetch: async (url, init) => {
    requests.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true }) };
  } });
  for (const target of ['C1', 'G1', 'D1']) await gateway.send({ channel: 'slack', target }, 'authorized post');
  assert.equal(requests.length, 3);
  assert.ok(requests.every(body => !Object.hasOwn(body, 'thread_ts')));
  await gateway.send({ channel: 'slack', target: 'C1', thread: '001.00002' }, 'thread reply');
  assert.equal(requests[3].thread_ts, '001.00002');
  await assert.rejects(gateway.send({ channel: 'slack', target: 'C1', thread: 'invalid' }, 'no'), /not allowed/);
  const limited = new SlackGateway({ ...options, channels: ['C1'] });
  await assert.rejects(limited.send({ channel: 'slack', target: 'C2' }, 'no'), /not allowed/);
});

test('a proactive channel post engages its returned thread for unmentioned follow-ups', async () => {
  const engaged = new Set(), received = [];
  const gateway = new SlackGateway({ ...options, threads: { add: async key => engaged.add(key), has: async key => engaged.has(key) } },
    { fetch: async () => ({ ok: true, json: async () => ({ ok: true, ts: '1.0001' }) }) });
  gateway.botId = 'UBOT'; gateway.deliver = async input => received.push(input);
  await gateway.send({ channel: 'slack', target: 'C1' }, 'authorized announcement');
  assert.equal(engaged.has('T1:C1:1.0001'), true);
  await gateway.receive(JSON.stringify({ type: 'events_api', envelope_id: 'e', payload: {
    team_id: 'T1', event_id: 'Ev1', event: { type: 'message', channel: 'C1', user: 'U1',
      ts: '1.0002', thread_ts: '1.0001', text: 'follow-up' } } }), { send() {} });
  assert.equal(received.length, 1); assert.equal(received[0].sessionKey, 'slack:T1:C1:1.0001');
});

test('message event with bot mention engages a new thread and deduplicates with app_mention', async () => {
  const received = [], engaged = new Set();
  const gateway = new SlackGateway({ ...options, threads: {
    has: async key => engaged.has(key), add: async key => engaged.add(key),
  } });
  gateway.botId = 'UBOT'; gateway.deliver = async input => received.push(input);
  const send = event => gateway.receive(JSON.stringify({ type: 'events_api', envelope_id: 'e',
    payload: { team_id: 'T1', event_id: 'Ev1', event } }), { send() {} });
  const base = { channel: 'C1', user: 'U1', ts: '1.001', text: '<@UBOT> hello' };
  await send({ ...base, type: 'message' });
  await send({ ...base, type: 'app_mention' });
  assert.equal(received.length, 2);
  assert.equal(received[0].id, received[1].id);
  assert.equal(received[0].sessionKey, 'slack:T1:C1:1.001');
  assert.equal(received[0].text, 'hello');
  await send({ ...base, type: 'message', ts: '1.002', thread_ts: '1.001', text: 'follow-up' });
  assert.equal(received.length, 3);
  await send({ ...base, type: 'message', ts: '2.001', text: 'unaddressed channel traffic' });
  await send({ ...base, type: 'message', ts: '3.001', bot_id: 'B1' });
  await send({ ...base, type: 'message', ts: '4.001', subtype: 'message_changed' });
  assert.equal(received.length, 3);
});

test('destination discovery uses the bot membership endpoint with GET query and bounded cursor', async () => {
  let request;
  const gateway = new SlackGateway({ ...options, channels: ['C1', 'G1'] }, { fetch: async (url, init) => {
    request = { url: new URL(url), init };
    return { ok: true, json: async () => ({ ok: true, channels: [
      { id: 'C1', name: 'joined-public' }, { id: 'G1', name: 'joined-private', is_private: true },
      { id: 'C2', name: 'outside-allowlist' },
    ], response_metadata: { next_cursor: 'next' } }) };
  } });
  gateway.stopped = false; gateway.socket = { readyState: 1 };
  assert.equal(gateway.messaging.describe().connected, true);
  const result = await gateway.messaging.destinations({ limit: 50, cursor: 'prior' });
  assert.equal(request.url.pathname, '/api/users.conversations');
  assert.equal(request.url.searchParams.get('cursor'), 'prior');
  assert.equal(request.url.searchParams.get('limit'), '50');
  assert.equal(request.init.method, 'GET'); assert.equal(request.init.body, undefined);
  // users.conversations already returns memberships; Slack omits is_member here.
  assert.deepEqual(result.destinations.map(item => item.target), ['C1', 'G1']);
  assert.equal(result.nextCursor, 'next'); assert.equal(gateway.pending.size, 0);
  gateway.stopped = true;
  await assert.rejects(gateway.messaging.destinations(), /not connected/);
});
