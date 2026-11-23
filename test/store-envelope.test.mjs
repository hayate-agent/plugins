import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../shared/store.mjs';

test('invalid serialized envelopes preserve committed state, file and notifications', async t => {
 const home=await mkdtemp(path.join(os.tmpdir(),'store-envelope-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const file=path.join(home,'state.json');const store=new Store(file,{version:1,items:[]});t.after(()=>store.stop());
 await store.change(d=>{d.items.push('valid');});const before=await readFile(file,'utf8');const state=store.read();let notifications=0;store.subscribe(()=>{notifications++;});
 for(const mutate of [d=>{d.version=2;},d=>{delete d.items;},d=>{d.items={};},d=>{d.items=null;},d=>{d.items=undefined;}]){
  await assert.rejects(store.change(mutate),/Invalid or unsupported/);
  assert.equal(await readFile(file,'utf8'),before);assert.deepEqual(store.read(),state);
 }
 assert.equal(notifications,0);
 const restarted=new Store(file,{version:1,items:[]});await restarted.load();assert.deepEqual(restarted.read(),state);await restarted.stop();
 await store.change(d=>{d.extra={allowed:true};d.items.push('next');});assert.equal(notifications,1);
 await store.load();assert.equal(store.read().extra.allowed,true);
 await store.change(d=>{delete d.extra;});await store.load();assert.equal(Object.hasOwn(store.read(),'extra'),false);
});
