import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleGate } from '../ingress.mjs';
for (const hasLater of [false, true]) test(`cancellation stops ${hasLater ? 'later rule and ' : ''}fallback`, async () => {
 const controller = new AbortController(), reason = new Error('cancelled'); let calls = 0;
 const rules = [async () => { controller.abort(reason); return null; }];
 if (hasLater) rules.push(async () => { calls++; return null; });
 const gate = ruleGate(rules, async () => { calls++; return { target: 'main' }; });
 await assert.rejects(gate({}, { signal: controller.signal }, {}), error => error === reason);
 assert.equal(calls, 0);
});
test('pre-aborted empty gate never calls fallback', async () => {
 const controller = new AbortController(); controller.abort(); let calls = 0;
 await assert.rejects(ruleGate([], async () => { calls++; })({}, { signal: controller.signal }, {}), { name: 'AbortError' });
 assert.equal(calls, 0);
});
test('matching rules and no-signal fallback preserve outputs', async () => {
 const decision = { target: 'main' }; let later = 0;
 assert.equal(await ruleGate([async () => decision], async () => { later++; })({}, {}, {}), decision);
 assert.equal(later, 0);
 assert.equal(await ruleGate([async () => null], async () => decision)({}, {}, {}), decision);
 await assert.rejects(ruleGate([])({}, {}, {}), /No routing rule matched/);
});
