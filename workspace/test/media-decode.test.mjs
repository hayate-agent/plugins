import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('the workspace plugin loads without sharp and disables image uploads', () => {
 const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
 const copy = mkdtempSync(path.join(os.tmpdir(), 'workspace-nosharp-'));
 try {
  // Same repository layout (workspace + sibling shared modules), without any node_modules.
  for (const dir of ['workspace', 'shared']) cpSync(path.join(path.dirname(source), dir), path.join(copy, dir), { recursive: true, filter: file => !file.includes('node_modules') });
  writeFileSync(path.join(copy, 'workspace', 'probe.mjs'), `import plugin from './index.mjs'; import { loadDecoder, verifyDecodedImage } from './media-decode.mjs';
   console.log(JSON.stringify({ plugin: typeof plugin.activate, decoder: await loadDecoder(), error: await verifyDecodedImage({ data: '', mimeType: 'image/png' }).then(() => null, e => e.message) }));`);
  const run = spawnSync(process.execPath, ['probe.mjs'], { cwd: path.join(copy, 'workspace'), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { plugin: 'function', decoder: null, error: 'Image decoding is unavailable on this host' });
 } finally { rmSync(copy, { recursive: true, force: true }); }
});
