import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackGateway } from '../src/slack-gateway.mjs';
import { conversationPolicy, conversationRule } from '../src/conversation-policy.mjs';

const envelope = (event, team = 'T1') => JSON.stringify({ type: 'events_api', envelope_id: 'e', payload: { team_id: team, event_id: 'Ev1', event } });
const base = { type: 'message', channel: 'C1', user: 'U1', ts: '1.001', text: 'hello' };
function fixture(policy) {
  const inputs = [], engaged = new Set(); let acks = 0, lookups = 0, downloads = 0;
  const gateway = new SlackGateway({ teamId: 'T1', conversation: policy,
    threads: { add: async key => engaged.add(key), has: async key => { lookups++; return engaged.has(key); } },
    files: { download: async () => { downloads++; return {}; } } });
  gateway.botId = 'UBOT'; gateway.deliver = async input => inputs.push(input);
  return { gateway, inputs, engaged, get lookups() { return lookups; }, get downloads() { return downloads; }, get acks() { return acks; },
    receive: event => gateway.receive(envelope(event), { send() { acks++; } }) };
}

test('defaults apply to future channels; per-channel fields inherit without overwriting access', async () => {
  const f = fixture({ defaults: { users: ['U1'], activation: 'mentions' }, channels: { C1: { activation: 'open', replyLocation: 'channel' } } });
  await f.receive(base); assert.equal(f.inputs.length, 1);
  assert.equal(f.inputs[0].replyOptional, true); assert.deepEqual(f.inputs[0].replyTo, { channel: 'slack', target: 'C1' });
  assert.equal(f.inputs[0].sessionKey, 'slack:T1:C1:channel');
  await f.receive({ ...base, ts: '1.002' }); assert.equal(f.inputs[1].sessionKey, f.inputs[0].sessionKey);
  await f.receive({ ...base, channel: 'CNEW' }); assert.equal(f.inputs.length, 2);
  await f.receive({ ...base, channel: 'CNEW', text: '<@UBOT> addressed' }); assert.equal(f.inputs.length, 3);
  await f.receive({ ...base, user: 'U2', text: '<@UBOT> denied' }); assert.equal(f.inputs.length, 3);
});

test('all users/all channels is explicit, but it grants no admin identity and never loops on bot echoes', async () => {
  const f = fixture({ allowedChannels: '*', defaults: { users: '*', activation: 'open', replyLocation: 'thread' } });
  for (const [channel, user] of [['C1', 'U1'], ['GNEW', 'U2']]) await f.receive({ ...base, channel, user });
  assert.equal(f.inputs.length, 2); assert.equal(f.inputs[1].sender, 'slack:T1:U2');
  assert.equal(f.inputs[1].replyTo.thread, '1.001');
  await f.receive({ ...base, bot_id: 'BOTHER', text: '<@UBOT> bot loop' });
  await f.receive({ ...base, user: 'UBOT', ts: '2.001', subtype: 'file_share' });
  assert.equal(f.inputs.length, 2); assert.equal(f.engaged.has('T1:C1:2.001'), true);
});

test('access denial and disabled channels happen before thread lookup or attachment download', async () => {
  const f = fixture({ allowedChannels: ['C1', 'C2'], defaults: { activation: 'open', users: ['U1'] }, channels: { C2: { activation: 'disabled' } } });
  for (const patch of [{ user: 'U2' }, { channel: 'C3' }, { channel: 'C2' }]) await f.receive({ ...base, thread_ts: '1.0', files: [{ size: 1 }], ...patch });
  assert.equal(f.acks, 3); assert.equal(f.inputs.length, 0); assert.equal(f.lookups, 0); assert.equal(f.downloads, 0);
  const deny = fixture({ defaults: { users: [], activation: 'open' } }); await deny.receive(base); assert.equal(deny.inputs.length, 0);
});

test('mentions requires each mention; threads allows engaged continuations; DM still needs no mention', async () => {
  const f = fixture({ defaults: { activation: 'threads' } });
  await f.receive({ ...base, text: '<@UBOT> start' });
  await f.receive({ ...base, ts: '1.002', thread_ts: '1.001' }); assert.equal(f.inputs.length, 2);
  f.gateway.configureGateway({ conversation: { defaults: { activation: 'mentions' } } });
  await f.receive({ ...base, ts: '1.003', thread_ts: '1.001' }); assert.equal(f.inputs.length, 2);
  await f.receive({ ...base, ts: '1.004', thread_ts: '1.001', text: '<@UBOT> again' }); assert.equal(f.inputs.length, 3);
  await f.receive({ ...base, channel: 'D1', channel_type: 'im' }); assert.equal(f.inputs.length, 4);
  assert.equal(f.inputs[3].sessionKey, 'slack:T1:D1:dm');
});

test('access changes while downloading cannot admit an input under the obsolete policy', async () => {
  const f = fixture({ defaults: { activation: 'open' } });
  let entered, release; const started = new Promise(resolve => { entered = resolve; });
  f.gateway.options.files.download = async (_file, _signal, sessionKey) => {
    entered(); await new Promise(resolve => { release = resolve; });
    return { sessionKey, sha256: 'a'.repeat(64), size: 1, name: 'file' };
  };
  const work = f.receive({ ...base, files: [{ size: 1 }] }); const refused = assert.rejects(work, /policy changed/);
  await started; f.gateway.configureGateway({ conversation: { defaults: { users: [], activation: 'open' } } });
  release(); await refused; assert.equal(f.inputs.length, 0); assert.equal(f.acks, 0);
});

test('invalid policy fails closed and status describes effective policy without tokens', () => {
  for (const p of [{ defaults: { users: true } }, { allowedChannels: 'all' }, { defaults: { activation: 'always' } }, { defaults: { admin: true } }])
    assert.throws(() => conversationPolicy(p), /Invalid/);
  const f = fixture({ defaults: { users: ['U1'] }, channels: { C1: { activation: 'open' } } });
  assert.equal(conversationRule(f.gateway.policy, 'C1').users[0], 'U1');
  assert.equal(f.gateway.messaging.describe().conversation.defaults.users[0], 'U1');
  assert.equal(f.gateway.conversationPolicy, 1);
});
