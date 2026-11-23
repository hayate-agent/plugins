import test from 'node:test';
import assert from 'node:assert/strict';
import { GitCatalog } from '../service.mjs';

async function directories(checkouts) {
  const catalog = new GitCatalog({ providers: [{id:'forge',kind:'forgejo',origin:'https://git.example',checkouts}],
    fetch: async () => ({ok:true,json:async()=>['toString','constructor','__proto__','org/repo'].map((full_name,id)=>({id,full_name}))}) });
  return (await catalog.repositories('operator','forge')).entries.map(e=>e.directory);
}
test('only explicit own checkout mappings produce directories', async () => {
  assert.deepEqual(await directories({'org/repo':'/srv/repo'}), [null,null,null,'/srv/repo']);
  assert.deepEqual(await directories(), [null,null,null,null]);
  assert.deepEqual(await directories(Object.create({'org/repo':'/srv/inherited'})), [null,null,null,null]);
});
test('own reserved-name and null-prototype mappings remain supported', async () => {
  const mappings = Object.assign(Object.create(null), {toString:'/srv/string',constructor:'/srv/constructor','org/repo':'/srv/repo'});
  mappings.__proto__ = '/srv/proto';
  assert.deepEqual(await directories(mappings), ['/srv/string','/srv/constructor','/srv/proto','/srv/repo']);
  assert.deepEqual(await directories(JSON.parse('{"__proto__":"/srv/proto"}')), [null,null,'/srv/proto',null]);
});
