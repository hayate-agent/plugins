import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { Store } from '../shared/store.mjs';
import { HayateAdapter, canonicalOrigin } from './transport.mjs';
import { workspaceRequest, CAPABILITIES } from './workspace-protocol.mjs';
import { WebSocket } from './vendor/websocket.mjs';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Agent-originated connection. Reconnects the channel, never productive requests. */
export class OutboundAgentLink {
  #socket; #timer; #closing = false; #work = new Set(); #active = new Set(); #seen = new Set(); #stop; #delay; #connecting; #blocked = false; #enrolling = false;
  constructor({ home, agent, workspace, credentials, config, foregroundWork = work => work(), reconnectMinMs = 500, reconnectMaxMs = 30000 }) {
    if (typeof agent !== 'string' || !agent || !workspace || !credentials?.withSecret || !Array.isArray(config?.capabilities) || config.capabilities.some(c => !CAPABILITIES.includes(c)) || !config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects) || Object.values(config.projects).some(v => typeof v !== 'string')) throw Error('Explicit outbound agent identity, services and local capability/project policy required');
    if (!Number.isSafeInteger(reconnectMinMs) || reconnectMinMs < 25 || !Number.isSafeInteger(reconnectMaxMs) || reconnectMaxMs < reconnectMinMs || reconnectMaxMs > 60000) throw Error('Invalid reconnect limits');
    this.agent = agent; this.workspace = workspace; this.credentials = credentials; this.config = config; this.foregroundWork = foregroundWork;
    this.minDelay = reconnectMinMs; this.maxDelay = reconnectMaxMs; this.#delay = reconnectMinMs;
    this.store = new Store(path.join(home, 'agent-link-outbound/state.json'), { version: 1, connection: null });
    this.policy = new Map((config.relays ?? []).map(peer => [canonicalOrigin(peer.origin), peer]));
  }
  #owned(work) {
    if (this.#closing) return Promise.reject(Error('Outbound AgentLink stopping'));
    const operation = this.foregroundWork(work); this.#work.add(operation);
    void operation.then(() => this.#work.delete(operation), () => this.#work.delete(operation)); return operation;
  }
  #policy(origin) { const policy = this.policy.get(origin); if (!policy && this.config.allowOperatorRelays !== true) throw Error('Relay is not in the operator allowlist'); return policy ?? {}; }
  #transport(origin) { const policy = this.#policy(origin); return new HayateAdapter([{ origin, ...(policy.caFile ? { caFile: policy.caFile } : {}) }]); }
  async open() { await this.store.load(); if (this.store.read().connection && !this.store.read().connection.revoked && !this.store.read().connection.disconnectPending) this.#connect(); }
  status() { const connection = this.store.read().connection; return connection ? { endpoint: connection.endpoint, id: connection.id, capabilities: connection.capabilities, expiresAt: connection.expiresAt, connected: this.#socket?.readyState === 1, revoked: !!connection.revoked, activeRequests: this.#active.size } : { connected: false, configured: false }; }
  enroll(endpoint, code) { return this.#owned(async () => {
    if (this.#enrolling || this.store.read().connection) throw Error('An outbound connection is already configured or enrollment is in progress');
    this.#enrolling = true;
    try {
    const origin = canonicalOrigin(endpoint), transport = this.#transport(origin);
    const paired = await transport.call(origin, '/api/agent-link/v1/enroll', { code, agent: this.agent, capabilities: this.config.capabilities });
    if (paired.protocol !== 1 || paired.endpoint !== origin || !UUID.test(paired.id) || !/^[A-Za-z0-9_-]{43}$/.test(paired.token) || !Array.isArray(paired.capabilities) || paired.capabilities.some(capability => !this.config.capabilities.includes(capability)) || !Number.isSafeInteger(paired.expiresAt) || paired.expiresAt <= Date.now()) throw Error('Invalid relay enrollment response');
    let credential;
    try {
      credential = await this.credentials.put('operator', { kind: 'peer', label: 'Outbound AgentLink relay', value: paired.token });
      await this.store.change(data => { if (data.connection) throw Error('Outbound enrollment already completed'); data.connection = { endpoint: origin, id: paired.id, capabilities: paired.capabilities, credential: credential.id, expiresAt: paired.expiresAt }; });
    } catch (error) {
      let revoked = false;
      try { await transport.call(origin, '/api/agent-link/v1/leave', { id: paired.id }, paired.token); revoked = true; } catch { /* Incoming record must be reconciled on the relay. */ }
      if (credential && revoked) await this.credentials.remove('operator', credential.id);
      throw Error('Outbound enrollment failed; reconcile the incoming connection before retrying', { cause: error });
    }
    this.#blocked = false; this.#connect(); return this.status();
    } finally { this.#enrolling = false; }
  }); }
  disconnect() { return this.#owned(async () => {
    const connection = this.store.read().connection; if (!connection) return;
    this.#blocked = true; clearTimeout(this.#timer); this.#socket?.terminate();
    await this.store.change(data => { if (data.connection?.id === connection.id) data.connection.disconnectPending = true; });
    if (!connection.revoked) await this.credentials.withSecret('operator', connection.credential, token => this.#transport(connection.endpoint).call(connection.endpoint, '/api/agent-link/v1/leave', { id: connection.id }, token));
    this.#socket?.terminate();
    await this.store.change(data => { if (data.connection?.id === connection.id) data.connection.revoked = true; });
    await this.credentials.remove('operator', connection.credential);
    await this.store.change(data => { if (data.connection?.id === connection.id) data.connection = null; });
  }); }
  #schedule() {
    if (this.#closing || this.#blocked || this.#timer || !this.store.read().connection) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; this.#connect(); }, this.#delay);
    this.#delay = Math.min(this.maxDelay, this.#delay * 2);
  }
  #connect() {
    if (this.#closing || this.#blocked || this.#connecting || this.#socket && this.#socket.readyState < 2) return;
    const connection = this.store.read().connection;
    if (!connection || connection.revoked || connection.disconnectPending || connection.expiresAt <= Date.now()) return;
    // Opening an idle connection does not reserve host productive work. Stop
    // nevertheless awaits this bounded handshake setup and destroys its socket.
    const work = (async () => {
      const policy = this.#policy(connection.endpoint), ca = policy.caFile ? await readFile(policy.caFile) : undefined;
      await this.credentials.withSecret('operator', connection.credential, token => {
        if (this.#closing || this.#blocked) return;
        const socket = new WebSocket(connection.endpoint.replace(/^https:/, 'wss:') + '/api/agent-link/v1/connect', 'hayate.agent-link.v1', {
          headers: { Authorization: 'Bearer ' + token, 'X-Hayate-Agent-ID': connection.id }, ca, handshakeTimeout: 10000,
          maxPayload: 262144, perMessageDeflate: false, followRedirects: false,
        });
        this.#socket = socket;
        socket.on('open', () => { if (this.#closing || this.#socket !== socket) { socket.terminate(); return; } this.#delay = this.minDelay; this.#seen.clear(); });
        socket.on('error', () => {});
        socket.on('unexpected-response', (_request, response) => { response.resume(); if ([401, 403].includes(response.statusCode)) this.#invalidate(connection.id); socket.terminate(); });
        socket.on('close', code => { if (this.#socket !== socket) return; this.#socket = undefined; if (code === 4003) this.#invalidate(connection.id); this.#schedule(); });
        socket.on('message', (bytes, binary) => {
          if (this.#closing || this.#blocked || this.#socket !== socket || binary || this.#active.size >= 16) { socket.close(1008, 'Unavailable'); return; }
          let frame;
          try {
            frame = JSON.parse(bytes.toString('utf8'));
            if (frame.type !== 'request' || !UUID.test(frame.id) || this.#seen.has(frame.id) || this.#active.has(frame.id) || !connection.capabilities.includes(frame.capability) || !this.config.capabilities.includes(frame.capability) || !frame.input || typeof frame.input !== 'object') throw Error();
            if (frame.capability === 'streams' && frame.input.action === 'create' && !UUID.test(frame.input.idempotencyKey)) throw Error();
          } catch { socket.close(1008, 'Invalid scoped request'); return; }
          this.#seen.add(frame.id); if (this.#seen.size > 1024) this.#seen.delete(this.#seen.values().next().value);
          this.#active.add(frame.id);
          void this.#owned(async () => {
            let response;
            try { response = { type: 'response', id: frame.id, ok: true, result: await workspaceRequest(this.workspace, this.config, 'operator', frame.capability, frame.input) }; }
            catch { response = { type: 'response', id: frame.id, ok: false }; }
            const serialized = JSON.stringify(response);
            if (Buffer.byteLength(serialized) > 250000 || socket.bufferedAmount > 500000) { socket.close(1009, 'Response limit'); return; }
            if (this.#socket === socket && socket.readyState === 1) socket.send(serialized, () => {});
          }).catch(() => { if (socket.readyState === 1) socket.close(1013, 'Host unavailable'); }).finally(() => this.#active.delete(frame.id));
        });
      });
    })();
    this.#connecting = work;
    void work.catch(() => this.#schedule()).finally(() => { this.#connecting = undefined; });
  }
  #invalidate(id) {
    this.#blocked = true; clearTimeout(this.#timer);
    void this.#owned(() => this.store.change(data => { if (data.connection?.id === id) data.connection.revoked = true; })).catch(() => {});
  }
  stop() { return this.#stop ??= (async () => {
    this.#closing = true; clearTimeout(this.#timer);
    const socket = this.#socket;
    const closed = socket && socket.readyState !== 3 ? new Promise(resolve => socket.once('close', resolve)) : Promise.resolve();
    socket?.terminate();
    await this.#connecting?.catch(() => {});
    await Promise.allSettled([...this.#work]); await closed; await this.store.stop();
  })(); }
}
