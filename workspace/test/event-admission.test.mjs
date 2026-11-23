import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventLog } from '../event-log.mjs';

test('rejected events preserve retained streams, epochs and repair history', () => {
  for (const circular of [false,true]) {
    const log=createEventLog({maxSessions:1,epoch:'probe'});
    const first=log.append('a','delta',{text:'saved'});
    const invalid=circular?{}:{text:'x'.repeat(65536)};if(circular)invalid.self=invalid;
    assert.throws(()=>log.append('b','delta',invalid));
    assert.equal(log.tracked('a'),true);assert.equal(log.tracked('b'),false);
    assert.deepEqual(log.since('a',0,{epoch:first.epoch}).events,[first]);
    const second=log.append('a','delta',{text:'second'});assert.equal(second.seq,2);assert.equal(second.epoch,first.epoch);
    const other=log.append('b','delta',{});assert.equal(other.epoch,'probe.2');assert.equal(other.seq,1);
    assert.equal(log.tracked('a'),false);assert.equal(log.tracked('b'),true);
  }
});

test('rejected event does not refresh an existing stream LRU position',()=>{
 const log=createEventLog({maxSessions:2,epoch:'probe'});log.append('a','delta');log.append('b','delta');
 assert.throws(()=>log.append('a','delta',{text:'x'.repeat(65536)}));log.append('c','delta');
 assert.equal(log.tracked('a'),false);assert.equal(log.tracked('b'),true);
});
