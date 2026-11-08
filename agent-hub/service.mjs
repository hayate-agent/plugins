import { randomBytes, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { Store } from '../shared/store.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const color = value => value === undefined || typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value);
const label = value => typeof value === 'string' && !!value.trim() && value.length <= 160;
const endpointURL = value => {
  if (typeof value !== 'string' || value.length > 2048) throw Error('Invalid agent endpoint');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw Error('Agent endpoint must not contain credentials, query or fragment');
  return url.href;
};

/** Capability-based agent grouping, independent of the browser and any one runtime. */
export class AgentHub {
  #adapters = new Map(); #pending = new Set(); #closed = false; #connecting = new Set(); #removing = new Set();
  constructor({ home, credentials, pairingLifetimeMs = 300000, foregroundWork = work => work() }) {
    if (!credentials?.withSecret || !credentials.put || !Number.isSafeInteger(pairingLifetimeMs) || pairingLifetimeMs < 1000) throw Error('Credential service and pairing lifetime required');
    this.credentials = credentials; this.pairingLifetimeMs = pairingLifetimeMs; this.foregroundWork = foregroundWork;
    this.store = new Store(path.join(home, 'agent-hub/state.json'), { version: 1, agents: [], codes: [] });
  }
  async open() { await this.store.load(); }
  registerAdapter(name, adapter) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || this.#adapters.has(name) || ['pair', 'request'].some(k => typeof adapter?.[k] !== 'function')) throw Error('Invalid or duplicate agent adapter');
    this.#adapters.set(name, adapter);
  }
  list(owner) {
    if (!owner) throw Error('Agent principal required');
    return this.store.read().agents.filter(a => a.owner === owner).map(({ credential, owner, ...value }) => value);
  }
  adapters() { return [...this.#adapters.keys()]; }
  issueCode(owner, input) { return this.#owned(() => this.#issueCode(owner, input)); }
  async #issueCode(owner, { name, capabilities }) {
    if (!owner || typeof name !== 'string' || !name.trim() || !Array.isArray(capabilities) || capabilities.some(c => !['projects', 'streams', 'messages', 'activity'].includes(c))) throw Error('Invalid pairing scope');
    const code = randomBytes(24).toString('base64url'); const expiresAt = Date.now() + this.pairingLifetimeMs;
    await this.store.change(data => { data.codes = data.codes.filter(c => c.expiresAt > Date.now()); data.codes.push({ owner, digest: hash(code), name, capabilities: [...new Set(capabilities)], expiresAt }); });
    return { code, expiresAt, capabilities: [...new Set(capabilities)] };
  }
  consumeCode(code) { return this.#owned(() => this.#consumeCode(code)); }
  async #consumeCode(code) {
    if (typeof code !== 'string' || !code) throw Error('Invalid or expired pairing code');
    const digest = hash(code);
    return this.store.change(data => {
      const index = data.codes.findIndex(c => timingSafeEqual(Buffer.from(c.digest, 'hex'), Buffer.from(digest, 'hex')) && c.expiresAt > Date.now());
      if (index < 0) throw Error('Invalid or expired pairing code');
      const [entry] = data.codes.splice(index, 1);
      return { owner: entry.owner, name: entry.name, capabilities: entry.capabilities };
    });
  }
  #owned(work) {
    if (this.#closed) return Promise.reject(Error('Agent hub stopping'));
    const operation = this.foregroundWork(work);
    this.#pending.add(operation);
    void operation.then(() => this.#pending.delete(operation), () => this.#pending.delete(operation));
    return operation;
  }
  connect(owner, input) { return this.#owned(() => this.#connect(owner, input)); }
  async #connect(owner, { adapter: adapterId, endpoint, code, name, color: selectedColor }) {
    if (this.#closed) throw Error('Agent hub stopping');
    const adapter = this.#adapters.get(adapterId);
    if (!label(owner) || !adapter || !color(selectedColor) || !label(name) || typeof code !== 'string' || !code || code.length > 1024) throw Error('Invalid agent registration');
    endpoint = endpointURL(endpoint);
    const key = JSON.stringify([owner, adapterId, endpoint]);
    if (this.#connecting.has(key) || this.list(owner).some(a => a.adapter === adapterId && endpointURL(a.endpoint) === endpoint)) throw Error('This agent endpoint is already registered or registration is in progress');
    this.#connecting.add(key);
    let paired, credential;
    try {
      // Adapter owns transport trust, TLS and pairing protocol.
      paired = await adapter.pair({ endpoint, code, owner });
      if (!paired || typeof paired.token !== 'string' || !paired.token || !Array.isArray(paired.capabilities) || paired.capabilities.some(c => !['projects', 'streams', 'messages', 'activity'].includes(c)) || !label(paired.agent)) throw Error('Invalid adapter pairing response');
      const id = randomUUID();
      credential = await this.credentials.put(owner, { kind: 'peer', label: `Agent ${name.trim()}`, value: paired.token });
      const agent = { id, owner, adapter: adapterId, endpoint: endpointURL(paired.endpoint ?? endpoint), name: name.trim(), color: selectedColor,
        remoteAgent: paired.agent, capabilities: [...new Set(paired.capabilities)], credential: credential.id, createdAt: Date.now() };
      await this.store.change(data => { data.agents.push(agent); });
      return this.list(owner).find(a => a.id === id);
    } catch (error) {
      let revoked = !paired?.token;
      if (paired?.token && adapter.revoke) { try { await adapter.revoke({ endpoint: paired.endpoint ?? endpoint, token: paired.token }); revoked = true; } catch { /* Target must reconcile its authorization. */ } }
      if (credential && revoked) await this.credentials.remove(owner, credential.id);
      if (!revoked) throw Error('Registration failed and target authorization could not be revoked. Revoke it on the target before pairing again.');
      throw error;
    } finally { this.#connecting.delete(key); }
  }
  update(owner, id, patch) { return this.#owned(() => this.#update(owner, id, patch)); }
  async #update(owner, id, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !['name', 'color'].includes(k)) || patch.color !== null && !color(patch.color)) throw Error('Invalid agent presentation');
    await this.store.change(data => {
      const agent = data.agents.find(a => a.owner === owner && a.id === id); if (!agent) throw Error('Agent not found');
      if (patch.name !== undefined) { if (!label(patch.name)) throw Error('Name required'); agent.name = patch.name.trim(); }
      if (Object.hasOwn(patch, 'color')) { if (patch.color === null) delete agent.color; else agent.color = patch.color; }
    });
  }
  request(owner, id, capability, input, signal) {
    if (this.#closed) return Promise.reject(Error('Agent hub stopping'));
    const agent = this.store.read().agents.find(a => a.owner === owner && a.id === id);
    if (this.#removing.has(id) || agent?.authorizationRevoked) return Promise.reject(Error('Agent removal is in progress or target authorization was revoked'));
    if (!agent || !agent.capabilities.includes(capability)) return Promise.reject(Error('Agent/capability unavailable'));
    const adapter = this.#adapters.get(agent.adapter);
    if (!adapter) return Promise.reject(Error('The configured adapter is not installed'));
    // No automatic retry: a disconnected productive request has unknown outcome.
    return this.#owned(() => this.credentials.withSecret(owner, agent.credential, token => adapter.request({ endpoint: agent.endpoint, token, capability, input, signal })));
  }
  check(owner, id) { return this.#owned(async () => {
    const agent = this.list(owner).find(agent => agent.id === id); if (!agent) throw Error('Agent not found');
    const capability = ['activity', 'streams', 'projects'].find(value => agent.capabilities.includes(value));
    let status = capability ? 'unavailable' : 'unsupported';
    if (capability) {
      try { const response = await this.request(owner, id, capability, { action: 'list' }, AbortSignal.timeout(10000));
        if (!Array.isArray(response?.[capability === 'projects' ? 'projects' : 'streams'])) throw Error('Invalid probe response');
        status = 'connected';
      } catch { /* Never project transport diagnostics or secret-bearing errors. */ }
    }
    const result = { status, checkedAt: Date.now(), capability: capability ?? null };
    await this.store.change(data => { const current = data.agents.find(a => a.owner === owner && a.id === id); if (current && !this.#removing.has(id)) current.connection = result; });
    return result;
  }); }
  remove(owner, id) { return this.#owned(() => this.#remove(owner, id)); }
  async #remove(owner, id) {
    const agent = this.store.read().agents.find(a => a.owner === owner && a.id === id); if (!agent) throw Error('Agent not found');
    const adapter = this.#adapters.get(agent.adapter);
    if (!agent.authorizationRevoked && !adapter?.revoke) throw Error('This adapter cannot revoke target authorization; removal is unavailable');
    if (this.#removing.has(id)) throw Error('Agent removal is already in progress');
    this.#removing.add(id);
    try {
      // Revoke remotely first; failed revoke retains registration for retry.
      if (!agent.authorizationRevoked) {
        await this.credentials.withSecret(owner, agent.credential, token => adapter.revoke({ endpoint: agent.endpoint, token }));
        await this.store.change(data => { const current = data.agents.find(a => a.owner === owner && a.id === id); if (current) current.authorizationRevoked = true; });
      }
      await this.credentials.remove(owner, agent.credential);
      await this.store.change(data => { data.agents = data.agents.filter(a => !(a.owner === owner && a.id === id)); });
    } finally { this.#removing.delete(id); }
  }
  projectDashboard(owner, projectId, signal) { return this.#owned(() => this.#projectDashboard(owner, projectId, signal)); }
  async #projectDashboard(owner, projectId, signal) {
    if (typeof projectId !== 'string' || !projectId) throw Error('Project ID required');
    const agents = this.list(owner); const results = new Array(agents.length); let next = 0;
    const deadline = AbortSignal.timeout(10000);
    const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const worker = async () => {
      while (next < agents.length) {
        const index = next++; const agent = agents[index];
        const entry = { agentId: agent.id, name: agent.name, color: agent.color, streams: [] };
        if (!['projects', 'streams'].every(capability => agent.capabilities.includes(capability))) { results[index] = { ...entry, status: 'unsupported' }; continue; }
        try {
          const mapping = await this.request(owner, agent.id, 'projects', { action: 'resolve', projectId }, cancellation);
          if (typeof mapping.projectId !== 'string') { results[index] = { ...entry, status: 'not-shared' }; continue; }
          const snapshot = await this.request(owner, agent.id, 'streams', { action: 'list', projectId: mapping.projectId }, cancellation);
          if (!Array.isArray(snapshot.streams) || snapshot.streams.some(stream => typeof stream.id !== 'string' || stream.projectId !== mapping.projectId)) throw Error('Invalid scoped remote snapshot');
          results[index] = { ...entry, status: 'connected', projectId: mapping.projectId, features: Array.isArray(mapping.features) ? mapping.features.filter(feature => ['idempotent-stream-create', 'read-markers'].includes(feature)) : [], streams: snapshot.streams };
        } catch { results[index] = { ...entry, status: 'unavailable', error: 'Could not refresh target; no productive request was retried' }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, agents.length) }, worker));
    return { agents: results, refreshedAt: Date.now() };
  }
  async syncProject(owner, project, signal) {
    return Promise.all(this.list(owner).filter(a => a.capabilities.includes('projects')).map(async agent => {
      try { return { agent: agent.id, ok: true, receipt: await this.request(owner, agent.id, 'projects', { action: 'apply', project }, signal) }; }
      catch { return { agent: agent.id, ok: false, error: 'Agent unavailable or project synchronization failed; reconcile before productive work' }; }
    }));
  }
  async stop() { this.#closed = true; await Promise.allSettled([...this.#pending]); await this.store.stop(); }
}
