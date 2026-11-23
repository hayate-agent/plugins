import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentHub} from '../service.mjs';

test('registration retains validated adapter response across credential persistence', async t => {
 const home=await mkdtemp(path.join(os.tmpdir(),'hub-pair-snapshot-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const response={agent:'Original',token:'synthetic-token',capabilities:['projects'],endpoint:'https://original.invalid/'};
 let persisted;
 const hub=new AgentHub({home,credentials:{async put(owner,input){persisted=input.value;response.agent='Changed';response.capabilities.push('messages');response.endpoint='https://changed.invalid/';return {id:'fixture'};},async withSecret(){},async remove(){}}});
 t.after(()=>hub.stop());await hub.open();hub.registerAdapter('fixture',{async pair(){return response;},async request(){return {};}});
 const agent=await hub.connect('owner',{adapter:'fixture',endpoint:'https://original.invalid/',code:'fixture',name:'Target'});
 assert.equal(agent.remoteAgent,'Original');assert.deepEqual(agent.capabilities,['projects']);assert.equal(agent.endpoint,'https://original.invalid/');assert.equal(persisted,'synthetic-token');
 assert.equal(response.agent,'Changed');assert.deepEqual(response.capabilities,['projects','messages']);
});
