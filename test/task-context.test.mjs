import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskContextLabel } from '../src/execution-metadata.ts';
import { dispatcherPlugin } from '../src/dispatcher-plugin.ts';

test('context is bounded plain host metadata, never prompt prose', () => {
  const id = '01234567-89ab-cdef-0123-456789abcdef';
  assert.equal(taskContextLabel(id, ['security', 'appointment', 'security']), `task ${id} · #appointment #security`);
  assert.equal(taskContextLabel(id, []), `task ${id} · untagged`);
  assert.equal(taskContextLabel(id), `task ${id} · context unknown`);
  assert.doesNotMatch(taskContextLabel(id + '\n', ['security\n']), /[\r\n]/);
  const unsafe = taskContextLabel('SECRET <b>\x1b[31m\n', ['<script>', 'Äpfel', 'a\nsecret', '*bold*', 'x'.repeat(65), ...Array.from({length: 100}, (_, i) => `tag-${i}`)]);
  assert.doesNotMatch(unsafe, /SECRET|script|Äpfel|secret|bold|[<>\x1b\n*]/);
  assert.ok(unsafe.length < 600);
  assert.equal((unsafe.match(/#/g) ?? []).length, 8);
});

test('both status projections retain each original anchor across states and legacy never borrows', async () => {
  const rows = [
    {id: '01234567-89ab-cdef-0123-456789abcdef', status: 'ready', input: 'SECRET A', dependency: {anchor: {outputTags: ['appointment']}}},
    {id: '11234567-89ab-cdef-0123-456789abcdef', status: 'running', input: 'SECRET B', dependency: {anchor: {outputTags: ['security']}}},
    {id: '21234567-89ab-cdef-0123-456789abcdef', status: 'blocked'},
    {id: '31234567-89ab-cdef-0123-456789abcdef', status: 'completed', dependency: {anchor: {}}},
  ];
  let tool, command;
  dispatcherPlugin(() => ({ store: { list: parent => { assert.equal(parent, 'parent'); return structuredClone(rows); } } })).activate({registerTool: t => tool = t, registerCommand: c => command = c});
  const original = structuredClone(rows);
  for (const status of ['ready', 'running', 'completed', 'blocked']) {
    rows[0].status = status;
    for (const text of [await tool.execute({action: 'status'}, {sessionKey: 'parent'}), await command.run('status', {sessionKey: 'parent'})]) {
      const result = JSON.parse(text);
      assert.equal(result.tasks[0].taskContext, `task ${rows[0].id} · #appointment`);
      assert.equal(result.tasks[1].taskContext, `task ${rows[1].id} · #security`);
      assert.equal(result.tasks[2].taskContext, `task ${rows[2].id} · context unknown`);
      assert.equal(result.tasks[3].taskContext, `task ${rows[3].id} · untagged`);
      assert.doesNotMatch(result.tasks.map(t => t.taskContext).join('\n'), /SECRET/);
    }
  }
  rows[0].status = original[0].status;
  assert.deepEqual(rows, original, 'projection does not mutate authority or routing');
});
