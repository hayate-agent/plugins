import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentHub } from '../service.mjs';
import { LocalVault } from '../../credentials/vault.mjs';

async function setup(t, lifetime = 300000) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'hub-')); const vault = new LocalVault(home); await vault.open();
  const hub = new AgentHub({ home, credentials: vault, pairingLifetimeMs: lifetime }); await hub.open();
  t.after(async () => { await hub.stop(); await vault.stop(); await rm(home, { recursive: true, force: true }); });
  return { hub, home, vault };
}
test('pair codes are stored hashed and consumed exactly once, including concurrent claims', async t => {
  const { hub, home } = await setup(t);
  const issued = await hub.issueCode('operator', { name: 'Target', capabilities: ['messages', 'projects'] });
  assert.doesNotMatch(await readFile(path.join(home, 'agent-hub/state.json'), 'utf8'), new RegExp(issued.code));
  const outcomes = await Promise.allSettled([hub.consumeCode(issued.code), hub.consumeCode(issued.code)]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(o => o.status === 'fulfilled').value.owner, 'operator');
  await assert.rejects(hub.consumeCode(issued.code), /expired/);
});
test('failed target revocation retains registration and credential for explicit reconciliation', async t => {
  const { hub, vault } = await setup(t);
  hub.registerAdapter('offline', {
    async pair() { return { agent: 'target', token: 'peer-token', capabilities: ['messages'] }; },
    async request() {}, async revoke() { throw Error('Target unreachable'); },
  });
  const agent = await hub.connect('operator', { adapter: 'offline', endpoint: 'fixture://target', code: 'temporary', name: 'Offline target' });
  await assert.rejects(hub.remove('operator', agent.id), /unreachable/);
  assert.equal(hub.list('operator').length, 1); assert.equal(vault.list('operator').length, 1);
});

test('dashboard isolates missing mappings and unavailable agents without productive requests', async t => {
  const { hub } = await setup(t); const actions = [];
  hub.registerAdapter('mapped', {
    async pair() { return { agent: 'mapped', token: 'token', capabilities: ['projects', 'streams'] }; },
    async request({ capability, input }) { actions.push(input.action); if (capability === 'projects') return { projectId: input.projectId === 'shared' ? 'target-project' : null }; return { streams: [{ id: 'stream', projectId: 'target-project', unread: true }] }; },
  });
  hub.registerAdapter('offline', { async pair() { return { agent: 'offline', token: 'token', capabilities: ['projects', 'streams'] }; }, async request() { throw Error('Disconnected'); } });
  await hub.connect('operator', { adapter: 'mapped', endpoint: 'fixture://mapped', code: 'code', name: 'Mapped' });
  await hub.connect('operator', { adapter: 'offline', endpoint: 'fixture://offline', code: 'code', name: 'Offline' });
  const result = await hub.projectDashboard('operator', 'shared');
  assert.deepEqual(result.agents.map(agent => agent.status), ['connected', 'unavailable']);
  assert.equal(result.agents[0].streams[0].unread, true);
  assert.equal((await hub.projectDashboard('operator', 'private')).agents[0].status, 'not-shared');
  assert.equal((await hub.projectDashboard('other', 'shared')).agents.length, 0);
  assert.ok(actions.every(action => ['resolve', 'list'].includes(action)));
});

test('agent adapter capabilities, private peer tokens and explicit fan-out failure receipts', async t => {
  const { hub, home } = await setup(t); let requests = 0;
  hub.registerAdapter('fixture', {
    async pair() { return { agent: 'external-test-agent', token: 'PRIVATE_PEER_TOKEN', capabilities: ['projects', 'messages'] }; },
    async request(context) { requests++; assert.equal(context.token, 'PRIVATE_PEER_TOKEN'); return { accepted: true, capability: context.capability }; },
    async revoke() {},
  });
  const agent = await hub.connect('operator', { adapter: 'fixture', endpoint: 'fixture://target', code: 'fixture-code', name: 'Agent', color: '#337799' });
  assert.doesNotMatch(JSON.stringify(agent), /PRIVATE_PEER_TOKEN|credential/);
  assert.doesNotMatch(await readFile(path.join(home, 'agent-hub/state.json'), 'utf8'), /PRIVATE_PEER_TOKEN/);
  assert.equal(hub.list('other').length, 0);
  assert.equal((await hub.request('operator', agent.id, 'messages', {})).accepted, true);
  await assert.rejects(hub.request('operator', agent.id, 'unknown', {}), /unavailable/);
  assert.equal((await hub.syncProject('operator', { title: 'Shared' }))[0].ok, true);
  assert.equal(requests, 2);
  await hub.remove('operator', agent.id);
  await assert.rejects(hub.request('operator', agent.id, 'messages', {}), /unavailable/);
});
