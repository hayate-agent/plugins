import { mkdir, open, readFile, lstat } from 'node:fs/promises';
import { randomBytes, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Store } from '../shared/store.mjs';

/** Same-UID trust boundary, not isolation from agent shell tools or the OS owner. */
export class LocalVault {
  #key;
  constructor(home) {
    this.directory = path.join(home, 'credentials');
    this.store = new Store(path.join(this.directory, 'vault.json'), { version: 1, entries: [] });
  }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) throw Error('Credential directory must be owned by the process user and mode 0700');
    const file = path.join(this.directory, 'key');
    try {
      const fd = await open(file, 'wx', 0o600);
      try { await fd.writeFile(randomBytes(32)); await fd.sync(); } finally { await fd.close(); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || metadata.nlink !== 1 || (metadata.mode & 0o077)) throw Error('Credential key must be a private regular file');
    this.#key = await readFile(file);
    if (this.#key.length !== 32) throw Error('Invalid credential encryption key');
    await this.store.load();
  }
  list(owner) {
    if (!owner) throw Error('Credential principal required');
    return this.store.read().entries.filter(e => e.owner === owner).map(({ sealed, ...metadata }) => metadata);
  }
  async put(owner, { label, kind = 'token', value, id }) {
    if (!owner || typeof label !== 'string' || !label.trim() || typeof value !== 'string' || !value || !['token', 'password', 'git', 'peer'].includes(kind)) throw Error('Invalid credential');
    const entryId = id ?? randomUUID(); const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([owner, entryId, kind])));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const entry = { id: entryId, owner, label: label.trim(), kind, updatedAt: Date.now(),
      sealed: { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') } };
    await this.store.change(data => {
      const index = data.entries.findIndex(e => e.id === entryId);
      if (index >= 0 && data.entries[index].owner !== owner) throw Error('Credential not found');
      if (index >= 0) data.entries[index] = entry; else data.entries.push(entry);
    });
    return this.list(owner).find(e => e.id === entryId);
  }
  /** Backend capability only. Never expose through HTTP, SSE, chat or model tools. */
  async withSecret(owner, id, consume) {
    const entry = this.store.read().entries.find(e => e.owner === owner && e.id === id);
    if (!entry) throw Error('Credential not found');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(entry.sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify([owner, entry.id, entry.kind])));
    decipher.setAuthTag(Buffer.from(entry.sealed.tag, 'base64'));
    const bytes = Buffer.concat([decipher.update(Buffer.from(entry.sealed.data, 'base64')), decipher.final()]);
    try { return await consume(bytes.toString('utf8')); } finally { bytes.fill(0); }
  }
  async remove(owner, id) { await this.store.change(data => { const index = data.entries.findIndex(e => e.owner === owner && e.id === id); if (index < 0) throw Error('Credential not found'); data.entries.splice(index, 1); }); }
  async stop() { await this.store.stop(); this.#key?.fill(0); }
}

/** Opt-in OpenBao KV-v2 provider. The host operator owns address, mount and token custody. */
export class OpenBaoVault {
  constructor({ address, mount, prefix, tokenFile, fetch: request = fetch }) {
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('OpenBao requires a canonical HTTPS origin');
    if (![mount, prefix].every(v => typeof v === 'string' && /^[a-zA-Z0-9_-]+$/.test(v))) throw Error('Invalid OpenBao mount/prefix');
    this.options = { address: url.origin, mount, prefix, tokenFile }; this.fetch = request;
  }
  async request(owner, id, method, body) {
    if (![owner, id].every(v => typeof v === 'string' && /^[a-zA-Z0-9_-]+$/.test(v))) throw Error('Invalid credential scope');
    const { address, mount, prefix, tokenFile } = this.options;
    const token = (await readFile(tokenFile, 'utf8')).trim();
    const response = await this.fetch(`${address}/v1/${mount}/data/${prefix}/${owner}/${id}`, {
      method, headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' }, redirect: 'error',
      body: body === undefined ? undefined : JSON.stringify({ data: body }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error('OpenBao operation failed');
    return method === 'GET' ? (await response.json()).data.data : undefined;
  }
  async put(owner, input) {
    const id = input.id ?? randomUUID();
    if (typeof input.label !== 'string' || typeof input.value !== 'string' || !input.value) throw Error('Invalid credential');
    await this.request(owner, id, 'POST', input);
    return { id, label: input.label, kind: input.kind ?? 'token' };
  }
  async withSecret(owner, id, consume) { const value = await this.request(owner, id, 'GET'); return consume(value.value); }
  async remove(owner, id) { await this.request(owner, id, 'DELETE'); }
}
