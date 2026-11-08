import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import plugin from '../index.mjs';
import { LocalVault } from '../../credentials/vault.mjs';

test('target slash command returns endpoint and expiring code for specified WebUI, never embeds code in URL', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pair-command-')); const vault = new LocalVault(home); await vault.open();
  let command; const stops = [], services = new Map([['credentials', { version: 1, implementation: vault }], ['agent-link', { version: 1, implementation: { origin: 'https://agent.example' } }]]);
  t.after(async () => { for (const stop of stops.reverse()) await stop(); await vault.stop(); await rm(home, { recursive: true, force: true }); });
  await plugin.activate({ home, agent: 'Target', foregroundWork: work => work(), services: { get: name => services.get(name) }, onStop: fn => stops.push(fn), registerService: (name, version, implementation) => services.set(name, { version, implementation }), registerCommand: value => { command = value; } });
  const result = JSON.parse(await command.run('pair https://hayate.example'));
  assert.equal(result.webui, 'https://hayate.example'); assert.equal(result.endpoint, 'https://agent.example'); assert.ok(result.code); assert.ok(result.expiresAt > Date.now());
  assert.equal(new URL(result.webui).search, ''); assert.equal(new URL(result.endpoint).search, '');
  await assert.rejects(command.run('pair http://untrusted.example'), /HTTPS/);
  services.delete('agent-link'); await assert.rejects(command.run('pair https://hayate.example'), /not enabled/);
});
