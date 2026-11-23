import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenBaoVault } from '../vault.mjs';

test('OpenBao put captures validated values and metadata before awaited token read', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bao-snapshot-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const tokenFile = path.join(home, 'token'); await writeFile(tokenFile, 'synthetic-fixture');
  let body, release, entered;
  const began = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const vault = new OpenBaoVault({ address: 'https://bao.invalid', mount: 'kv', prefix: 'test', tokenFile,
    fetch: async (url, options) => { body = JSON.parse(options.body).data; entered(); await hold; return { ok: true }; } });
  const input = { id: 'test', label: 'original', value: 'synthetic-original', kind: 'token', extra: { note: 'original' } };
  const expected = structuredClone(input);
  const pending = vault.put('owner', input);
  input.label = 'changed'; input.value = 'synthetic-changed'; input.extra.note = 'changed';
  await began;
  assert.deepEqual(body, expected);
  input.kind = 'password'; release();
  assert.deepEqual(await pending, { id: 'test', label: 'original', kind: 'token' });
  assert.equal(input.label, 'changed'); assert.equal(input.kind, 'password');
});
