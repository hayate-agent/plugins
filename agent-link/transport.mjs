import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
export function canonicalOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Canonical HTTPS peer origin required');
  return url.origin;
}
/** Explicit trust policy; no redirects, browser credentials or caller-selected TLS policy. */
export class HayateAdapter {
  constructor(peers, { allowOperatorTargets = false } = {}) {
    if (typeof allowOperatorTargets !== 'boolean') throw Error('Invalid operator target policy');
    this.allowOperatorTargets = allowOperatorTargets;
    this.peers = new Map(peers.map(peer => [canonicalOrigin(peer.origin), peer]));
    if (this.peers.size !== peers.length) throw Error('Duplicate peer origin');
  }
  async call(endpoint, route, input, token, signal) {
    const origin = canonicalOrigin(endpoint); const peer = this.peers.get(origin) ?? (this.allowOperatorTargets ? {} : undefined);
    if (!peer) throw Error('Peer is not in the operator allowlist');
    const ca = peer.caFile ? await readFile(peer.caFile) : undefined;
    const body = JSON.stringify(input);
    return new Promise((resolve, reject) => {
      const req = request(origin + route, { method: 'POST', ca, signal, agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > 1000000) res.destroy(Error('Peer response exceeds transport limit')); else chunks.push(chunk); });
        res.on('error', () => reject(Error('Peer response interrupted; reconcile before retry')));
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(Error('Peer request refused; reconcile before retry')); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Error('Invalid peer response')); }
        });
      });
      const timeout = setTimeout(() => req.destroy(), 15000);
      req.once('close', () => clearTimeout(timeout));
      req.on('error', () => reject(Error('Peer request failed; outcome may be unknown, reconcile before retry')));
      req.end(body);
    });
  }
  async pair({ endpoint, code }) {
    const result = await this.call(endpoint, '/v1/pair', { code });
    if (result.protocol !== 1 || result.endpoint !== canonicalOrigin(endpoint) || typeof result.agent !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.token) || !Array.isArray(result.capabilities) || result.capabilities.some(c => !['projects', 'streams', 'messages', 'activity'].includes(c))) throw Error('Incompatible peer protocol or identity');
    return result;
  }
  request({ endpoint, token, capability, input, signal }) { return this.call(endpoint, '/v1/request', { capability, input }, token, signal); }
  revoke({ endpoint, token }) { return this.call(endpoint, '/v1/revoke', {}, token); }
}
