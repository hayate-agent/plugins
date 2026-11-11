import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatcherPlugin } from '../src/dispatcher-plugin.ts';

test('submission uses host binding or an explicit assertion and exposes the persisted mandate', async () => {
  let tool, calls = 0;
  const dispatcher = { submitBound: async (parent, requestId, task, taskId) => {
    calls++; assert.equal(parent, 'main'); assert.equal(taskId, 'active');
    return { id: 'job', requestId, status: 'ready', dependency: { taskId: 'active', expiresAt: 12345 } };
  }, submitCurrent: async (parent, requestId) => {
    calls++; assert.equal(parent, 'main');
    return { id: 'job', requestId, status: 'ready', dependency: { taskId: 'active', expiresAt: 12345 } };
  } };
  dispatcherPlugin(() => dispatcher).activate({ registerTool: t => tool = t, registerCommand() {} });
  const args = { action: 'submit', requestId: 'req', task: 'review' };
  const automatic = JSON.parse(await tool.execute(args, { sessionKey: 'main' }));
  assert.deepEqual(automatic.mandate, { taskId: 'active', expiresAt: 12345 });
  await assert.rejects(tool.execute({ ...args, taskId: '' }, { sessionKey: 'main' }), /Invalid taskId/);
  assert.equal(calls, 1);
  const row = JSON.parse(await tool.execute({ ...args, taskId: 'active' }, { sessionKey: 'main' }));
  assert.deepEqual(row.mandate, { taskId: 'active', expiresAt: 12345 });
  assert.equal(calls, 2);
});

test('deadline diagnostics and binding are visible in status, command and paginated fields', async () => {
  let tool, command;
  const row = { id: 'job', requestId: 'req', status: 'paused', restarts: 0,
    diagnosticCode: 'deadline-expired', dependency: { taskId: 'old', expiresAt: 12345 } };
  dispatcherPlugin(() => ({ store: { list: () => [row] } })).activate({ registerTool: t => tool = t, registerCommand: c => command = c });
  const values = [
    JSON.parse(await tool.execute({ action: 'status', id: 'job' }, { sessionKey: 'main' })).tasks[0],
    JSON.parse(await tool.execute({ action: 'status', id: 'job', field: 'result' }, { sessionKey: 'main' })),
    JSON.parse(await command.run('status', { sessionKey: 'main' })).tasks[0],
  ];
  for (const value of values) {
    assert.deepEqual(value.mandate, { taskId: 'old', expiresAt: 12345 });
    assert.match(value.diagnostic, /deadline-expired/);
  }
});
