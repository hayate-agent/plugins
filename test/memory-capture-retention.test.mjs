import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, copyFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';

// Bundled adapters resolve Core contracts beside their materialized source.
const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-retention-'));
await copyFile(new URL('../src/memory-service.ts', import.meta.url), path.join(dir, 'memory-service.ts'));
await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
await writeFile(path.join(dir, 'durable.js'), 'export async function writeFileDurable() { throw Error("Unexpected disk write in provider-only test"); }');
const { MemoryService } = await import(pathToFileURL(path.join(dir, 'memory-service.ts')).href);
after(() => rm(dir, { recursive: true, force: true }));

const config = { enabled: true, autoCapture: true, autoRecall: true, recallLimit: 3 };
test('old automatic captures remain recallable and reported, without automatic expiry', async () => {
  const writes = [];
  const service = new MemoryService(config, () => {});
  service.provider = { async put(context, entry) { writes.push({ context, entry }); } };
  const recordedAt = Date.now() - 90 * 86400000;
  await service.capture({ sessionKey: 'one', id: 'old', text: 'Investigate failure', reply: 'Unverified diagnosis', outcome: 'failed', recordedAt });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].context.sessionKey, 'one');
  assert.equal('expiresAt' in writes[0].entry, false);
  assert.equal(writes[0].entry.reviewAfter, new Date(recordedAt + 7 * 86400000).toISOString());
  assert.match(writes[0].entry.text, /not verification/);
});

test('capture retry remains byte-identical and successful no-tool turns remain excluded', async () => {
  const writes = [];
  const service = new MemoryService(config, () => {});
  service.provider = { async put(context, entry) { writes.push(entry); } };
  const turn = { sessionKey: 'one', id: 'stable', text: 'Check', reply: 'Result', outcome: 'completed', tools: ['read'], recordedAt: 1000 };
  await service.capture(turn);
  await service.capture(turn);
  assert.deepEqual(writes[0], writes[1]);
  await service.capture({ ...turn, tools: [] });
  // Existing contract checks presence of tools, not count; omit it entirely.
  const { tools, ...withoutTools } = turn;
  const before = writes.length;
  await service.capture(withoutTools);
  assert.equal(writes.length, before);
});
