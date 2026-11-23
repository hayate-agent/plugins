import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plugin from '../index.mjs';

test('admin orgs command exposes existing pagination and rejects invalid pages',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'catalog-page-'));t.after(()=>rm(home,{recursive:true,force:true}));
 await writeFile(path.join(home,'git-catalog.json'),JSON.stringify({providers:[{id:'fixture',kind:'forgejo',origin:'https://git.invalid'}]}));
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const pages=[];let command,stop;
 globalThis.fetch=async url=>{pages.push(new URL(url).searchParams.get('page'));return {ok:true,json:async()=>[]};};
 await plugin.activate({home,foregroundWork:async fn=>fn(),services:new Map(),onStop(fn){stop=fn;},registerService(){},registerCommand(value){command=value;}});t.after(()=>stop());
 assert.equal(command.admin,true);assert.match(command.help,/orgs <provider> \[page\]/);
 await command.run('orgs fixture 2');await command.run('orgs fixture');assert.deepEqual(pages,['2','1']);
 for(const page of ['0','-1','1.5','bad','Infinity','9007199254740992'])await assert.rejects(command.run(`orgs fixture ${page}`),/Invalid page/);
 assert.deepEqual(pages,['2','1']);
 await command.run('repos fixture team');assert.equal(pages.at(-1),'1');
});
