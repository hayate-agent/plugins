import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../shared/store.mjs';

test('committed store state is independent of retained mutator drafts and donated objects', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'store-snapshot-'));
  t.after(() => rm(home, {recursive:true,force:true}));
  const file = path.join(home, 'state.json'), initial = {version:1,items:[]};
  const store = new Store(file, initial);t.after(() => store.stop());
  let retained, notices = 0;const donated = {value:'committed'};
  store.subscribe(() => {notices++;});store.subscribe(() => {throw Error('observer');});
  const result = await store.change(d => {retained=d;d.items.push(donated);return donated;});
  donated.value='changed';retained.items.push({value:'uncommitted'});result.value='result changed';
  const expected={version:1,items:[{value:'committed'}]};
  assert.deepEqual(store.read(),expected);
  const loaded=new Store(file,initial);await loaded.load();assert.deepEqual(loaded.read(),expected);
  await assert.rejects(store.change(d=>{d.items=[];throw Error('rejected');}),/rejected/);
  await Promise.all([store.change(d=>{d.items.push({value:'second'});}),store.change(d=>{d.items.push({value:'third'});})]);
  assert.equal(notices,3);
  assert.deepEqual(store.read().items.map(x=>x.value),['committed','second','third']);
  const latest=new Store(file,initial);await latest.load();assert.deepEqual(latest.read(),store.read());
  await store.stop();await assert.rejects(store.change(()=>{}),/stopping/);
});
