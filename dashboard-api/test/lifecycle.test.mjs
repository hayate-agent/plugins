import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import gateway, { WebUIChannel } from '../index.mjs';
import { activateSettingsTool, loadModules } from '../ui.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function tick() { await new Promise(resolve => setTimeout(resolve, 25)); }
async function profile(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'webui-lifecycle-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
async function post(channel, suffix, body) {
  return fetch(channel.url + suffix, { method: 'POST', headers: { Origin: channel.url, 'Content-Type': 'application/json', 'X-Hayate-WebUI': '1' }, body: JSON.stringify(body) });
}

test('gateway and settings plugin explicitly own their update cleanup', () => {
  assert.equal(gateway.updateAdmission, 'foreground-owned');
});
test('UI modules without an ownership declaration fail before activation', async t => {
  const home = await profile(t);
  const marker = path.join(home, 'must-not-exist');
  await writeFile(path.join(home, 'legacy.mjs'), `import {writeFile} from 'node:fs/promises'; export default {
    apiVersion:1, activate(){return writeFile(${JSON.stringify(marker)}, 'unsafe activation');}
  }`);
  await assert.rejects(loadModules(home, { modules: ['legacy.mjs'] }), /must declare updateAdmission/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
test('settings tool fences new calls and drains accepted writes on stop', async t => {
  const home = await profile(t);
  let tool, stop;
  await activateSettingsTool({ home, registerTool(value) { tool = value; }, onStop(value) { stop = value; } });
  const first = tool.execute({ patch: { title: 'First' } });
  const second = tool.execute({ patch: { title: 'Second' } });
  const stopping = stop();
  await assert.rejects(tool.execute({ patch: { title: 'Too late' } }), /stopping/);
  await stopping; await Promise.all([first, second]);
  assert.equal(JSON.parse(await readFile(path.join(home, 'webui/ui.json'), 'utf8')).title, 'Second');
});
test('stop shares one promise, waits for in-flight acceptance, then permits restart', async t => {
  const home = await profile(t);
  const entered = deferred(), release = deferred();
  const channel = new WebUIChannel({ home, port: 0 });
  await channel.start(async () => { entered.resolve(); await release.promise; });
  const chat = await (await post(channel, '/api/chats', {})).json();
  const sending = post(channel, `/api/chats/${chat.id}/messages`, { id: randomUUID(), text: 'in flight' }).catch(() => null);
  await entered.promise;
  let stopped = false;
  const stopping = channel.stop();
  assert.equal(channel.stop(), stopping);
  void stopping.then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  await assert.rejects(channel.send({ target: chat.id }, 'late reply'), /stopping/);
  await assert.rejects(channel.start(async () => {}), /transitioning/);
  release.resolve(); await stopping; await sending;
  const store = JSON.parse(await readFile(path.join(home, 'webui/conversations.json'), 'utf8'));
  assert.equal(store.chats[0].messages[0].accepted, true);
  await channel.start(async () => {});
  assert.equal((await fetch(channel.url + '/api/state')).status, 200);
  await channel.stop();
});
test('stop interrupts incomplete HTTP bodies and idle sockets without waiting for client timeouts', async t => {
  const home = await profile(t);
  const channel = new WebUIChannel({ home, port: 0 });
  let deliveries = 0;
  await channel.start(async () => { deliveries++; });
  const chat = await (await post(channel, '/api/chats', {})).json();
  const url = new URL(channel.url);
  const socket = connect(Number(url.port), url.hostname);
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`POST /api/chats/${chat.id}/messages HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${url.origin}\r\nContent-Type: application/json\r\nX-Hayate-WebUI: 1\r\nContent-Length: 100\r\n\r\n{`);
  await tick();
  const closed = new Promise(resolve => socket.once('close', resolve));
  await channel.stop(); await closed;
  assert.equal(deliveries, 0);
});
test('stop waits for a concurrent module activation and closes its resources', async t => {
  const home = await profile(t);
  const entered = deferred(), release = deferred();
  const key = `webuiLifecycle_${randomUUID()}`;
  globalThis[key] = { entered, release, cleanups: 0 };
  t.after(() => { delete globalThis[key]; });
  await mkdir(path.join(home, 'webui'));
  await writeFile(path.join(home, 'webui/ui.json'), JSON.stringify({ modules: ['module.mjs'] }));
  await writeFile(path.join(home, 'module.mjs'), `export default {apiVersion:1,updateAdmission:'foreground-owned',async activate(api){
    const state = globalThis[${JSON.stringify(key)}]; api.onStop(()=>{state.cleanups++});
    state.entered.resolve(); await state.release.promise;
  }}`);
  const channel = new WebUIChannel({ home, port: 0 });
  const starting = channel.start(async () => {});
  await entered.promise;
  let stopped = false;
  const stopping = channel.stop().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  release.resolve(); await starting; await stopping;
  assert.equal(globalThis[key].cleanups, 1);
  await assert.rejects(fetch(channel.url));
});
test('module cleanup failure remains rejected on repeated stop and prevents unsafe restart', async t => {
  const home = await profile(t);
  await mkdir(path.join(home, 'webui'));
  await writeFile(path.join(home, 'webui/ui.json'), JSON.stringify({ modules: ['module.mjs'] }));
  await writeFile(path.join(home, 'module.mjs'), `export default {apiVersion:1,updateAdmission:'foreground-owned',activate(api){
    api.onStop(()=>{throw Error('cleanup failed')});
  }}`);
  const channel = new WebUIChannel({ home, port: 0 });
  await channel.start(async () => {});
  await assert.rejects(channel.stop(), /cleanup failed/);
  await assert.rejects(channel.stop(), /cleanup failed/);
  await assert.rejects(channel.start(async () => {}), /process restart required/);
});
