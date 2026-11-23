import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {AgentHub} from '../service.mjs';
test('pairing code captures validated scope before persistence queues',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'hub-scope-'));
 try{
  const hub=new AgentHub({home,credentials:{withSecret(){},put(){}}});await hub.open();
  const capabilities=['projects','projects'];const pending=hub.issueCode('operator',{name:'peer',capabilities});
  capabilities.splice(0,2,'messages');const issued=await pending;
  assert.deepEqual(issued.capabilities,['projects']);
  issued.capabilities.push('activity');capabilities.push('invalid');
  assert.deepEqual((await hub.consumeCode(issued.code)).capabilities,['projects']);
  await assert.rejects(hub.consumeCode(issued.code),/Invalid or expired/);
  await assert.rejects(hub.issueCode('operator',{name:'peer',capabilities:['invalid']}),/Invalid pairing scope/);
 }finally{await rm(home,{recursive:true,force:true});}
});
