import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('public plugin documentation explains usage and trust without private publication instructions', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Hayate Agent Plugins/);
  assert.match(readme, /https:\/\/github\.com\/hayate-agent\/core/);
  assert.match(readme, /trusted code with the agent process/);
  assert.match(readme, /Core includes a tested set of plugins/);
  assert.doesNotMatch(readme, /`harness\/core`|configured Forgejo agent identities/);
});

test('automatic memory capture attributes reported claims to Hayate Agent', async () => {
  // This source adapter imports host-only modules; exercise its real materialized
  // runtime in the compatibility gate, not a replacement module in this repository.
  const source = await readFile(new URL('../src/memory-service.ts', import.meta.url), 'utf8');
  assert.match(source, /Outcome reported by Hayate Agent: \$\{turn.outcome\}/);
  assert.doesNotMatch(source, /Outcome reported by Harness:/);
  assert.match(source, /not verification of operational claims/);
});
