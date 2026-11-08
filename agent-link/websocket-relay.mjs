import { createServer } from 'node:https';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { Store } from '../shared/store.mjs';
import { canonicalOrigin } from './transport.mjs';
import { CAPABILITIES } from './workspace-protocol.mjs';
import { WebSocketServer } from './vendor/websocket.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const refused = () => Error('AgentLink relay authorization refused');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const scope = values => Array.isArray(values) && values.length <= 4 && values.every(value => CAPABILITIES.includes(value));

/** Outbound WSS rendezvous. Idle sockets are not foreground work; RPC/changes are. */
export class AgentRelay {
  #server; #wss; #timer; #closing = false; #sessions = new Map(); #pending = new Map(); #work = new Set(); #sockets = new Set(); #rates = new Map(); #accepting = new Set(); #stop;
  constructor({ home, origin, host, port, tls, foregroundWork = work => work(), requestTimeoutMs = 15000, heartbeatMs = 20000 }) {
    this.origin = canonicalOrigin(origin); this.host = host; this.port = port; this.tls = tls; this.foregroundWork = foregroundWork;
    port ??= Number(new URL(this.origin).port || 443); this.port = port;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 60000 || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 50) throw Error('Invalid relay listener/limits');
    this.timeout = requestTimeoutMs; this.heartbeat = heartbeatMs;
    this.store = new Store(path.join(home, 'agent-link-relay/state.json'), { version: 1, invitations: [], agents: [] });
    this.adapter = { pair: input => this.#owned(() => this.#pair(input)), request: input => this.request(input), revoke: input => this.#owned(() => this.#revoke(input)) };
  }
  #owned(work) {
    if (this.#closing) return Promise.reject(Error('AgentLink relay stopping'));
    const task = this.foregroundWork(work); this.#work.add(task);
    void task.then(() => this.#work.delete(task), () => this.#work.delete(task)); return task;
  }
  invite(owner, { name, capabilities = CAPABILITIES, color } = {}) { return this.#owned(async () => {
    if (typeof owner !== 'string' || !owner || typeof name !== 'string' || !name.trim() || name.length > 160 || !scope(capabilities) || color !== undefined && !/^#[a-f0-9]{6}$/i.test(color)) throw Error('Invalid outbound invitation');
    const code = secret(), expiresAt = Date.now() + 300000;
    await this.store.change(data => { data.invitations = data.invitations.filter(value => value.expiresAt > Date.now()); if (data.invitations.length >= 64) throw Error('Too many pending invitations'); data.invitations.push({ owner, name: name.trim(), color, capabilities: [...new Set(capabilities)], digest: digest(code), expiresAt }); });
    return { code, expiresAt, endpoint: this.origin, transport: 'hayate-wss' };
  }); }
  list(owner) {
    if (typeof owner !== 'string' || !owner) throw refused();
    return this.store.read().agents.filter(agent => agent.owner === owner).map(({ clientDigest, hubDigest, approvalDigest, owner, ...agent }) => ({ ...agent, connected: this.#sessions.has(agent.id) }));
  }
  #record(id) { return this.store.read().agents.find(agent => agent.id === id); }
  #client(id, token) { const agent = this.#record(id); return agent && !agent.revoked && agent.expiresAt > Date.now() && typeof token === 'string' && digest(token) === agent.clientDigest ? agent : null; }
  async #enroll({ code, agent, capabilities }) {
    if (typeof code !== 'string' || code.length > 1024 || typeof agent !== 'string' || !agent.trim() || agent.length > 160 || !scope(capabilities)) throw refused();
    const token = secret(), id = randomUUID();
    const created = await this.store.change(data => {
      const index = data.invitations.findIndex(invite => invite.digest === digest(code) && invite.expiresAt > Date.now()); if (index < 0) throw refused();
      const [invite] = data.invitations.splice(index, 1);
      if (data.agents.length >= 256) throw Error('Relay registration limit reached');
      const value = { id, owner: invite.owner, name: invite.name, color: invite.color, remoteAgent: agent.trim(), capabilities: invite.capabilities.filter(value => capabilities.includes(value)), clientDigest: digest(token), createdAt: Date.now(), expiresAt: Date.now() + 30 * 86400000, approved: false, revoked: false };
      data.agents.push(value); return { id, capabilities: value.capabilities, expiresAt: value.expiresAt };
    });
    return { ...created, protocol: 1, token, endpoint: this.origin };
  }
  accept(owner, id, hub) { return this.#owned(async () => {
    const record = this.#record(id); if (!record || record.owner !== owner || record.approved || record.revoked || record.expiresAt <= Date.now() || this.#accepting.has(id)) throw refused();
    this.#accepting.add(id);
    try {
    const code = secret();
    await this.store.change(data => { const current = data.agents.find(agent => agent.id === id && agent.owner === owner); if (!current || current.approved || current.revoked) throw refused(); current.approvalDigest = digest(code); });
    return await hub.connect(owner, { adapter: 'hayate-wss', endpoint: this.origin + '/agents/' + id, code, name: record.name, color: record.color });
    } finally { this.#accepting.delete(id); }
  }); }
  async #pair({ endpoint, code, owner }) {
    const id = this.#id(endpoint), token = secret();
    if (typeof code !== 'string') throw refused();
    const record = await this.store.change(data => {
      const agent = data.agents.find(agent => agent.id === id);
      if (!agent || agent.owner !== owner || agent.revoked || agent.approved || agent.expiresAt <= Date.now() || agent.approvalDigest !== digest(code)) throw refused();
      agent.approved = true; agent.hubDigest = digest(token); delete agent.approvalDigest; return { agent: agent.remoteAgent, capabilities: agent.capabilities };
    });
    return { ...record, endpoint, token };
  }
  #id(endpoint) { const url = new URL(endpoint); if (url.origin !== this.origin || !/^\/agents\/[a-f0-9-]{36}$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw refused(); return url.pathname.split('/')[2]; }
  #hub(endpoint, token) { const id = this.#id(endpoint), agent = this.#record(id); if (!agent || typeof token !== 'string' || digest(token) !== agent.hubDigest) throw refused(); return agent; }
  async #revoke({ endpoint, token }) { const agent = this.#hub(endpoint, token); await this.reject(agent.owner, agent.id); return { revoked: true }; }
  reject(owner, id) { return this.#owned(async () => {
    await this.store.change(data => { const agent = data.agents.find(agent => agent.owner === owner && agent.id === id); if (!agent) throw refused(); agent.revoked = true; delete agent.approvalDigest; });
    this.#sessions.get(id)?.socket.close(4003, 'Authorization revoked'); this.#disconnect(id); return { revoked: true };
  }); }
  request({ endpoint, token, capability, input, signal }) { return this.#owned(async () => {
    const agent = this.#hub(endpoint, token);
    if (!agent.approved || agent.revoked || agent.expiresAt <= Date.now() || !agent.capabilities.includes(capability)) throw refused();
    if (signal?.aborted) throw Error('Request cancelled before send');
    const session = this.#sessions.get(agent.id);
    if (!session || session.socket.readyState !== 1) throw Error('Outbound agent disconnected; no work sent');
    if (this.#pending.size >= 128) throw Error('Relay request limit reached');
    const id = randomUUID(), frame = JSON.stringify({ type: 'request', id, capability, input });
    if (Buffer.byteLength(frame) > 250000 || session.socket.bufferedAmount > 500000) throw Error('Relay request/backpressure limit reached');
    return new Promise((resolve, reject) => {
      const abort = () => finish(Error('Wait cancelled; accepted work may continue. Reconcile before retry'));
      const finish = (error, result) => { const pending = this.#pending.get(id); if (!pending) return; this.#pending.delete(id); clearTimeout(pending.timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(result); };
      const timer = setTimeout(() => finish(Error('Agent response timed out; outcome unknown. No automatic retry')), this.timeout);
      this.#pending.set(id, { agentId: agent.id, session, timer, finish }); signal?.addEventListener('abort', abort, { once: true });
      session.socket.send(frame, error => { if (error) finish(Error('Agent send failed; outcome unknown. No automatic retry')); });
    });
  }); }
  #disconnect(id, session = this.#sessions.get(id)) {
    if (!session) return;
    if (this.#sessions.get(id) === session) this.#sessions.delete(id);
    for (const pending of [...this.#pending.values()]) if (pending.session === session) pending.finish(Error('Agent disconnected; outcome unknown. No automatic retry'));
  }
  async open({ listen = true } = {}) {
    if (this.#wss || this.#closing) throw Error('Relay already started or stopped');
    if (listen && (!this.tls?.key || !this.tls?.cert)) throw Error('Relay requires native TLS key and certificate');
    await this.store.load();
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: 262144, perMessageDeflate: false, handleProtocols: protocols => protocols.has('hayate.agent-link.v1') ? 'hayate.agent-link.v1' : false });
    if (listen) {
      this.#server = createServer({ ...this.tls, minVersion: 'TLSv1.2' }, (req, res) => { void this.handleRequest(req, res); });
      this.#server.on('connection', socket => { this.#sockets.add(socket); socket.once('close', () => this.#sockets.delete(socket)); });
      this.#server.requestTimeout = 15000; this.#server.headersTimeout = 10000; this.#server.maxConnections = 128;
      this.#server.on('upgrade', (req, socket, head) => { void this.handleUpgrade(req, socket, head); });
      await new Promise((resolve, reject) => { this.#server.once('error', reject); this.#server.listen(this.port, this.host, resolve); });
    }
    this.#timer = setInterval(() => { for (const [id, session] of this.#sessions) { if (!session.alive || !this.#client(id, session.token)) { session.socket.terminate(); this.#disconnect(id, session); } else { session.alive = false; session.socket.ping(); } } }, this.heartbeat);
  }
  handleRequest(req, res) {
    return this.#owned(async () => {
        if (req.headers.host !== new URL(this.origin).host || req.headers.origin || req.method !== 'POST' || !['/api/agent-link/v1/enroll', '/api/agent-link/v1/leave'].includes(req.url) || !req.headers['content-type']?.startsWith('application/json')) throw refused();
        const address = req.socket.remoteAddress; const rate = this.#rates.get(address) ?? { at: Date.now(), n: 0 };
        if (Date.now() - rate.at > 60000) { rate.at = Date.now(); rate.n = 0; }
        if (++rate.n > 10) throw refused(); if (this.#rates.size >= 1024 && !this.#rates.has(address)) this.#rates.delete(this.#rates.keys().next().value); this.#rates.set(address, rate);
        const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 8192) throw refused(); chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let result;
        if (req.url === '/api/agent-link/v1/leave') {
          const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
          const agent = this.#record(input.id);
          if (!agent || !token || agent.clientDigest !== digest(token)) throw refused();
          result = await this.reject(agent.owner, agent.id);
        } else result = await this.#enroll(input);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result));
    }).catch(() => { if (!res.headersSent) { res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":"Relay request refused"}'); } else res.destroy(); });
  }
  handleUpgrade(req, socket, head) {
    return this.#owned(async () => {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1], id = req.headers['x-hayate-agent-id'];
      if (this.#closing || req.headers.host !== new URL(this.origin).host || req.headers.origin || req.url !== '/api/agent-link/v1/connect' || typeof id !== 'string' || !this.#client(id, token) || req.headers['sec-websocket-protocol'] !== 'hayate.agent-link.v1') { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
      this.#wss.handleUpgrade(req, socket, head, ws => {
        if (!this.#client(id, token)) { ws.terminate(); return; }
        const previous = this.#sessions.get(id); if (previous) { this.#disconnect(id, previous); previous.socket.close(4001, 'Connection replaced'); }
        const session = { socket: ws, token, alive: true }; this.#sessions.set(id, session);
        ws.on('pong', () => { session.alive = true; }); ws.on('error', () => {});
        ws.on('close', () => this.#disconnect(id, session));
        ws.on('message', (bytes, binary) => {
          if (binary || !this.#client(id, token) || this.#sessions.get(id) !== session) { ws.close(4003); return; }
          try {
            const frame = JSON.parse(bytes.toString('utf8')), pending = this.#pending.get(frame.id);
            if (frame.type !== 'response' || !UUID.test(frame.id) || typeof frame.ok !== 'boolean') throw refused();
            if (!pending) return; // Late response to a timed-out/cancelled request is never replayed.
            if (pending.session !== session) throw refused();
            pending.finish(frame.ok ? null : Error('Target refused the scoped request'), frame.result);
          } catch { ws.close(1008, 'Invalid protocol'); }
        });
      });
    }).catch(() => socket.destroy());
  }
  stop() { return this.#stop ??= (async () => {
    this.#closing = true; clearInterval(this.#timer);
    for (const [id, session] of this.#sessions) { session.socket.terminate(); this.#disconnect(id, session); }
    const closed = this.#server ? new Promise(resolve => this.#server.close(resolve)) : Promise.resolve();
    for (const socket of this.#sockets) socket.destroy(); this.#wss?.close();
    await Promise.allSettled([...this.#work]); await closed; await this.store.stop();
  })(); }
}
