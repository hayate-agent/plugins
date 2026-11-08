import test from 'node:test';
import assert from 'node:assert/strict';
import {completionPrompt} from '../src/completion-prompt.ts';
test('resolved transcript does not discard retained recovery evidence',()=>{
 const retained={original:'ORIGINAL',savedNext:'UNTRUSTED_NEXT',priorReply:'PRIOR_REPLY',technical:{diagnostic:'technical',attempts:2,nextAt:61000}};
 const prompt=completionPrompt({text:'ORIGINAL',completionContext:{resolved:{transcript:{current:'available'}},retained}},'PRIOR_REPLY',{task:'ORIGINAL'},()=>1000);
 const data=JSON.parse(prompt.split('\nDATA: ')[1]);
 assert.deepEqual(data.context.retained,retained);
 assert.match(prompt,/Independently reassess all four/);assert.match(prompt,/not a semantic blocker/);
 assert.match(prompt,/preserve real approval, stop and expiry holds/);
});
