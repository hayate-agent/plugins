import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('manifest is importable JSON with exactly the implemented bot scopes and event subscription', async () => {
  const manifest = JSON.parse(await readFile(new URL('../examples/slack-app-manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.settings.socket_mode_enabled, true);
  assert.deepEqual(manifest.settings.event_subscriptions.bot_events, ['app_mention', 'message.im', 'message.channels', 'message.groups']);
  assert.deepEqual([...manifest.oauth_config.scopes.bot].sort(), ['app_mentions:read', 'chat:write', 'files:read', 'im:history', 'channels:history', 'groups:history'].sort());
  assert.ok(manifest.features.bot_user.display_name);
  assert.ok(manifest.display_information.name);
  assert.equal('request_url' in manifest.settings.event_subscriptions, false);
  assert.equal('interactivity' in manifest.settings, false);
  assert.equal(manifest.oauth_config.scopes.bot.includes('connections:write'), false);
  assert.equal(manifest.oauth_config.scopes.bot.includes('files:write'), false);
});

test('setup distinguishes two mandatory tokens from optional restrictions and unfinished uploads', async () => {
  const docs = await readFile(new URL('../docs/slack-gateway.md', import.meta.url), 'utf8');
  assert.match(docs, /two tokens are the only required Slack settings/);
  assert.match(docs, /Optional restrictions/);
  assert.match(docs, /connections:write/);
  assert.match(docs, /manifest deliberately excludes `files:write`/);
  for (const module of ['slack-gateway.mjs', 'slack-files.mjs', 'slack-upload.mjs']) assert.ok(docs.includes(module));
  assert.equal(docs.includes('Absent all four'), false);
});
