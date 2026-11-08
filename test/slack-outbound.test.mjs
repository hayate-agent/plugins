import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlackGateway, SlackDeliveryError } from '../src/slack-gateway.mjs';
const options = { teamId: 'T1', channels: ['C1'], appToken: 'secret-app', botToken: 'secret-bot' };
const destination = { channel: 'slack', target: 'C1', thread: '1.000001' };
const ok = () => ({ ok: true, json: async () => ({ ok: true }) });

test('429 honors Retry-After, suppresses early retries and preserves delivery UUID', async () => {
  let now = 1000; const bodies = [];
  const gateway = new SlackGateway(options, { now: () => now, fetch: async (_, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? { ok: false, status: 429, headers: new Headers({ 'Retry-After': '3' }) } : ok();
  } });
  const send = () => gateway.send(destination, 'hello', { deliveryId: 'core:opaque delivery identity' });
  await assert.rejects(send(), error => error instanceof SlackDeliveryError && error.retryAt === 4000 && !error.ambiguous);
  now = 3999; await assert.rejects(send(), /rate limited/); assert.equal(bodies.length, 1);
  now = 4000; await send();
  assert.equal(bodies.length, 2);
  assert.match(bodies[0].client_msg_id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(bodies[0].client_msg_id, bodies[1].client_msg_id);
});

test('missing/malformed Retry-After uses bounded default; zero still backs off', async () => {
  for (const [header, expected] of [[undefined, 61000], ['tomorrow', 61000], ['-2', 61000], ['0', 2000]]) {
    const gateway = new SlackGateway(options, { now: () => 1000, fetch: async () => ({ ok: false, status: 429,
      headers: new Headers(header === undefined ? {} : { 'Retry-After': header }) }) });
    await assert.rejects(gateway.send(destination, 'hello'), error => error.retryAt === expected);
  }
});

test('network failures, 5xx and malformed JSON are ambiguous and never internally replayed', async () => {
  for (const response of ['network', { ok: false, status: 503 }, { ok: true, json: async () => { throw Error('secret-payload'); } }]) {
    let calls = 0;
    const gateway = new SlackGateway(options, { fetch: async () => {
      calls++; if (response === 'network') throw Error('secret-bot in provider exception'); return response;
    } });
    await assert.rejects(gateway.send(destination, 'hello'), error => error.ambiguous === true && !error.message.includes('secret'));
    assert.equal(calls, 1);
  }
});

test('Slack logical and HTTP errors are explicit and sanitized', async () => {
  for (const [response, message] of [
    [{ ok: true, json: async () => ({ ok: false, error: 'not_in_channel' }) }, /not_in_channel/],
    [{ ok: false, status: 403 }, /HTTP 403/],
    [{ ok: true, json: async () => ({ ok: false, error: 'secret-bot' }) }, /request rejected/],
  ]) {
    const gateway = new SlackGateway(options, { fetch: async () => response });
    await assert.rejects(gateway.send(destination, 'hello'), error => message.test(error.message) && !error.message.includes('secret') && !error.ambiguous);
  }
});

test('logical ratelimited response establishes cooldown without automatic resend', async () => {
  let calls = 0;
  const gateway = new SlackGateway(options, { now: () => 10, fetch: async () => {
    calls++; return { ok: true, json: async () => ({ ok: false, error: 'ratelimited' }) };
  } });
  await assert.rejects(gateway.send(destination, 'hello'), error => error.retryAt === 60010);
  await assert.rejects(gateway.send(destination, 'hello'), /rate limited/);
  assert.equal(calls, 1);
});

test('delivery UUID is scoped to workspace, channel, thread and logical delivery', async () => {
  const ids = [];
  const gateway = new SlackGateway(options, { fetch: async (_, init) => {
    ids.push(JSON.parse(init.body).client_msg_id); return ok();
  } });
  await gateway.send(destination, 'a', { deliveryId: 'one' });
  await gateway.send({ ...destination, thread: '2.0' }, 'a', { deliveryId: 'one' });
  await gateway.send(destination, 'a', { deliveryId: 'two' });
  assert.equal(new Set(ids).size, 3);
});
