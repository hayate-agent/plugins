import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Identity} from '../service.mjs';
const password={algorithm:'scrypt-v1',salt:'a'.repeat(64),hash:'b'.repeat(128)};
const token='a'.repeat(43);const hash=createHash('sha256').update(token).digest('hex');
const row={hash,principal:'operator',audience:'https://a.invalid',expiresAt:10000};
const create=sessions=>new Identity({username:'test',password,now:()=>1000,sessions});
test('duplicate persisted hashes are rejected independently of row order or expiry',()=>{
 const other={...row,audience:'https://b.invalid'};
 for(const sessions of [[row,other],[other,row],[row,{...row}],[{...row,expiresAt:0},row]])assert.throws(()=>create(sessions),/Duplicate persisted session/);
});
test('distinct session hashes restore without losing audience binding or expiry filtering',()=>{
 const otherToken='b'.repeat(43);const otherHash=createHash('sha256').update(otherToken).digest('hex');
 const identity=create([row,{...row,hash:otherHash,audience:'https://b.invalid'}]);
 assert.ok(identity.authenticate(token,'https://a.invalid'));assert.equal(identity.authenticate(token,'https://b.invalid'),null);
 assert.ok(identity.authenticate(otherToken,'https://b.invalid'));
 const expired=create([{...row,expiresAt:0}]);assert.equal(expired.authenticate(token,'https://a.invalid'),null);
});
