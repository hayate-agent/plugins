// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { completionPrompt } from '../src/completion-prompt.ts';

const task = 'Implement the approved update and verify regressions. No deployment.';
const input = {
  source: 'matrix', text: task, sessionKey: 'matrix:room',
  continuation: { state: 'waiting' },
  completionContext: ['Update verified; regression remains.'],
};
const reply = 'WAIT: context exhausted after long history and tool output; regression remains.';
const now = () => 1000;
const prompt = () => completionPrompt(input, reply, { task }, now);

test('prompt exposes optional closed context preparation on continue only', () => {
  const text = prompt();
  assert.match(text, /Return JSON only: .*"contextPreparation":"compact"\|"handover"/);
  assert.match(text, /contextPreparation is optional and valid only with state="continue"/);
  assert.match(text, /Omit contextPreparation when no context relief is needed; never emit null/);
  assert.match(text, /next must name the concrete authorized work step, not just maintenance/);
});

test('checker independently overrides model WAIT without bypassing genuine holds', () => {
  const text = prompt();
  assert.match(text, /Independently determine genuine blockers/);
  assert.match(text, /Override a model-authored WAIT/);
  assert.match(text, /explicit user stop or pause/);
  assert.match(text, /permission, security, missing credentials or external-dependency holds/);
  assert.match(text, /preparation does not grant authority or bypass host policy/);
  assert.match(text, /never poll early or repeat the waiting step/);
});

test('context pressure requires relief before work, not fabricated thresholds or routine maintenance', () => {
  const text = prompt();
  assert.match(text, /Context exhaustion, long history and tool-output pressure/);
  assert.match(text, /return continue with that next step and contextPreparation so relief runs BEFORE work resumes/);
  assert.match(text, /compact for sufficient in-session relief/);
  assert.match(text, /handover for checkpoint-resumable work requiring a fresh session/);
  assert.match(text, /Preserve the mandate, constraints and verified effects/);
  assert.match(text, /Do not invent token usage, percentages or thresholds/);
  assert.match(text, /do not request compaction or handover on every turn/);
});

test('prompt preserves bounded evidence and original authorization unchanged', () => {
  const data = JSON.parse(prompt().split('\nDATA: ')[1]);
  assert.deepEqual(data, {
    task, checkpoint: 'waiting', request: task,
    nowUTC: '1970-01-01T00:00:01.000Z', reply, context: input.completionContext,
  });
  const bounded = JSON.parse(completionPrompt({ ...input, text: 'x'.repeat(9000) },
    'y'.repeat(17000), { task }, now).split('\nDATA: ')[1]);
  assert.equal(bounded.request.length, 8000);
  assert.equal(bounded.reply.length, 16000);
});

// Optional read-only cross-repository contract proof. This scripts checker JSON;
// it verifies the real parser with this prompt, NOT live model recognition.
// Run: HARNESS_CORE_ROOT=/path/to/core node --test test/completion-prompt.test.mjs
const core = process.env.HARNESS_CORE_ROOT;
test('scripted checker JSON round-trips through the real core parser', { skip: !core }, async () => {
  const { assessCompletion } = await import(pathToFileURL(path.join(core, 'src/completion-check.ts')).href);
  for (const action of [undefined, 'compact', 'handover', null, 'invented']) {
    const next = 'Run remaining authorized regression; no deployment.';
    const verdict = { state: 'continue', next, ...(action === undefined ? {} : { contextPreparation: action }) };
    let checked = false;
    const result = await assessCompletion({ review: async text => {
      checked = true;
      assert.equal(text, prompt());
      return JSON.stringify(verdict);
    } }, input, reply, { task }, new AbortController().signal, undefined, now, completionPrompt);
    assert.equal(checked, true);
    assert.deepEqual(result, action === null || action === 'invented' ? undefined : verdict);
  }
});
