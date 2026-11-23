import test from 'node:test';
import assert from 'node:assert/strict';
import { Identity, passwordRecord } from '../service.mjs';

test('construction captures validated password scalars independently of the caller record', async () => {
  const password = await passwordRecord('synthetic-original-password');
  const identity = new Identity({username:'operator',password});
  Object.assign(password, await passwordRecord('synthetic-replacement-password'));
  try {
    const original = await identity.login('operator','synthetic-original-password',{audience:'https://example.test',client:'original'});
    assert.equal(identity.authenticate(original.token,'https://example.test').principal,'operator');
    await assert.rejects(identity.login('operator','synthetic-replacement-password',{audience:'https://example.test',client:'replacement'}), {status:401});
    delete password.salt; delete password.hash;
    assert.equal((await identity.login('operator','synthetic-original-password',{audience:'https://example.test',client:'deleted'})).principal,'operator');
  } finally { identity.stop(); }
});
