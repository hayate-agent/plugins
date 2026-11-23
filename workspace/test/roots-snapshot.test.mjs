import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {Files} from '../files.mjs';
test('workspace picker captures caller roots before startup',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'files-roots-'));
 try{const a=path.join(home,'a'),b=path.join(home,'b');await mkdir(a);await mkdir(b);const input=[a,a];const files=new Files(input);input.splice(0,2,b);await files.start();assert.deepEqual(files.roots(),[await realpath(a)]);await assert.rejects(files.resolve(b),/outside operator-configured/);const returned=files.roots();returned[0]=b;assert.equal(await files.resolve(a),await realpath(a));}finally{await rm(home,{recursive:true,force:true});}
});
test('workspace root configuration still rejects invalid shapes',async()=>{for(const value of [undefined,null,{},'relative',[],['relative'],[12]])await assert.rejects(new Files(value).start(),/Configure absolute workspace roots/);});
