import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, copyFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';

// Bundled adapters resolve Core contracts beside their materialized source.
const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-retention-'));
await copyFile(new URL('../src/memory-service.ts', import.meta.url), path.join(dir, 'memory-service.ts'));
await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
await writeFile(path.join(dir, 'durable.js'), 'export async function writeFileDurable() { throw Error("Unexpected disk write in provider-only test"); }');
const { MemoryService } = await import(pathToFileURL(path.join(dir, 'memory-service.ts')).href);
after(() => rm(dir, { recursive: true, force: true }));

const config = { enabled: true, autoCapture: true, autoRecall: true, recallLimit: 3 };
test('old automatic captures remain recallable and reported, without automatic expiry', async () => {
  const writes = [];
  const service = new MemoryService(config, () => {});
  service.provider = { async put(context, entry) { writes.push({ context, entry }); return { ...entry, id: entry.key, sessionKey: context.sessionKey, createdAt: new Date().toISOString() }; } };
  const recordedAt = Date.now() - 90 * 86400000;
  await service.capture({ sessionKey: 'one', id: 'old', text: 'Investigate failure', reply: 'Unverified diagnosis', outcome: 'failed', recordedAt });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].context.sessionKey, 'one');
  assert.equal('expiresAt' in writes[0].entry, false);
  assert.equal(writes[0].entry.reviewAfter, new Date(recordedAt + 7 * 86400000).toISOString());
  assert.match(writes[0].entry.text, /not verification/);
});

test('capture retry remains byte-identical and meaningful successful no-tool turns are retained', async () => {
  const writes = [];
  const service = new MemoryService(config, () => {});
  service.provider = { async put(context, entry) { writes.push(entry); return { ...entry, id: entry.key, sessionKey: context.sessionKey, createdAt: new Date().toISOString() }; } };
  const turn = { sessionKey: 'one', id: 'stable', text: 'Check', reply: 'Result', outcome: 'completed', tools: ['read'], recordedAt: 1000 };
  await service.capture(turn);
  await service.capture(turn);
  assert.deepEqual(writes[0], writes[1]);
  await service.capture({ ...turn, tools: [] });
  // A meaningful completed turn is a handoff even without tool metadata.
  const { tools, ...withoutTools } = turn;
  const before = writes.length;
  await service.capture(withoutTools);
  assert.equal(writes.length, before + 1);
  assert.deepEqual(writes[before], writes[0]);
});

test('missing host timestamp never changes payload under the same stable idempotency key', async () => {
 const writes=[];const service=new MemoryService(config,()=>{});service.provider={async put(ctx,entry){writes.push(entry);return {...entry,id:entry.key,sessionKey:ctx.sessionKey,state:'active',verification:'reported'};}};
 const turn={sessionKey:'one',id:'retry-no-time',text:'Remember the deployment constraint',reply:'Do not activate without approval',outcome:'completed',tools:0};
 await service.capture(turn);await new Promise(resolve=>setTimeout(resolve,5));await service.capture(turn);
 assert.deepEqual(writes[0],writes[1]);assert.equal(writes[0].reviewAfter,new Date(0).toISOString());
 await service.capture({...turn,recordedAt:1000});await service.capture({...turn,text:'Changed scope'});await service.capture({...turn,outcome:'failed'});
 assert.equal(new Set([writes[0].key,...writes.slice(2).map(row=>row.key)]).size,4);
});

test('only empty/greeting/transport-no-knowledge turns are excluded, including legacy empty tool arrays', async () => {
 const writes=[];const service=new MemoryService(config,()=>{});service.provider={async put(ctx,entry){writes.push(entry);return {...entry,id:entry.key,sessionKey:ctx.sessionKey,state:'active',verification:'reported'};}};
 for(const tools of [undefined,0,[]]){
  await service.capture({sessionKey:'one',text:'Hallo',reply:'Hallo!',outcome:'completed',tools});
  await service.capture({sessionKey:'one',text:'Check',reply:'⚠️ Request timed out.',outcome:'failed',tools});
 }
 assert.equal(writes.length,0);await service.capture({sessionKey:'one',text:'Preference',reply:'Use German for reports',outcome:'completed',tools:0});assert.equal(writes.length,1);
 await service.capture({sessionKey:'one',text:'Migration',reply:'Error: migration partially applied; do not rerun',outcome:'failed',tools:0});
 assert.equal(writes.length,2);assert.match(writes[1].text,/partially applied; do not rerun/);
});
