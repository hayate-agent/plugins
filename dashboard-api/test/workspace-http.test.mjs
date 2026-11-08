import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebUIChannel } from '../index.mjs';

test('optional backend capabilities fail explicitly and workspace routes retain same-origin protections', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'workspace-http-'));
  const channel = new WebUIChannel({ home, port: 0 }); await channel.start(async () => {});
  t.after(async () => { await channel.stop(); await rm(home, { recursive: true, force: true }); });
  const capabilities = await (await fetch(channel.url + '/api/workspace/capabilities')).json();
  assert.equal(capabilities.workspaces, null);
  const unavailable = await fetch(channel.url + '/api/workspace/state'); assert.equal(unavailable.status, 409);
  assert.match((await unavailable.json()).error, /Install backend plugin/);
  const forbidden = await fetch(channel.url + '/api/workspace/projects', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json', 'X-Hayate-WebUI': '1' }, body: '{}' });
  assert.equal(forbidden.status, 403);
});

test('credential HTTP projection submits write-only values with server principal and exposes no secret read route', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'workspace-http-')); const writes = [];
  const vault = { list: owner => [{ id: 'id', label: 'Git', owner }], async put(owner, input) { writes.push({ owner, input }); return { id: 'id', label: input.label }; }, async remove() {} };
  const channel = new WebUIChannel({ home, port: 0, services: { get: name => name === 'credentials' ? { version: 1, implementation: vault } : undefined } });
  await channel.start(async () => {});
  t.after(async () => { await channel.stop(); await rm(home, { recursive: true, force: true }); });
  const response = await fetch(channel.url + '/api/workspace/credentials', { method: 'POST', headers: { Origin: channel.url, 'X-Hayate-WebUI': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: 'forged', label: 'Git', value: 'PRIVATE_TOKEN' }) });
  assert.equal(response.status, 201); assert.doesNotMatch(await response.text(), /PRIVATE_TOKEN/);
  assert.equal(writes[0].owner, 'operator'); assert.equal(writes[0].input.value, 'PRIVATE_TOKEN');
  const listing = await fetch(channel.url + '/api/workspace/credentials'); assert.doesNotMatch(await listing.text(), /PRIVATE_TOKEN/);
  assert.equal((await fetch(channel.url + '/api/workspace/credentials/id')).status, 404);
});
