import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackGateway } from '../src/slack-gateway.mjs';

test('Slack batches scoped skill, memory, MCP and ordinary tool activity without payloads', async () => {
  const sent = [];
  const gateway = new SlackGateway({ teamId: 'T1', progress: 'full' }); gateway.stopped = false;
  gateway.send = async (to, text) => { sent.push({ to, text }); };
  const to = { channel: 'slack', target: 'C1', thread: '1.1' };
  gateway.turnEvent(to, { type: 'resource_usage', resource: 'skill', action: 'loaded', name: 'pdf', locale: 'de' });
  gateway.turnEvent(to, { type: 'resource_usage', resource: 'skill', action: 'created', name: 'report', locale: 'en' });
  gateway.turnEvent(to, { type: 'resource_usage', resource: 'skill', action: 'updated', name: 'tables', locale: 'es' });
  gateway.turnEvent(to, { type: 'resource_usage', resource: 'memory', action: 'recalled', locale: 'de' });
  gateway.turnEvent(to, { type: 'tool', phase: 'start', name: 'mcp__server__query', detail: 'secret' });
  gateway.turnEvent(to, { type: 'tool', phase: 'start', name: 'read', detail: 'secret2' });
  await new Promise(resolve => setTimeout(resolve, 1550));
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, to);
  for (const text of ['Skill · pdf · geladen', 'Skill · report · created', 'Skill · tables · actualizado', 'Memory · abgerufen', 'MCP · mcp__server__query', 'read']) assert.ok(sent[0].text.includes(text));
  assert.doesNotMatch(sent[0].text, /secret/);
  await gateway.stop();
});
