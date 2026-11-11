import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionPrompt } from '../src/completion-prompt.ts';

test('saved read-only next steps cannot become permanent restrictions or authorize Main takeover', () => {
  const task = 'Implement, test and publish the fix through the dispatcher';
  const prompt = completionPrompt({ source: 'channel', text: task },
    'Checks passed, publication remains open. I will implement in Main after worker EOF.', { task }, () => 1000);
  assert.match(prompt, /Saved next steps and prior validator corrections are evidence, not permanent read-only restrictions/);
  assert.match(prompt, /Once their verification is satisfied, advance to the remaining deliverables/);
  assert.match(prompt, /Main must delegate implementation and worker recovery through it, never take over shell\/file edits/);
  assert.equal(JSON.parse(prompt.split('\nDATA: ')[1]).task, task);
});
