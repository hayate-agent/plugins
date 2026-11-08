import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercises the materialized plugin bytes in Core (native-activity imports Core
// modules). Run: HARNESS_CORE_ROOT=/path/to/materialized/core tsx --test test/*.test.mjs
const core = process.env.HARNESS_CORE_ROOT;
const load = async () => ({
  ...(await import(pathToFileURL(path.join(core, 'src/builtin-plugins/matrix-channel.ts')).href)),
  ...(await import(pathToFileURL(path.join(core, 'src/builtin-plugins/native-activity.ts')).href)),
  ...(await import(pathToFileURL(path.join(core, 'src/activity.ts')).href)),
});

async function fixture(delayMs = 0) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'native-bubble-'));
  const calls = [];
  const ids = new Map();
  const options = {
    homeserver: 'https://matrix.test', accessToken: 'secret', nativeActivity: true, progress: 'off',
    allowedUsers: [], allowedRooms: [], freeRooms: [], optionalReplyRooms: [], approvers: [],
    allowAllUsers: false, requireMention: true, autoThread: true, dmAutoThread: false,
    processNotices: false, batchDelayMs: 0, syncStateFile: path.join(home, 'sync.json'),
    fetch: async (url, init) => {
      if (url.endsWith('/state/m.room.encryption')) return new Response('{}', { status: 404 });
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (!ids.has(url)) ids.set(url, `$event${ids.size}`);
      return new Response(JSON.stringify({ event_id: ids.get(url) }));
    },
  };
  const room = url => decodeURIComponent(url.split('/rooms/')[1].split('/')[0]);
  const messages = () => calls.filter(c => c.url.includes('/send/') && !c.body['m.new_content']);
  // Distinct chat messages: seed transactions are retried idempotently, so count unique URLs.
  const bubbles = r => new Set(messages().filter(c => room(c.url) === r && c.url.includes('.seed')).map(c => c.url)).size;
  const latest = r => {
    const edits = calls.filter(c => room(c.url) === r && c.body['m.new_content']);
    return edits.at(-1)?.body['m.new_content'].body;
  };
  return { channel: new (await load()).MatrixChannel(options), calls, messages, bubbles, latest, room };
}

const ROOM = { channel: 'matrix', target: '!a:test' };
const OTHER = { channel: 'matrix', target: '!b:test' };
const anchor = id => ({ id, task: 'original', receivedAt: 0, outputTags: ['alpha'] });
const parentInput = id => ({ sessionKey: 'parent', source: 'channel', text: 'SECRET_PROMPT', replyTo: ROOM, completionAnchor: anchor(id) });
// Shape of the dispatcher's synthetic routing envelope (core dispatcher-runtime), plus the origin anchor.
const routed = (id, to = ROOM) => ({ sessionKey: 'parent', source: 'host', text: '', replyTo: to, ...(id ? { completionAnchor: anchor(id) } : {}) });

async function phases(TurnActivity, ch, to, origin, task, { withAnchor = true, failWorker = false } = {}) {
  const emit = input => event => ch.taskActivity(to, event, input);
  const main = new TurnActivity({ id: `main-${origin}`, role: 'main', context: 'operator', outputTags: ['alpha'] }, emit({ ...parentInput(origin), replyTo: to }));
  main.running();
  main.event({ type: 'tool', phase: 'start', name: 'plugin_dispatch', callId: 'M1', detail: 'PRIVATE_ARGS' });
  main.event({ type: 'tool', phase: 'end', name: 'plugin_dispatch', callId: 'M1', detail: 'PRIVATE_RESULT' });
  main.finish('completed');
  await ch.flushNativeActivity();
  const classifier = new TurnActivity({ id: `classifier-${task}`, role: 'dispatcher-classifier', parent: task, context: 'host', outputTags: ['alpha'] },
    event => ch.taskActivity(to, { ...event, snapshot: { ...event.snapshot, parent: task } }, routed(withAnchor && origin, to)));
  classifier.running(); classifier.finish('completed');
  await ch.flushNativeActivity();
  const worker = new TurnActivity({ id: `worker-${task}`, role: 'worker', context: 'worker' },
    event => ch.taskActivity(to, { ...event, snapshot: { ...event.snapshot, outputTags: ['alpha'], parent: task } }, routed(withAnchor && origin, to)));
  worker.running();
  worker.event({ type: 'tool', phase: 'start', name: 'bash', callId: 'W1', detail: 'PRIVATE_ARGS' });
  worker.event({ type: 'tool', phase: 'start', name: 'read', callId: 'W2' });
  await ch.flushNativeActivity();
  worker.event({ type: 'tool', phase: 'end', name: 'bash', callId: 'W1', error: true, detail: 'PRIVATE_RESULT' });
  worker.finish(failWorker ? 'failed' : 'completed');
  await ch.flushNativeActivity();
  // Host result continuation of the same input carries the same completion anchor.
  const result = new TurnActivity({ id: `result-${origin}`, role: 'main', context: 'host', outputTags: ['alpha'] }, emit({ ...parentInput(origin), source: 'host', replyTo: to }));
  result.running(); result.finish('completed');
  await ch.flushNativeActivity();
}

test('main, classifier, worker and result phases of ONE input share one progress bubble plus one final answer', { skip: !core }, async () => {
  const { TurnActivity } = await load();
  const f = await fixture();
  await phases(TurnActivity, f.channel, ROOM, 'origin-1', 'task-1');
  await f.channel.send(ROOM, 'Final answer');
  assert.equal(f.bubbles(ROOM.target), 1, 'one progress message, not one per internal run');
  assert.equal(f.messages().filter(c => c.body.body === 'Final answer').length, 1, 'final result delivered exactly once');
  const text = f.latest(ROOM.target);
  for (const role of ['Main', 'Dispatcher classifier', 'Worker']) assert.match(text, new RegExp(`· ${role} ·`));
  const shown = f.calls.filter(c => c.body['m.new_content']).map(c => c.body['m.new_content'].body).join('\n');
  assert.match(shown, /Worker · [^\n]*Werkzeug (bash|read)/, 'worker tool names stay visible in the shared bubble');
  assert.match(shown, /Main · [^\n]*Werkzeug plugin_dispatch/);
  assert.ok(!JSON.stringify(f.calls).includes('PRIVATE'), 'tool arguments/results never enter chat');
  assert.ok(!JSON.stringify(f.calls).includes('SECRET_PROMPT'));
});

test('without an origin anchor, classifier and worker still share one bubble per dispatched task', { skip: !core }, async () => {
  const { TurnActivity } = await load();
  const f = await fixture();
  await phases(TurnActivity, f.channel, ROOM, 'origin-1', 'task-1', { withAnchor: false });
  assert.equal(f.bubbles(ROOM.target), 2, 'main input bubble plus one task bubble, not four lifecycle messages');
});

test('separate inputs and rooms stay isolated; failures remain visible', { skip: !core }, async () => {
  const { TurnActivity } = await load();
  const f = await fixture();
  await phases(TurnActivity, f.channel, ROOM, 'origin-1', 'task-1');
  await phases(TurnActivity, f.channel, ROOM, 'origin-2', 'task-2', { failWorker: true });
  await phases(TurnActivity, f.channel, OTHER, 'origin-1', 'task-3');
  assert.equal(f.bubbles(ROOM.target), 2, 'two inputs in one room keep separate bubbles');
  assert.equal(f.bubbles(OTHER.target), 1, 'same origin id in another room never merges');
  const edits = f.calls.filter(c => c.body['m.new_content']);
  const byTarget = new Map();
  for (const c of edits) byTarget.set(c.body['m.relates_to'].event_id + f.room(c.url), c.body['m.new_content'].body);
  const texts = [...byTarget.values()];
  assert.ok(texts.some(t => /task-2|Worker · \d+s · [^\n]* · failed/.test(t) && t.includes('failed')), 'worker failure is shown, not swallowed');
  assert.ok(texts.every(t => !(t.includes('failed') && t.split('\n').length > 4)), 'bounded per-input lines');
});

test('slow delivery coalesces to the latest state per bubble without extra messages', { skip: !core }, async () => {
  const { TurnActivity } = await load();
  const f = await fixture(20);
  const ch = f.channel;
  const a = new TurnActivity({ id: 'a', role: 'main', context: 'operator' }, e => ch.taskActivity(ROOM, e, parentInput('A')));
  const b = new TurnActivity({ id: 'b', role: 'main', context: 'operator' }, e => ch.taskActivity(ROOM, e, parentInput('B')));
  a.running(); b.running();
  for (let i = 0; i < 20; i++) {
    a.event({ type: 'tool', phase: 'start', name: 'bash', callId: `a${i}` });
    b.event({ type: 'tool', phase: 'start', name: 'read', callId: `b${i}` });
    a.event({ type: 'tool', phase: 'end', name: 'bash', callId: `a${i}` });
    b.event({ type: 'tool', phase: 'end', name: 'read', callId: `b${i}` });
  }
  a.finish('completed'); b.finish('failed');
  await ch.flushNativeActivity(); await ch.flushNativeActivity();
  assert.equal(f.bubbles(ROOM.target), 2);
  const finals = new Map();
  for (const c of f.calls.filter(c => c.body['m.new_content'])) finals.set(c.body['m.relates_to'].event_id, c.body['m.new_content'].body);
  const values = [...finals.values()].sort();
  assert.equal(values.length, 2);
  assert.ok(values.some(v => v.endsWith('completed')) && values.some(v => v.endsWith('failed')), 'latest terminal state wins after the race');
  // Existing contract flushes on each tool start; 80 events across two inputs stay bounded by
  // the starts plus initial/terminal flushes, never one message per event.
  assert.ok(f.calls.filter(c => c.body['m.new_content']).length <= 2 * 20 + 4, 'bounded edits under slow delivery');
});

test('restart recovery marks every in-flight tool line of a shared bubble interrupted', { skip: !core }, async () => {
  const { NativeActivityDelivery, TurnActivity } = await load();
  const home = await mkdtemp(path.join(os.tmpdir(), 'native-bubble-restart-'));
  const file = path.join(home, 'activity.json');
  const rows = [];
  const send = async (_to, _id, text) => { rows.push(text); };
  const first = new NativeActivityDelivery(file, send, 60000);
  const main = new TurnActivity({ id: 'm', role: 'main', context: 'operator' }, e => first.event(ROOM, e, 'O'));
  const worker = new TurnActivity({ id: 'w', role: 'worker', parent: 'T', context: 'worker' }, e => first.event(ROOM, e, 'O'));
  main.event({ type: 'tool', phase: 'start', name: 'plugin_dispatch', callId: 'x' });
  worker.event({ type: 'tool', phase: 'start', name: 'bash', callId: 'y' });
  await first.flush(); first.stop();
  const reopened = new NativeActivityDelivery(file, send, 60000);
  await reopened.flush(); reopened.stop();
  const recovered = rows.at(-1);
  assert.equal(recovered.split('\n').length, 2);
  assert.equal((recovered.match(/interrupted \(host restart\)/g) ?? []).length, 2);
  main.finish('cancelled'); worker.finish('cancelled');
});
