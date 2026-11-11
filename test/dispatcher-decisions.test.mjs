import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatcherPlugin } from '../src/dispatcher-plugin.ts';

function setup() {
  let tool, command;
  const calls = [];
  const row = { id: 'execution', requestId: 'task', parent: 'parent', status: 'ready', restarts: 0, decisions: [] };
  const dispatcher = { store: { list: parent => parent === 'parent' ? [row] : [] },
    control: async (...args) => calls.push(['control', ...args]),
    decide: async (parent, id, requestId, text) => {
      calls.push(['decide', parent, id, requestId, text]);
      const receipt = { requestId, text, recordedAt: 123, state: 'pending' }; row.decisions.push(receipt); return receipt;
    } };
  dispatcherPlugin(() => dispatcher).activate({ registerTool: value => tool = value, registerCommand: value => command = value });
  return { tool, command, calls, row };
}
const parent = { sessionKey: 'parent' };

test('decide tool and command deliver authenticated parent scope and return observable receipts', async () => {
  const { tool, command, calls, row } = setup();
  const accepted = JSON.parse(await tool.execute({ action: 'decide', id: 'execution', requestId: 'decision-1', decision: 'accept documented deviation' }, parent));
  assert.equal(accepted.recorded, true); assert.equal(accepted.state, 'pending');
  assert.deepEqual(calls[0], ['decide', 'parent', 'execution', 'decision-1', 'accept documented deviation']);
  const text = 'accept documented\n deviation  exactly';
  const result = JSON.parse(await command.run(`decide execution decision-2 ${text}`, parent));
  assert.equal(result.text, text, 'command preserves multiline text for stable retry semantics');
  assert.deepEqual(calls[1], ['decide', 'parent', 'execution', 'decision-2', text]);
  const page = JSON.parse(await tool.execute({ action: 'status', id: 'execution', field: 'decisions' }, parent));
  assert.deepEqual(JSON.parse(page.text), row.decisions);
  const status = JSON.parse(await tool.execute({ action: 'status', id: 'execution' }, parent));
  assert.equal(status.tasks[0].decisions[0].state, 'pending');
  assert.equal(command.admin, true, 'host command router requires authenticated admin authority');
  await assert.rejects(tool.execute({ action: 'status', id: 'execution', field: 'decisions' }, { sessionKey: 'other' }), /exact task/);
});

test('controls reject irrelevant task text rather than silently discarding steering', async () => {
  const { tool, command, calls } = setup();
  await assert.rejects(tool.execute({ action: 'resume', id: 'execution', task: 'please accept deviation' }, parent), /does not accept task/);
  await assert.rejects(command.run('resume execution irrelevant task', parent), /Use \/dispatch/);
  assert.equal(calls.length, 0);
});

for (const sessionKey of ['dispatch:worker', 'subagent:worker']) {
  test(`nested ${sessionKey} cannot use tool or command for decisions`, async () => {
    const { tool, command, calls } = setup();
    await assert.rejects(tool.execute({ action: 'decide', id: 'execution', requestId: 'd', decision: 'accept' }, { sessionKey }), /disabled/);
    await assert.rejects(command.run('decide execution d accept', { sessionKey }), /disabled/);
    assert.equal(calls.length, 0);
  });
}

test('decision on an older host fails explicitly instead of pretending it was delivered', async () => {
  let tool, command;
  dispatcherPlugin(() => ({})).activate({ registerTool: value => tool = value, registerCommand: value => command = value });
  await assert.rejects(tool.execute({ action: 'decide', id: 'execution', requestId: 'd', decision: 'accept' }, parent), /compatible host upgrade/);
  await assert.rejects(command.run('decide execution d accept', parent), /compatible host upgrade/);
});
