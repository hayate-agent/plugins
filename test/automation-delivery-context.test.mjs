import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automationDeliveryContext } from '../src/automation-delivery-context.ts';
import { readFileSync } from 'node:fs';

for (const source of ['cron', 'loop']) {
  test(`${source}: quiet ticket continuations, explicit reports and attention remain distinct`, () => {
    const context = automationDeliveryContext({ source });
    assert.match(context, /exactly NO_REPLY/);
    assert.match(context, /completed tickets/);
    assert.match(context, /including generated continuations/);
    assert.match(context, /substantive work result alone is not a reason/);
    assert.match(context, /Preserve reports explicitly requested/);
    assert.match(context, /aggregate report does not request individual ticket/);
    assert.match(context, /operator attention is genuinely needed/);
    assert.match(context, /not whether to perform the work/);
  });
}

test('human and unrelated inputs are unchanged', () => {
  for (const source of ['channel', 'api', 'host', 'heartbeat', 'goal']) {
    assert.equal(automationDeliveryContext({ source }), '');
  }
});

test('source wiring supplies delivery context without requiring cronReport metadata', async () => {
  // Plugins are copied into Core at build time; its runtime dependencies do not
  // exist in this standalone repository. Verify the hook and exercise its policy.
  const source = readFileSync(new URL('../src/cron-report-plugin.ts', import.meta.url), 'utf8');
  assert.match(source, /const delivery = automationDeliveryContext\(input\);\s*if \(delivery\) return delivery;/);
  const hook = { context: automationDeliveryContext };
  for (const source of ['cron', 'loop']) {
    const context = await hook.context({ source, text: 'continue', sessionKey: 'test' });
    assert.match(context, /Background automation delivery policy/);
    assert.match(context, /requested scope and cadence/);
  }
  assert.equal(await hook.context({ source: 'channel', text: 'hello', sessionKey: 'test' }), '');
});
