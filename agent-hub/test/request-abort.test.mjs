import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentHub } from '../service.mjs';

function setup(withSecret, request) {
 const hub = new AgentHub({ home: '/tmp/hub-abort', credentials: { put() {}, withSecret } });
 hub.store.read = () => ({ agents: [{ id: 'a', owner: 'operator', adapter: 'probe', endpoint: 'https://test.invalid', credential: 'c', capabilities: ['messages'] }], codes: [] });
 hub.registerAdapter('probe', { pair() {}, request });
 return hub;
}
test('pre-aborted request never resolves secrets or dispatches', async () => {
 let secrets = 0, dispatches = 0;
 const hub = setup(async (_, __, fn) => { secrets++; return fn('synthetic'); }, async () => { dispatches++; });
 const controller = new AbortController(), reason = new Error('cancelled'); controller.abort(reason);
 await assert.rejects(hub.request('operator', 'a', 'messages', {}, controller.signal), error => error === reason);
 assert.equal(secrets, 0); assert.equal(dispatches, 0);
});
test('abort during secret resolution prevents later adapter dispatch', async () => {
 const controller = new AbortController(), reason = new Error('cancelled during lookup'); let dispatches = 0;
 const hub = setup(async (_, __, fn) => { controller.abort(reason); return fn('synthetic'); }, async () => { dispatches++; });
 await assert.rejects(hub.request('operator', 'a', 'messages', {}, controller.signal), error => error === reason);
 assert.equal(dispatches, 0);
});
test('live and absent signals preserve request result and signal identity', async () => {
 const controller = new AbortController(); const seen = [];
 const hub = setup(async (_, __, fn) => fn('synthetic'), async input => { seen.push(input.signal); return { accepted: true }; });
 assert.deepEqual(await hub.request('operator', 'a', 'messages', {}, controller.signal), { accepted: true });
 assert.deepEqual(await hub.request('operator', 'a', 'messages', {}), { accepted: true });
 assert.deepEqual(seen, [controller.signal, undefined]);
});
