import { createHash } from 'node:crypto';
import { mkdir, readFile, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

// Download only Slack's private file endpoint. Never forward the bot token to redirects.
function privateUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.port || url.username || url.password) {
    throw Error('Untrusted Slack file URL');
  }
  return url.toString();
}
export function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return undefined;
}
export class SlackFiles {
  constructor({ root, botToken, maxBytes = 10 * 1024 * 1024, fetch = globalThis.fetch, info }) {
    this.root = root; this.botToken = botToken; this.maxBytes = maxBytes; this.fetch = fetch; this.info = info;
  }
  async metadata(file, signal) {
    if (!file || !/^F[A-Z0-9]+$/.test(file.id ?? '')) throw Error('Invalid Slack file ID');
    if (file.size === undefined || !(file.url_private_download ?? file.url_private)) {
      if (!this.info) throw Error('Slack file metadata is incomplete');
      signal?.throwIfAborted();
      const resolved = await this.info(file.id, signal);
      if (resolved?.id !== file.id) throw Error('Slack file metadata identity mismatch');
      return resolved;
    }
    return file;
  }
  async download(file, signal, sessionKey) {
    file = await this.metadata(file, signal);
    if (typeof sessionKey !== 'string' || !sessionKey) throw Error('Attachment session is required');
    const directory = path.join(this.root, createHash('sha256').update(sessionKey).digest('hex'));
    if (!file || typeof file.id !== 'string' || !/^F[A-Z0-9]+$/.test(file.id)) throw Error('Invalid Slack file ID');
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > this.maxBytes) throw Error('Slack file size exceeds limit');
    const response = await this.fetch(privateUrl(file.url_private_download ?? file.url_private), {
      headers: { Authorization: `Bearer ${this.botToken}` }, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    if (!response.ok || !response.body) throw Error('Slack file download failed');
    const header = response.headers.get('content-length');
    if (header && (!/^\d+$/.test(header) || Number(header) > this.maxBytes)) throw Error('Slack file size exceeds limit');
    const chunks = []; let size = 0;
    try {
      for await (const value of response.body) {
        size += value.byteLength;
        if (size > this.maxBytes) throw Error('Slack file size exceeds limit');
        chunks.push(Buffer.from(value));
      }
    } catch { throw Error('Slack file download incomplete or oversized'); }
    const bytes = Buffer.concat(chunks);
    if (size !== file.size) throw Error('Slack file size mismatch');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, sha256);
    // No upstream filename enters a local path. Exclusive temp, fsync, atomic rename.
    const temp = path.join(directory, `.${sha256}-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
      await rename(temp, target);
      const directoryHandle = await open(directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } finally { await handle?.close(); await rm(temp, { force: true }); }
    return { sessionKey, id: file.id, path: target, size, sha256, name: String(file.name ?? file.id).slice(0, 255), mimeType: imageType(bytes) ?? 'application/octet-stream' };
  }
  async read(reference, sessionKey) {
    if (!sessionKey || reference.sessionKey !== sessionKey) throw Error('Attachment session mismatch');
    if (!/^[a-f0-9]{64}$/.test(reference.sha256)) throw Error('Invalid attachment reference');
    const bytes = await readFile(path.join(this.root, createHash('sha256').update(sessionKey).digest('hex'), reference.sha256));
    if (bytes.length > this.maxBytes || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw Error('Attachment integrity failure');
    return bytes;
  }
}
