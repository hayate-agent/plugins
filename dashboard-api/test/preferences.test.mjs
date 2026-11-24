import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebUIChannel } from '../index.mjs';
import { applyPatch, defaults, THEMES, Preferences } from '../preferences.mjs';

const post = (channel, body, headers = {}) => fetch(channel.url + '/api/preferences', { method: 'POST', headers: { Origin: channel.url, 'X-Hayate-WebUI': '1', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function start(t, prepare) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'prefs-')); if (prepare) await prepare(home);
  const channel = new WebUIChannel({ home, port: 0 }); await channel.start(async () => {});
  t.after(async () => { await channel.stop(); await rm(home, { recursive: true, force: true }); });
  return { home, channel };
}

test('defaults keep the existing look: green theme, system mode, empty titles, nothing hidden', async t => {
  const { channel } = await start(t);
  const response = await fetch(channel.url + '/api/preferences');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), defaults);
  assert.equal(defaults.theme, 'green'); assert.deepEqual(THEMES.slice(0, 4), ['green', 'blue', 'gray', 'red']);
});

test('a change is stored on the server, survives a restart and is the same for every client', async t => {
  const { home, channel } = await start(t);
  const saved = await (await post(channel, { theme: 'blue', mode: 'dark', pageTitle: 'Work', headerTitle: 'karsten', hide: ['akira', 'chat:akira:7'] })).json();
  assert.deepEqual({ ...saved, revision: undefined }, { theme: 'blue', mode: 'dark', pageTitle: 'Work', headerTitle: 'karsten', hidden: ['akira', 'chat:akira:7'], revision: undefined });
  assert.equal(saved.revision, 1);
  const second = await (await fetch(channel.url + '/api/preferences')).json(); assert.deepEqual(second, saved);
  await channel.stop();
  const again = new WebUIChannel({ home, port: 0 }); await again.start(async () => {});
  t.after(() => again.stop());
  assert.deepEqual(await (await fetch(again.url + '/api/preferences')).json(), saved);
  const file = path.join(home, 'webui', 'preferences.json');
  assert.equal(((await stat(file)).mode & 0o777), 0o600);
  assert.deepEqual((await readdir(path.dirname(file))).filter(name => name.endsWith('.tmp')), []);
});

test('hide and show change single items so two browsers never overwrite each other', async t => {
  const { channel } = await start(t);
  await post(channel, { hide: ['project:a:1'] }); await post(channel, { hide: ['chat:a:2', 'project:a:1'] });
  assert.deepEqual((await (await post(channel, { show: ['project:a:1'] })).json()).hidden, ['chat:a:2']);
  const both = await Promise.all(Array.from({ length: 12 }, (_, i) => post(channel, { hide: [`chat:b:${i}`] })));
  assert.ok(both.every(response => response.status === 200));
  const final = await (await fetch(channel.url + '/api/preferences')).json();
  assert.equal(final.hidden.length, 13); assert.equal(final.revision, 3 + 12);
});

test('hiding and showing the same item in one patch leaves it hidden; the list is bounded in total', async t => {
  const { channel } = await start(t);
  assert.deepEqual((await (await post(channel, { hide: ['chat:a:1'], show: ['chat:a:1'] })).json()).hidden, ['chat:a:1']);
  const first = Array.from({ length: 1999 }, (_, i) => `chat:a:${i + 2}`);
  assert.equal((await post(channel, { hide: first })).status, 200);
  assert.equal((await post(channel, { hide: ['chat:a:x'] })).status, 400, 'the 2001st item is refused');
  assert.equal((await (await fetch(channel.url + '/api/preferences')).json()).hidden.length, 2000);
});

test('invalid input is refused without changing anything', async t => {
  const { channel } = await start(t);
  const cases = [{ theme: 'neon' }, { mode: 'sepia' }, { pageTitle: 'x'.repeat(61) }, { headerTitle: 'bad\u0000' }, { pageTitle: 5 }, { hide: 'agent:x' }, { hide: ['has space'] }, { hide: ['a:b'] }, { hide: ['other:a:b'] }, { hide: ['chat:a'] }, { hide: ['chat::x'] }, { hide: [5] },
    { hide: Array.from({ length: 2001 }, (_, i) => `chat:a:${i}`) }, { surprise: 1 }, { hide: ['x'.repeat(401)] }];
  for (const body of cases) assert.equal((await post(channel, body)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.deepEqual(await (await fetch(channel.url + '/api/preferences')).json(), defaults);
  assert.equal((await fetch(channel.url + '/api/preferences', { method: 'POST', headers: { Origin: channel.url, 'X-Hayate-WebUI': '1', 'Content-Type': 'application/json' }, body: '[1]' })).status, 400);
  assert.equal((await fetch(channel.url + '/api/preferences', { method: 'PUT', headers: { Origin: channel.url, 'X-Hayate-WebUI': '1' } })).status, 405);
});

test('writes keep the same-origin protections of every other API route', async t => {
  const { channel } = await start(t);
  assert.equal((await post(channel, { theme: 'red' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(channel.url + '/api/preferences', { method: 'POST', headers: { Origin: channel.url, 'Content-Type': 'application/json' }, body: '{"theme":"red"}' })).status, 403);
  assert.equal((await fetch(channel.url + '/api/preferences', { method: 'POST', headers: { Origin: channel.url, 'X-Hayate-WebUI': '1', 'Content-Type': 'text/plain' }, body: '{"theme":"red"}' })).status, 415);
  assert.equal((await (await fetch(channel.url + '/api/preferences')).json()).theme, 'green');
});

test('a damaged or hostile stored file is not trusted', async t => {
  const { channel, home } = await start(t, async dir => {
    await mkdir(path.join(dir, 'webui'), { recursive: true });
    await writeFile(path.join(dir, 'webui', 'preferences.json'), JSON.stringify({ theme: 'neon', hidden: ['chat:1:2'], revision: 4 }));
  });
  assert.deepEqual(await (await fetch(channel.url + '/api/preferences')).json(), defaults);
  assert.equal((await (await post(channel, { theme: 'gray' })).json()).theme, 'gray');
  await channel.stop(); await writeFile(path.join(home, 'webui', 'preferences.json'), '{not json');
  const again = new WebUIChannel({ home, port: 0 }); await again.start(async () => {}); t.after(() => again.stop());
  assert.deepEqual(await (await fetch(again.url + '/api/preferences')).json(), defaults);
});

test('a failed write leaves memory and file untouched and later writes still work', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'prefs-')); t.after(() => rm(home, { recursive: true, force: true }));
  const blocked = path.join(home, 'blocked'); await writeFile(blocked, 'file, not directory');
  const store = new Preferences(path.join(blocked, 'preferences.json')); await store.load();
  await assert.rejects(store.patch({ theme: 'red' })); assert.equal(store.value.theme, 'green'); assert.equal(store.value.revision, 0);
  const good = new Preferences(path.join(home, 'ok', 'preferences.json')); await good.load();
  await assert.rejects(good.patch({ theme: 'nope' })); assert.equal((await good.patch({ theme: 'red' })).theme, 'red');
  assert.equal(JSON.parse(await readFile(path.join(home, 'ok', 'preferences.json'), 'utf8')).theme, 'red');
});

test('a write that fails after staging leaves the old state in memory and on disk', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'prefs-')); t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'preferences.json');
  const store = new Preferences(file); await store.load(); await store.patch({ theme: 'blue' });
  await rm(file); await mkdir(path.join(file, 'in-the-way'), { recursive: true });  // the final rename cannot replace a non-empty directory
  await assert.rejects(store.patch({ theme: 'red' }));
  assert.equal(store.value.theme, 'blue'); assert.equal(store.value.revision, 1);
  assert.deepEqual((await readdir(home)).filter(name => name.endsWith('.tmp')), [], 'the staged temp file of the failed write is removed');
});

test('applyPatch never mutates its input and trims titles', () => {
  const current = { ...defaults, hidden: ['chat:a:b'] }; const before = JSON.stringify(current);
  const next = applyPatch(current, { pageTitle: '  Mine  ', hide: ['project:c:d'] });
  assert.equal(JSON.stringify(current), before); assert.equal(next.pageTitle, 'Mine'); assert.deepEqual(next.hidden, ['chat:a:b', 'project:c:d']);
});
