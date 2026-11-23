import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../shared/store.mjs';

test('published store values match JSON persistence and restarted reads', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'store-json-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'state.json');
  const store = new Store(file, { version: 1, items: [] }); t.after(() => store.stop());
  let observed;
  store.subscribe(() => { observed = store.read(); });
  await store.change(data => { data.items.push({ absent: undefined, number: NaN, date: new Date('2026-01-01T00:00:00Z') }); });
  const disk = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(store.read(), disk); assert.deepEqual(observed, disk);
  const restarted = new Store(file, { version: 1, items: [] }); await restarted.load(); t.after(() => restarted.stop());
  assert.deepEqual(store.read(), restarted.read());
  const before = await readFile(file, 'utf8');
  await assert.rejects(store.change(data => { data.items.push(1n); }), /BigInt/);
  assert.equal(await readFile(file, 'utf8'), before); assert.deepEqual(store.read(), disk);
  await assert.rejects(store.change(data => { data.loop = data; }), /circular/i);
  assert.equal(await readFile(file, 'utf8'), before); assert.deepEqual(store.read(), disk);
});
