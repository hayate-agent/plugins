import test from 'node:test';
import assert from 'node:assert/strict';
import { completionPrompt } from '../src/completion-prompt.ts';
test('resolved host evidence is emitted once, full grant and deadline unchanged', () => {
  const task = 'exact grant '.repeat(2000);
  const resolved = { ingress: [{ text: task }], observations: [], incomplete: true, transcript: { current: 'available', archive: 'missing' } };
  const prompt = completionPrompt({ text: 'request', completionContext: { resolved, recent: [{ text: 'duplicate' }], tasks: [{ original: 'duplicate' }], tools: [{ result: 'duplicate' }] } }, 'reply', { task, expiresAt: 123456 }, () => 1000);
  const data = JSON.parse(prompt.split('\nDATA: ')[1]);
  assert.equal(data.task, task); assert.equal(data.expiresAt, 123456);
  assert.deepEqual(data.context, { resolved });
  assert.ok(!JSON.stringify(data).includes('duplicate'));
  assert.match(prompt, /missing or failed/);
});
