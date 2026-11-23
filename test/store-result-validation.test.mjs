import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../shared/store.mjs';

test('uncloneable mutator result rejects before publication and queue remains usable',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'store-result-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const file=path.join(home,'state.json'),store=new Store(file,{version:1,count:0});t.after(()=>store.stop());
 let notices=0;store.subscribe(()=>notices++);await store.change(d=>{d.count=1;});
 const before=await readFile(file,'utf8');notices=0;
 for(const invalid of [()=>{},Symbol('invalid')]){
  await assert.rejects(store.change(d=>{d.count=2;return invalid;}),{name:'DataCloneError'});
  assert.equal(store.read().count,1);assert.equal(await readFile(file,'utf8'),before);assert.equal(notices,0);
 }
 const donated={ok:true};const result=await store.change(d=>{d.count++;return donated;});
 donated.ok=false;assert.deepEqual(result,{ok:true});assert.equal(store.read().count,2);assert.equal(notices,1);
 const reload=new Store(file,{version:1,count:0});await reload.load();assert.deepEqual(reload.read(),store.read());
});
