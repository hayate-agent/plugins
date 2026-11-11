import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Session-scoped, content-addressed file transfer. Unknown effects stop rather than replay. */
export class SlackUploader {
  constructor({ root, api, fetch = globalThis.fetch, maxBytes = 10 * 1024 * 1024 }) {
    this.root = root; this.api = api; this.fetch = fetch; this.maxBytes = maxBytes;
    this.active = new Set();
  }
  async save(file, state) {
    const temp = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(state)); await handle.sync(); await handle.close(); handle = undefined;
      await rename(temp, file);
      const dir = await open(path.dirname(file), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await handle?.close(); await rm(temp, { force: true }); }
  }
  async send({ sessionKey, to, reference, deliveryId, caption = '', scopedSend = false }) {
    if (!deliveryId || typeof deliveryId !== 'string' || !sessionKey || reference.sessionKey !== sessionKey ||
      !/^[a-f0-9]{64}$/.test(reference.sha256) || !Number.isSafeInteger(reference.size) ||
      reference.size < 0 || reference.size > this.maxBytes || typeof reference.name !== 'string' ||
      typeof sessionKey !== 'string' || sessionKey.length > 2000 || typeof caption !== 'string' || caption.length > 39000 ||
      to.channel !== 'slack' || !/^[CGD][A-Z0-9]+$/.test(to.target ?? '') ||
      (to.thread !== undefined && !/^\d+\.\d+$/.test(to.thread))) {
      throw Error('Invalid scoped Slack upload');
    }
    if (!scopedSend && (sessionKey.split(':')[2] !== to.target ||
        (sessionKey.split(':')[3] !== (to.thread ?? 'dm') && sessionKey.split(':')[3] !== 'channel'))) throw Error('Invalid scoped Slack upload');
    const owner = createHash('sha256').update(sessionKey).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify([sessionKey, deliveryId])).digest('hex');
    if (this.active.has(fingerprint)) throw Error('Slack upload already in progress');
    this.active.add(fingerprint);
    try {
      const directory = path.join(this.root, owner);
      const handle = await open(path.join(directory, reference.sha256), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== reference.size) throw Error('Upload file size mismatch');
        bytes = Buffer.alloc(reference.size);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!result.bytesRead) throw Error('Upload file truncated');
          offset += result.bytesRead;
        }
      } finally { await handle.close(); }
      if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw Error('Upload integrity failure');
      const ledgerDir = path.join(directory, 'uploads');
      await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
      const ledger = path.join(ledgerDir, `${fingerprint}.json`);
      const identity = JSON.stringify([reference.sha256, reference.size, reference.name]);
      let state;
      try { state = JSON.parse(await readFile(ledger, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (state && state.identity !== identity) throw Error('Upload delivery ID reused with different content');
      const destination = createHash('sha256').update(JSON.stringify([to.target, to.thread ?? null, caption])).digest('hex');
      if (state?.destination !== undefined && state.destination !== destination) throw Error('Upload delivery ID reused with different destination or caption');
      if (state && state.destination === undefined && (sessionKey.split(':')[2] !== to.target || sessionKey.split(':')[3] !== to.thread || caption))
        throw Error('Legacy upload destination mismatch');
      if (state?.stage === 'complete') return { fileId: state.fileId };
      if (state && state.stage !== 'allocated') throw Error('Slack upload outcome uncertain; reconcile existing file before retry');
      if (!state) {
        state = { identity, destination, stage: 'allocating' };
        await this.save(ledger, state);
        const allocation = await this.api('files.getUploadURLExternal', { filename: path.basename(reference.name).slice(0, 255), length: bytes.length });
        const url = new URL(allocation.upload_url);
        if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.port || url.username || url.password ||
          !/^F[A-Z0-9]+$/.test(allocation.file_id)) throw Error('Invalid Slack upload allocation');
        state = { identity, destination, stage: 'allocated', fileId: allocation.file_id, url: url.toString() };
        await this.save(ledger, state);
      }
      // The signed URL is a credential: private ledger only, no token/header forwarding.
      const url = new URL(state.url);
      if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.port || url.username || url.password) throw Error('Invalid saved upload URL');
      state.stage = 'transferring'; await this.save(ledger, state);
      const response = await this.fetch(url.toString(), { method: 'POST', body: bytes,
        headers: { 'Content-Type': 'application/octet-stream' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Error('Slack binary upload failed; reconcile before retry');
      state.stage = 'completing'; await this.save(ledger, state);
      await this.api('files.completeUploadExternal', { files: [{ id: state.fileId, title: reference.name.slice(0, 255) }], channel_id: to.target,
        ...(to.thread ? { thread_ts: to.thread } : {}), ...(caption ? { initial_comment: caption } : {}) });
      state.stage = 'complete'; delete state.url; await this.save(ledger, state);
      return { fileId: state.fileId };
    } finally { this.active.delete(fingerprint); }
  }
}
