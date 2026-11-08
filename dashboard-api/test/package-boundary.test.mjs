import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
test('Plugins contains only the dashboard API, never the WebUI frontend or browser build', async () => {
  await assert.rejects(access(path.join(root, '../webui')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, 'public')), { code: 'ENOENT' });
  const files = await readdir(root, { recursive: true });
  assert.equal(files.some(file => /\.(?:html|css)$/.test(file) || /(?:^|\/)public(?:\/|$)/.test(file)), false);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.build, undefined);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), []);
});
