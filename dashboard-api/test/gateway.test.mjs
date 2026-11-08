import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import gateway, { WebUIChannel } from '../index.mjs';
import { activateSettingsTool, loadModules, validateUI } from '../ui.mjs';

async function setup(t, deliver = async () => {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'hayate-webui-'));
  const channel = new WebUIChannel({ home, port: 0 });
  await channel.start(deliver);
  t.after(async () => { await channel.stop(); await rm(home, { recursive: true, force: true }); });
  const get = async suffix => (await fetch(channel.url + suffix)).json();
  const post = (suffix, body, headers = {}) => fetch(channel.url + suffix, { method: 'POST', headers: {
    Origin: channel.url, 'Content-Type': 'application/json', 'X-Hayate-WebUI': '1', ...headers,
  }, body: JSON.stringify(body) });
  const chat = await (await post('/api/chats', {})).json();
  return { channel, home, get, post, chat };
}

test('factory is inert and exposes native gateway + optional settings plugin', async () => {
  const instance = await gateway.create({ home: '/does/not/exist', agent: 'Test' });
  assert.equal(instance.channel.name, 'webui'); assert.equal(instance.channel.url, undefined);
  assert.equal(typeof gateway.activate, 'function');
});
test('native ingress fixes routing and sender, preserves retry identity and Unicode', async t => {
  const received = [];
  const { post, chat, get } = await setup(t, async input => { received.push(input); });
  const body = { id: randomUUID(), text: 'Hallo 🌍 日本語', sender: 'console', sessionKey: 'console:local' };
  assert.equal((await post(`/api/chats/${chat.id}/messages`, body)).status, 202);
  assert.equal((await post(`/api/chats/${chat.id}/messages`, body)).status, 202);
  assert.equal(received[0].sessionKey, `webui:${chat.id}`);
  assert.equal(received[0].sender, 'webui:local');
  assert.equal(received[0].id, received[1].id);
  assert.equal(received[0].text, body.text);
  assert.equal((await get(`/api/chats/${chat.id}`)).messages.length, 1);
  assert.equal((await post(`/api/chats/${chat.id}/messages`, { ...body, text: 'changed' })).status, 409);
});
test('ambiguous host acceptance returns error and permits same-ID retry', async t => {
  let attempts = 0;
  const { post, chat, get } = await setup(t, async () => { if (++attempts === 1) throw Error('secret internal error'); });
  const body = { id: randomUUID(), text: 'retry me' };
  const failed = await post(`/api/chats/${chat.id}/messages`, body);
  assert.equal(failed.status, 500); assert.doesNotMatch(await failed.text(), /secret/);
  assert.equal((await post(`/api/chats/${chat.id}/messages`, body)).status, 202);
  assert.equal((await get(`/api/chats/${chat.id}`)).messages.length, 1);
});
test('authority, origin, fetch metadata and JSON checks fail closed', async t => {
  const { channel, post } = await setup(t);
  for (const headers of [{ Origin: 'https://evil.example' }, { 'X-Hayate-WebUI': '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await post('/api/chats', {}, headers)).status, 403);
  }
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(channel.url + '/api/state', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(channel.url + '/api/chats', { method: 'POST', headers: { Origin: channel.url, 'X-Hayate-WebUI': '1' } })).status, 415);
  assert.equal((await fetch(channel.url + '/api/chats', { method: 'POST' })).status, 403);
});
test('input bounds are HTTP protection, never model context metadata', async t => {
  const { chat, post, get } = await setup(t);
  assert.equal((await post(`/api/chats/${chat.id}/messages`, { id: randomUUID(), text: 'x'.repeat(64001) })).status, 400);
  assert.equal((await post('/api/chats', { x: 'x'.repeat(300001) })).status, 413);
  assert.equal((await get('/api/state')).contextWindow, undefined);
});
test('outbound delivery is persisted and deduplicated, including after restart', async t => {
  const { channel, chat, get } = await setup(t);
  const to = { channel: 'webui', target: chat.id };
  await channel.send(to, 'answer', { deliveryId: 'delivery-1' });
  await channel.send(to, 'answer', { deliveryId: 'delivery-1' });
  assert.equal((await get(`/api/chats/${chat.id}`)).messages.length, 1);
  await channel.stop(); await channel.start(async () => {});
  await channel.send(to, 'answer', { deliveryId: 'delivery-1' });
  assert.equal((await get(`/api/chats/${chat.id}`)).messages.length, 1);
});
test('concurrent presentation transactions do not lose replies', async t => {
  const { channel, chat, get } = await setup(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => channel.send({ target: chat.id }, `answer-${i}`, { deliveryId: String(i) })));
  assert.equal((await get(`/api/chats/${chat.id}`)).messages.length, 12);
});
test('progress replacement and failure outcome use transport metadata', async t => {
  const { channel, chat, get } = await setup(t);
  const to = { target: chat.id };
  await channel.send(to, 'progress', { progressId: 'p', presentation: 'progress', deliveryId: 'a' });
  await channel.send(to, 'partial answer', { progressId: 'p', deliveryId: 'b', outcome: 'cancelled' });
  const result = await get(`/api/chats/${chat.id}`);
  assert.equal(result.messages.length, 1); assert.equal(result.messages[0].outcome, 'cancelled');
  await channel.send(to, 'stale progress retry', { progressId: 'p', presentation: 'progress', deliveryId: 'a' });
  assert.equal((await get(`/api/chats/${chat.id}`)).messages[0].text, 'partial answer');
});
test('live projection excludes hidden reasoning, tool arguments and details', async t => {
  const { channel, chat, get } = await setup(t);
  const to = { target: chat.id };
  await channel.typing(to, true);
  channel.turnEvent(to, { type: 'thinking', detail: 'PRIVATE' });
  channel.turnEvent(to, { type: 'tool', phase: 'start', name: 'read', detail: 'PRIVATE' });
  channel.turnEvent(to, { type: 'text', delta: 'visible' });
  const result = await get(`/api/chats/${chat.id}`);
  assert.equal(result.live.tools.read, 1); assert.equal(result.live.text, 'visible');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  await channel.typing(to, false);
  assert.equal((await get(`/api/chats/${chat.id}`)).live.awaitingDelivery, true);
  await channel.send(to, 'final', { deliveryId: 'final' });
  assert.equal((await get(`/api/chats/${chat.id}`)).live, null);
});
test('SSE always starts with a full snapshot and shutdown closes connections', async t => {
  const { channel, chat } = await setup(t);
  const response = await fetch(`${channel.url}/api/events?chat=${chat.id}`);
  const reader = response.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), new RegExp(chat.id));
  await channel.stop();
  while (!(await reader.read()).done) { /* drain */ }
});
test('API backend serves no frontend assets or arbitrary filesystem paths', async t => {
  const { channel } = await setup(t);
  for (const route of ['/', '/app.js', '/style.css', '/index.html']) assert.equal((await fetch(channel.url + route)).status, 404);
  const response = await fetch(channel.url + '/api/state');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(channel.url + '/index.mjs')).status, 404);
});
test('settings tool persists presentation but refuses executable module changes and context fields', async t => {
  const { home } = await setup(t);
  let tool;
  await activateSettingsTool({ home, registerTool(value) { tool = value; }, onStop() {} });
  await tool.execute({ patch: { workArea: 'always', theme: 'dark', panels: [{ title: 'Plan', text: '<script>not executable</script>' }] } });
  const saved = JSON.parse(await readFile(path.join(home, 'webui/ui.json'), 'utf8'));
  assert.equal(saved.theme, 'dark');
  await assert.rejects(tool.execute({ patch: { modules: ['evil.mjs'] } }), /operator/);
  await assert.rejects(tool.execute({ patch: { contextWindow: 123 } }), /Unknown/);
  assert.throws(() => validateUI({ workAreaRows: 0 }));
});
test('trusted modules register declarative panels/actions and fail isolated panel rendering', async t => {
  const { home } = await setup(t);
  await writeFile(path.join(home, 'example.mjs'), `export default {apiVersion:1,updateAdmission:'foreground-owned',activate(api){
    api.registerPanel({title:'Status',render(ctx){return ctx.agent}});
    api.registerPanel({title:'Broken',render(){throw Error('PRIVATE')}});
    api.registerAction({label:'Status',input:'/status'});
  }}`);
  const modules = await loadModules(home, { modules: ['example.mjs'] });
  const result = modules.project({ agent: 'Test' });
  assert.equal(result.panels[0].text, 'Test'); assert.equal(result.panels[1].text, 'Panel unavailable');
  assert.equal(result.actions[0].input, '/status'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  await modules.stop();
});
test('module cleanup runs in reverse order and partial activation is cleaned', async t => {
  const { home } = await setup(t);
  const output = path.join(home, 'cleanup.txt');
  await writeFile(path.join(home, 'cleanup.mjs'), `import {appendFile} from 'node:fs/promises';
    export default {apiVersion:1, updateAdmission:'foreground-owned', activate(api) {
      api.onStop(() => appendFile(${JSON.stringify(output)}, 'first '));
      api.onStop(() => appendFile(${JSON.stringify(output)}, 'second '));
    }}`);
  const modules = await loadModules(home, { modules: ['cleanup.mjs'] });
  await modules.stop(); await modules.stop();
  assert.equal(await readFile(output, 'utf8'), 'second first ');
  await writeFile(path.join(home, 'failing.mjs'), `import {appendFile} from 'node:fs/promises';
    export default {apiVersion:1, updateAdmission:'foreground-owned', activate(api) {
      api.onStop(() => appendFile(${JSON.stringify(output)}, 'partial'));
      throw Error('activation failure');
    }}`);
  await assert.rejects(loadModules(home, { modules: ['failing.mjs'] }), /activation failed/);
  assert.equal(await readFile(output, 'utf8'), 'second first partial');
});
test('corrupt persisted data fails startup rather than silently deleting history', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'hayate-webui-bad-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'webui')); await writeFile(path.join(home, 'webui/conversations.json'), '{bad');
  const channel = new WebUIChannel({ home, port: 0 });
  await assert.rejects(channel.start(async () => {}));
});
