import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatcherPlugin } from '../src/dispatcher-plugin.ts';
import { executionLabel } from '../src/execution-metadata.ts';

test('both dispatch status surfaces distinguish host scheduler and observed worker selection', async () => {
  const rows = [{ id: 'one', status: 'running', execution: { model: 'p/b', thinking: 'off' } }, { id: 'two', status: 'ready' }];
  let tool, command;
  dispatcherPlugin(() => ({ store: { list: () => rows } })).activate({ registerTool: t => tool = t, registerCommand: c => command = c });
  for (const value of [await tool.execute({ action: 'status' }, { sessionKey: 'parent' }), await command.run('status', { sessionKey: 'parent' })]) {
    const result = JSON.parse(value);
    assert.deepEqual(result.dispatcher, { kind: 'host-scheduler', model: null, reasoning: null });
    assert.equal(result.tasks[0].workerExecution, 'model p/b · reasoning off');
    assert.equal(result.tasks[1].workerExecution, executionLabel());
  }
});
