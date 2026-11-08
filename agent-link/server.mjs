import { createServer } from 'node:https';
import { readFile, open, constants } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isIP } from 'node:net';
import { Store } from '../shared/store.mjs';
import { canonicalOrigin } from './transport.mjs';
import { workspaceRequest } from './workspace-protocol.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const deny = () => Object.assign(Error('Peer request refused'), { status: 403 });

/** Headless target endpoint. Explicit local project mappings prevent remote cwd selection. */
export class AgentLink {
  #server; #sockets = new Set(); #pending = new Set(); #closing = false; #pairing = 0; #stopping;
  constructor({ home, agent, hub, workspace, config, foregroundWork = work => work() }) {
    this.agent = agent; this.hub = hub; this.workspace = workspace; this.config = config; this.foregroundWork = foregroundWork;
    this.origin = canonicalOrigin(config.origin);
    this.tokenLifetimeMs = config.tokenLifetimeMs ?? 30 * 86400000;
    if (!Number.isSafeInteger(this.tokenLifetimeMs) || this.tokenLifetimeMs < 1000 || this.tokenLifetimeMs > 365 * 86400000) throw Error('Invalid peer token lifetime');
    if (!isIP(config.host) || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects)) throw Error('Explicit bind IP, port and local project mappings required');
    if (Object.entries(config.projects).some(([source, target]) => !source || source.length > 200 || typeof target !== 'string' || !target)) throw Error('Invalid project mapping');
    this.store = new Store(path.join(home, 'agent-link/peers.json'), { version: 1, peers: [] });
  }
  async open() {
    if (this.#server || this.#closing) throw Error('Agent link already started or stopped');
    let projects = this.workspace.snapshot('operator').projects;
    if (this.config.defaultProject) {
      const setup = this.config.defaultProject;
      let project = projects.find(project => project.title === setup.title && project.cwd === setup.cwd);
      if (!project) project = await this.workspace.createProject('operator', { title: setup.title, cwd: setup.cwd });
      this.config.projects = { ...this.config.projects, 'agent-workspace': project.id };
      const streams = this.workspace.snapshot('operator').streams;
      if (!project.deleted && !project.archived && !streams.some(stream => stream.projectId === project.id)) await this.workspace.createStream('operator', { projectId: project.id, title: 'Main', idempotencyKey: 'c38c5158-d49a-4f19-9d6f-a2a351a0ac71' });
      projects = this.workspace.snapshot('operator').projects;
    }
    if (Object.values(this.config.projects).some(id => !projects.some(project => project.id === id))) throw Error('Mapped target project does not exist');
    await this.store.load();
    const fd = await open(this.config.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    let key;
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.mode & 0o077) throw Error('Private operator-owned TLS key required');
      key = await fd.readFile();
    } finally { await fd.close(); }
    const cert = await readFile(this.config.certFile);
    const server = createServer({ key, cert, minVersion: 'TLSv1.2' }, (req, res) => {
      const work = this.foregroundWork(() => this.#handle(req, res)).catch(error => {
        if (!res.headersSent && !res.destroyed) { res.writeHead(error.status ?? 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":"Peer request refused; reconcile before retry"}'); }
      });
      this.#pending.add(work); void work.finally(() => this.#pending.delete(work));
    });
    this.#server = server;
    server.maxConnections = 128;
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    server.on('connection', socket => { this.#sockets.add(socket); socket.once('close', () => this.#sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.config.port, this.config.host, resolve); });
  }
  list() { return this.store.read().peers.map(({ digest, owner, ...peer }) => peer); }
  revoke(id) { return this.store.change(data => { data.peers = data.peers.filter(peer => peer.id !== id); }); }
  async #handle(req, res) {
    if (this.#closing || req.method !== 'POST' || req.headers.host !== new URL(this.origin).host || req.headers.origin || req.headers.cookie || req.headers['content-type'] !== 'application/json') throw deny();
    if (!['/v1/pair', '/v1/request', '/v1/revoke'].includes(req.url)) throw deny();
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    const findPeer = (includeExpired = false) => token && this.store.read().peers.find(peer => peer.digest === hash(token) && (includeExpired || peer.expiresAt > Date.now()));
    const pairing = req.url === '/v1/pair';
    if (!pairing && (req.url !== '/v1/revoke' || !token) && !findPeer()) throw deny();
    // Single-use 192-bit codes plus bounded concurrent pairing; no password endpoint.
    if (pairing && this.#pairing >= 4) throw deny();
    if (pairing) this.#pairing++;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 100000) throw deny(); chunks.push(chunk); }
      let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw deny(); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || this.#closing) throw deny();
      let result;
      if (pairing) {
        const scope = await this.hub.consumeCode(input.code);
        if (scope.owner !== 'operator') throw deny();
        const token = randomBytes(32).toString('base64url'); const id = randomUUID();
        await this.store.change(data => { data.peers = data.peers.filter(peer => peer.expiresAt > Date.now()); if (data.peers.length >= 256) throw deny(); data.peers.push({ id, owner: scope.owner, capabilities: scope.capabilities, digest: hash(token), createdAt: Date.now(), expiresAt: Date.now() + this.tokenLifetimeMs }); });
        result = { protocol: 1, agent: this.agent, endpoint: this.origin, token, capabilities: scope.capabilities };
      } else {
        const peer = findPeer(req.url === '/v1/revoke');
        if (req.url === '/v1/revoke') { if (peer) await this.revoke(peer.id); result = { revoked: true }; }
        else { if (!peer || !peer.capabilities.includes(input.capability)) throw deny(); result = await this.#request(peer.owner, input.capability, input.input); }
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(result));
    } finally { if (pairing) this.#pairing--; }
  }
  #request(owner, capability, input) { return workspaceRequest(this.workspace, this.config, owner, capability, input); }
  stop() { return this.#stopping ??= this.#stop(); }
  async #stop() {
    this.#closing = true;
    const closed = this.#server ? new Promise(resolve => this.#server.close(resolve)) : Promise.resolve();
    for (const socket of this.#sockets) socket.destroy();
    await Promise.allSettled([...this.#pending]); await closed; await this.store.stop();
  }
}

export default {
  apiVersion: 1, updateAdmission: 'foreground-owned',
  async activate(api) {
    const hub = api.services?.get('agent-hub'), workspace = api.services?.get('workspaces');
    if (!api.foregroundWork || hub?.version !== 1 || workspace?.version !== 1) throw Error('Agent link requires host admission, agent-hub v1 and workspaces v1');
    const config = JSON.parse(await readFile(path.join(api.home, 'agent-link.json'), 'utf8'));
    const link = new AgentLink({ home: api.home, agent: api.agent, hub: hub.implementation, workspace: workspace.implementation, config: config.listen, foregroundWork: api.foregroundWork });
    api.onStop(() => link.stop());
    api.registerChannel({ name: 'agent-link', start: () => link.open(), stop: () => link.stop(), async send() { throw Error('Use the scoped agent-link protocol for peer requests'); } });
    api.registerService('agent-link', 1, link);
    api.registerCommand({ name: 'agent-link', admin: true, help: 'Target peer tokens: list | revoke <id>', async run(args) {
      const [action = 'list', id] = args.trim().split(/\s+/);
      if (action === 'list') return JSON.stringify(link.list());
      if (action === 'revoke' && id) { await link.revoke(id); return 'Peer revoked'; }
      throw Error('Use agent-link list | revoke <id>');
    } });
  },
};
