import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, chmod, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalVault, OpenBaoVault } from '../vault.mjs';

test('local vault encrypts values, binds AEAD to owner/id and returns metadata only', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-'));
  const vault = new LocalVault(home); await vault.open();
  t.after(async () => { await vault.stop(); await rm(home, { recursive: true, force: true }); });
  const receipt = await vault.put('operator', { label: 'Git', kind: 'git', value: 'TOP_SECRET_TOKEN' });
  assert.doesNotMatch(JSON.stringify(receipt), /TOP_SECRET_TOKEN|sealed/);
  assert.doesNotMatch(await readFile(path.join(home, 'credentials/vault.json'), 'utf8'), /TOP_SECRET_TOKEN/);
  assert.equal(await vault.withSecret('operator', receipt.id, value => value), 'TOP_SECRET_TOKEN');
  await assert.rejects(vault.withSecret('other', receipt.id, value => value), /not found/);
  assert.equal(vault.list('other').length, 0);
  await vault.remove('operator', receipt.id); assert.equal(vault.list('operator').length, 0);
});
test('unsafe key mode fails closed instead of silently accepting exposed key material', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-')); t.after(() => rm(home, { recursive: true, force: true }));
  const first = new LocalVault(home); await first.open(); await first.stop();
  await chmod(path.join(home, 'credentials/key'), 0o644);
  await assert.rejects(new LocalVault(home).open(), /private regular file/);
});
test('OpenBao transport is explicit HTTPS, scope-limited, redirects refused and token is never returned', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bao-')); t.after(() => rm(home, { recursive: true, force: true }));
  const tokenFile = path.join(home, 'token'); await writeFile(tokenFile, 'BAO_TOKEN', { mode: 0o600 });
  const calls = [];
  const vault = new OpenBaoVault({ address: 'https://bao.example', mount: 'kv', prefix: 'agents', tokenFile,
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ data: { data: { value: 'SECRET' } } }) }; } });
  const result = await vault.put('operator', { label: 'Key', value: 'SECRET' });
  assert.doesNotMatch(JSON.stringify(result), /SECRET|BAO_TOKEN/);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['X-Vault-Token'], 'BAO_TOKEN');
  assert.equal(await vault.withSecret('operator', result.id, value => value), 'SECRET');
  assert.throws(() => new OpenBaoVault({ address: 'http://bao.example', mount: 'kv', prefix: 'agents', tokenFile }), /HTTPS/);
  await assert.rejects(vault.withSecret('../escape', result.id, () => {}), /scope/);
});
