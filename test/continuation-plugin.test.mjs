import assert from 'node:assert/strict';
import { test } from 'node:test';
import { continuationPlugin } from '../src/continuation-plugin.ts';

function toolFor(planContinuation) {
  let tool;
  continuationPlugin({ planContinuation }).activate({ registerTool(value) { tool = value; } });
  return tool;
}

test('continuation schema exposes optional closed replyKind with entire-reply semantics', () => {
  const tool = toolFor(() => {});
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.required, ['state']);
  const field = tool.parameters.properties.replyKind;
  assert.equal(field.type, 'string');
  assert.deepEqual(field.enum, ['routine', 'substantive']);
  for (const description of [field.description, tool.description]) {
    assert.match(description, /ENTIRE turn reply/);
    assert.match(description, /partial/);
    assert.match(description, /approval/);
    assert.match(description, /blocker/);
    assert.match(description, /absent|omitted/);
    assert.match(description, /unchanged bounded wait recheck/);
  }
});

test('continuation forwards both designations and absence without inferring from wait equality', async () => {
  for (const replyKind of [undefined, 'routine', 'substantive']) {
    let received;
    const tool = toolFor((key, plan) => { received = { key, plan }; });
    const plan = { state: 'waiting', next: 'inspect worker', wait: { reason: 'worker', retryAfterMs: 60000, deadline: 900000 }, ...(replyKind === undefined ? {} : { replyKind }) };
    assert.match(await tool.execute(plan, { sessionKey: 'parent' }), /Bounded wait recorded/);
    assert.deepEqual(received, { key: 'parent', plan });
    assert.equal(Object.hasOwn(received.plan, 'replyKind'), replyKind !== undefined);
  }
});

test('invalid values are not coerced or swallowed before the host validation boundary', async () => {
  for (const replyKind of ['', 'quiet', null, 1, {}, ['routine']]) {
    const tool = toolFor((_key, plan) => {
      assert.equal(plan.replyKind, replyKind);
      throw Error('Invalid continuation reply kind');
    });
    assert.ok(!tool.parameters.properties.replyKind.enum.includes(replyKind));
    await assert.rejects(tool.execute({ state: 'waiting', replyKind }, { sessionKey: 'parent' }), /Invalid continuation reply kind/);
  }
});
