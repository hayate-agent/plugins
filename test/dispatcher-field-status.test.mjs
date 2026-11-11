import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatcherPlugin } from '../src/dispatcher-plugin.ts';

for (const status of ['running', 'paused', 'blocked', 'completed', 'cancelled']) {
  test(`field lookup exposes actual ${status} state even with an empty result`, async () => {
    const row = { id: 'worker', requestId: 'request', status, checkpoint: 'retained checkpoint',
      ...(status === 'paused' ? { diagnosticCode: 'runtime-failure' } : {}), restarts: 0 };
    let tool;
    dispatcherPlugin(() => ({ store: { list: () => [row] } })).activate({ registerTool: t => tool = t, registerCommand() {} });
    const result = JSON.parse(await tool.execute({ action: 'status', id: 'worker', field: 'result' }, { sessionKey: 'parent' }));
    assert.equal(result.status, status);
    assert.equal(result.resultAvailable, false);
    assert.equal(result.checkpointAvailable, true);
    assert.equal(result.totalChars, 0);
    assert.equal(result.text, '');
    if (status === 'paused') assert.match(result.diagnostic, /Strategy execution failed/);
  });
}
test('bounded field reads retain state without leaking raw failure prose or other fields', async () => {
  let tool;
  const row = { id: 'worker', requestId: 'request', status: 'blocked', recoveryReason: 'secret exception details',
    input: 'private unrelated input', checkpoint: 'private unrelated checkpoint', result: 'x'.repeat(9000) };
  dispatcherPlugin(() => ({ store: { list: () => [row] } })).activate({ registerTool: t => tool = t, registerCommand() {} });
  const raw = await tool.execute({ action: 'status', id: 'worker', field: 'result', charOffset: 8000 }, { sessionKey: 'parent' });
  const result = JSON.parse(raw);
  assert.equal(result.text.length, 1000); assert.equal(result.totalChars, 9000); assert.equal(result.nextCharOffset, null);
  assert.equal(result.resultAvailable, true); assert.equal(result.status, 'blocked');
  assert.doesNotMatch(raw, /secret exception|private unrelated/);
});
