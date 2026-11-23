import test from 'node:test';import assert from 'node:assert/strict';import {createEventLog,createTextCoalescer,MAX_EVENT_BYTES} from '../event-log.mjs';
for(const [name,text] of [['CJK','界'.repeat(32000)],['emoji','😀'.repeat(16000)],['ASCII','a'.repeat(64000)],['escaped','\n'.repeat(32000)],['mixed',('界😀a\n').repeat(8000)]])test(`coalescer preserves ${name} text within UTF-8 frame budget`,()=>{
 const log=createEventLog({epoch:'test'}),head=log.head('s'),coalescer=createTextCoalescer(log,{maxChars:32000});
 try{coalescer.text('s',text);coalescer.flush('s');const result=log.since('s',0,{epoch:head.epoch});assert.equal(result.events.map(e=>e.data.delta).join(''),text);for(const event of result.events){assert.ok(Buffer.byteLength(JSON.stringify(event))<=MAX_EVENT_BYTES);assert.ok(event.data.delta.isWellFormed());}}finally{coalescer.stop();}
});
