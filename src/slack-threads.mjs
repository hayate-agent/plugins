import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Persist only thread membership, never Slack message content or credentials. */
export class SlackThreads {
  constructor(root) { this.root = root; }
  file(key) { return path.join(this.root, createHash('sha256').update(key).digest('hex')); }
  async has(key) {
    try { return await readFile(this.file(key), 'utf8') === key; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async add(key) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = path.join(this.root, `.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(key); await handle.sync(); await handle.close(); handle = undefined;
      await rename(temp, this.file(key));
    } finally { await handle?.close(); await rm(temp, { force: true }); }
    const directory = await open(this.root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
