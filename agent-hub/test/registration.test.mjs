import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AgentHub } from '../service.mjs';
import { LocalVault } from '../../credentials/vault.mjs';
async function setup(t, adapter = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'registration-')); const vault = new LocalVault(home); await vault.open();
  const hub = new AgentHub({ home, credentials: vault }); await hub.open();
  const actions = [];
  hub.registerAdapter('fixture', { async pair() { return { agent: 'Target', token: 'PRIVATE_TOKEN', capabilities: ['projects', 'streams', 'messages', 'activity'] }; },
    async request({ input, capability }) { actions.push({ input, capability }); return { streams: [] }; }, async revoke() {}, ...adapter });
  const input = { adapter: 'fixture', endpoint: 'https://target.example', code: 'ONE_USE_CODE', name: 'Friendly target', color: '#123456' };
  t.after(async () => { await hub.stop(); await vault.stop(); await rm(home, { recursive: true, force: true }); });
  return { hub, vault, input, actions, home };
}

test('concurrent/duplicate registration is rejected before consuming another code', async t => {
  let paired = 0, release; const gate = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { async pair() { paired++; await gate; return { agent: 'Target', token: 'token', capabilities: [] }; } });
  const first = f.hub.connect('operator', f.input);
  await assert.rejects(f.hub.connect('operator', { ...f.input, endpoint: f.input.endpoint + '/' }), /already registered/);
  release(); await first;
  await assert.rejects(f.hub.connect('operator', f.input), /already registered/);
  assert.equal(paired, 1); assert.equal(f.hub.list('operator').length, 1);
});

test('read-only connection check records sanitized evidence; names/colors are owner scoped', async t => {
  const f = await setup(t); const agent = await f.hub.connect('operator', f.input);
  const result = await f.hub.check('operator', agent.id); assert.equal(result.status, 'connected');
  assert.deepEqual(f.actions, [{ capability: 'activity', input: { action: 'list' } }]);
  await f.hub.update('operator', agent.id, { name: 'Renamed', color: null });
  assert.equal(f.hub.list('operator')[0].name, 'Renamed'); assert.equal(f.hub.list('operator')[0].color, undefined);
  await assert.rejects(f.hub.update('other', agent.id, { name: 'Stolen' }), /not found/);
  await assert.rejects(f.hub.check('other', agent.id), /not found/);
  await assert.rejects(f.hub.update('operator', agent.id, { endpoint: 'https://evil.example' }), /presentation/);
  assert.doesNotMatch(JSON.stringify(f.hub.list('operator')), /PRIVATE_TOKEN|ONE_USE_CODE|credential/);
  const second = new AgentHub({ home: f.home, credentials: f.vault }); await second.open();
  assert.equal(second.list('operator')[0].connection.status, 'connected'); await second.stop();
});

test('unavailable probe does not expose secret-bearing diagnostics or claim productive work', async t => {
  const f = await setup(t, { async request() { throw Error('PRIVATE_TOKEN provider trace'); } }); const agent = await f.hub.connect('operator', f.input);
  const result = await f.hub.check('operator', agent.id); assert.equal(result.status, 'unavailable'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN/);
});

test('adapter without revocation cannot silently delete local authorization record', async t => {
  const f = await setup(t, { revoke: undefined }); const agent = await f.hub.connect('operator', f.input);
  await assert.rejects(f.hub.remove('operator', agent.id), /cannot revoke/);
  assert.equal(f.hub.list('operator').length, 1); assert.equal(f.vault.list('operator').length, 1);
});

test('revoking fences new requests, retains data on failure and supports explicit retry', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let attempts = 0;
  const f = await setup(t, { async revoke() { if (++attempts === 1) { await gate; throw Error('Offline'); } } });
  const agent = await f.hub.connect('operator', f.input); const removal = f.hub.remove('operator', agent.id);
  await assert.rejects(f.hub.request('operator', agent.id, 'messages', { action: 'send' }), /removal/);
  release(); await assert.rejects(removal, /Offline/); assert.equal(f.hub.list('operator').length, 1);
  await f.hub.remove('operator', agent.id); assert.equal(f.hub.list('operator').length, 0); assert.equal(f.vault.list('operator').length, 0);
});

test('failed local persistence rolls back newly created target authorization and credential', async t => {
  let revoked = false; const f = await setup(t, { async revoke({ token }) { assert.equal(token, 'PRIVATE_TOKEN'); revoked = true; } });
  f.hub.store.change = async () => { throw Error('disk failed'); };
  await assert.rejects(f.hub.connect('operator', f.input), /disk failed/);
  assert.equal(revoked, true); assert.equal(f.vault.list('operator').length, 0);
});
