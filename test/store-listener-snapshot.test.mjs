import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../shared/store.mjs';

test('new listeners wait for the next commit and removed listeners stay removed',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'store-listeners-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const store=new Store(path.join(home,'state.json'),{version:1,count:0});t.after(()=>store.stop());
 const calls=[];let installed=false,remove;
 store.subscribe(()=>{calls.push('first');if(!installed){installed=true;store.subscribe(()=>calls.push('late'));}remove();});
 remove=store.subscribe(()=>calls.push('removed'));
 store.subscribe(()=>{throw Error('observer');});
 await store.change(d=>{d.count++;});assert.deepEqual(calls,['first']);assert.equal(store.read().count,1);
 calls.length=0;await store.change(d=>{d.count++;});assert.deepEqual(calls,['first','late']);assert.equal(store.read().count,2);
});
