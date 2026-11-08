import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlackGateway } from '../src/slack-gateway.mjs';
const options = { teamId: 'T1', channels: ['C1'], appToken: 'app', botToken: 'bot' };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 2)); }
  assert.fail('condition not reached');
}
function fixture({ open = true, close = true, fetch: fetchOverride } = {}) {
  const sockets = []; let active = 0; let maximum = 0;
  class Socket extends EventTarget {
    readyState = 0;
    constructor() {
      super(); sockets.push(this); active++; maximum = Math.max(maximum, active);
      if (open) queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1; this.dispatchEvent(new Event('open'));
      });
    }
    close() { if (close) this.finishClose(); }
    finishClose() {
      if (this.readyState === 3) return;
      this.readyState = 3; active--; this.dispatchEvent(new Event('close'));
    }
    send() {}
    message(value) { const e = new Event('message'); e.data = JSON.stringify(value); this.dispatchEvent(e); }
  }
  const transport = {
    WebSocket: Socket, connectTimeoutMs: 15, stopTimeoutMs: 20, reconnectMs: 2, reconnectMaxMs: 8,
    fetch: fetchOverride ?? (async url => ({ ok: true, json: async () => url.endsWith('auth.test')
      ? { ok: true, team_id: 'T1', user_id: 'UBOT' } : { ok: true, url: 'wss://example.test/socket' } })),
  };
  return { gateway: new SlackGateway({ ...options }, transport), sockets, transport, get maximum() { return maximum; } };
}
test('two tokens suffice: workspace is discovered and event channel supplies routing', async () => {
  const f = fixture();
  delete f.gateway.options.teamId;
  delete f.gateway.options.channels;
  let input;
  await f.gateway.start(async value => { input = value; });
  assert.equal(f.gateway.options.teamId, 'T1');
  await f.gateway.receive(JSON.stringify({ type: 'events_api', envelope_id: 'e', payload: {
    team_id: 'T1', event_id: 'Ev1', event: { type: 'app_mention', channel: 'C99', user: 'U1', ts: '1.001', text: 'hello' },
  } }), f.sockets[0]);
  assert.equal(input.replyTo.target, 'C99');
  assert.equal(input.sessionKey, 'slack:T1:C99:1.001');
  await f.gateway.stop();
});

test('handshake timeout is bounded, cleans up and permits restart', async () => {
  const f = fixture({ open: false });
  await assert.rejects(f.gateway.start(async () => {}), /timed out/);
  assert.equal(f.sockets[0].readyState, 3);
  await f.gateway.stop();
  const starting = f.gateway.start(async () => {});
  await until(() => f.sockets.length === 2);
  f.sockets[1].readyState = 1; f.sockets[1].dispatchEvent(new Event('open'));
  await starting; await f.gateway.stop();
  assert.equal(f.maximum, 1);
});
test('disconnect reconnects without overlapping receivers and stop cancels retry', async () => {
  const f = fixture(); await f.gateway.start(async () => {});
  f.sockets[0].message({ type: 'disconnect' });
  await until(() => f.sockets.length === 2 && f.sockets[1].readyState === 1);
  assert.equal(f.maximum, 1);
  f.sockets[1].finishClose(); await f.gateway.stop();
  await new Promise(r => setTimeout(r, 15));
  assert.equal(f.sockets.length, 2);
});
test('stop during handshake cancels start and does not reconnect', async () => {
  const f = fixture({ open: false });
  const starting = f.gateway.start(async () => {});
  const rejected = assert.rejects(starting, /cancelled|aborted/i);
  await until(() => f.sockets.length === 1);
  await f.gateway.stop(); await rejected;
  assert.equal(f.sockets[0].readyState, 3);
  await tick(); assert.equal(f.gateway.timer, undefined);
});
test('stop cancels in-flight connection API before a socket can be created', async () => {
  let requested = false;
  const f = fixture({ fetch: async (url, init) => {
    if (url.endsWith('auth.test')) return { ok: true, json: async () => ({ ok: true, team_id: 'T1', user_id: 'UBOT' }) };
    requested = true;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
  } });
  const starting = f.gateway.start(async () => {}); const rejected = assert.rejects(starting, /transport failed/);
  await until(() => requested); await f.gateway.stop(); await rejected;
  assert.equal(f.sockets.length, 0);
});
test('replacement drains accepted delivery before new gateway starts; rollback can restart old', async () => {
  const f = fixture(); let release; let calls = 0;
  await f.gateway.start(async () => { calls++; await new Promise(r => { release = r; }); });
  const socket = f.sockets[0];
  socket.message({ type: 'events_api', envelope_id: 'e', payload: { team_id: 'T1', event_id: 'Ev1', event: {
    type: 'app_mention', channel: 'C1', user: 'U1', ts: '1.1', text: 'hi',
  } } });
  let done = false; const stopped = f.gateway.stop().then(() => { done = true; });
  await tick(); assert.equal(done, false);
  socket.message({ type: 'events_api', envelope_id: 'ignored' }); assert.equal(calls, 1);
  release(); await stopped;
  const replacement = new SlackGateway(options, f.transport);
  await replacement.start(async () => {}); await replacement.stop();
  await f.gateway.start(async () => {}); await f.gateway.stop();
  assert.equal(f.maximum, 1);
});
test('failed reconnect retries with a capped delay and stop prevents subsequent work', async () => {
  const f = fixture();
  await f.gateway.start(async () => {});
  const original = f.gateway.api.bind(f.gateway); let attempts = 0;
  f.gateway.api = async (...args) => {
    if (args[0] === 'apps.connections.open' && ++attempts < 3) throw Error('temporary outage');
    return original(...args);
  };
  f.sockets[0].finishClose();
  await until(() => f.sockets.length === 2 && f.sockets[1].readyState === 1);
  assert.equal(attempts, 3); assert.equal(f.maximum, 1);
  await f.gateway.stop();
  await new Promise(r => setTimeout(r, 20)); assert.equal(attempts, 3);
});
test('unclosed socket makes stop fail rather than claiming safe replacement', async () => {
  const f = fixture({ close: false }); await f.gateway.start(async () => {});
  await assert.rejects(f.gateway.stop(5), /did not quiesce/);
  await assert.rejects(f.gateway.start(async () => {}), /not quiesced/);
  f.sockets[0].finishClose(); await f.gateway.stop();
});
