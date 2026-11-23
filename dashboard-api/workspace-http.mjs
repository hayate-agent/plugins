import { describeAgentFailure } from './relay-errors.mjs';
/** HTTP projection only. Projects, files, secrets and agent registration belong
 * to independently installed backend plugins, never to the WebUI data store. */
export function validateAgentRead(capability, input) {
  const allowed = { projects: ['list', 'resolve'], streams: ['list', 'fork-eligibility'], messages: ['read', 'submission-status', 'changes', 'image-read'], activity: ['list'] };
  if (!input || typeof input !== 'object' || Array.isArray(input) || !allowed[capability]?.includes(input.action)) {
    if (!(capability === 'messages' && input?.action === 'pi-chats' && ['list', 'preview'].includes(input.operation))) throw Object.assign(Error('Read-only agent operation required'), { status: 405 });
  }
  return { capability, input };
}

import { createCommandLedger, OP_ID } from './command-ledger.mjs';
import { createStreamCache } from './stream-cache.mjs';

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
export class WorkspaceHTTP {
  #events = new Set();
  constructor(services, { localAgent = true, ledgerFile, ledger = createCommandLedger({ file: ledgerFile }), cache = createStreamCache() } = {}) { this.services = services; this.localAgent = localAgent; this.ledger = ledger; this.cache = cache; }
  /** `changes` with the bounded cache. The agent always authorizes: on a cache
   * hit it is asked only for events after the cached head (a small answer), so
   * revoked access, a new epoch or a reset from the agent always wins. Cached
   * events are returned only together with a successful agent answer. */
  async changes(principal, agentId, input) {
    const hub = this.service('agent-hub');
    const cached = this.liveAgent(principal, agentId) ? this.cache.since(principal, agentId, input.streamId, input.since, input.epoch) : undefined;
    if (!cached) return hub.request(principal, agentId, 'messages', input);
    const head = await hub.request(principal, agentId, 'messages', { ...input, since: cached.seq });
    if (!head || head.reset || head.epoch !== cached.epoch || !Array.isArray(head.events)) return head;
    // Same bounds as one agent page: ≤128 events and ≤200000 serialized bytes.
    // A truncated answer reports `more` and the last included seq.
    // Strictly contiguous by seq; anything after a gap is left for the next page.
    const events = []; let bytes = 0, expected = input.since + 1;
    const candidates = [...cached.events, ...head.events.filter(event => event?.seq > cached.seq)];
    for (const event of candidates) {
      if (event?.seq !== expected) break;
      const size = Buffer.byteLength(JSON.stringify(event));
      if (events.length >= 128 || events.length && bytes + size > 200_000) break;
      events.push(event); bytes += size; expected++;
    }
    const complete = !cached.truncated && events.length === candidates.length;
    if (!events.length) return { ...head, seq: input.since, events: [], more: true };
    // Truncated: the cursor is the last returned event, so resuming from `seq`
    // never skips anything.
    return { ...head, ...(complete ? {} : { seq: events.at(-1).seq }), events, more: complete ? !!head.more : true, cached: Math.min(events.length, cached.events.length) };
  }
  /** Whether `agentId` is currently the principal's registered relay agent. */
  liveAgent(principal, agentId) {
    const hub = this.services?.get('agent-hub');
    try { return hub?.version === 1 && hub.implementation.list(principal).some(agent => agent.id === agentId && agent.adapter === 'hayate-wss'); } catch { return false; }
  }
  /** Agent command with idempotent opId. Same ledger for the browser WebSocket
   * and the POST fallback: an operation executes at most once per principal. */
  command(principal, { opId, agentId, capability, input } = {}) {
    if (!OP_ID.test(opId ?? '') || !AGENT_ID.test(agentId ?? '') || typeof capability !== 'string' || capability.length > 64 || !input || typeof input !== 'object' || Array.isArray(input)) return Promise.resolve({ ok: false, status: 400, executed: false, error: 'Invalid agent command; nothing was executed' });
    return this.ledger.run(principal, opId, { agentId, capability, input }, () => this.service('agent-hub').request(principal, agentId, capability, input));
  }
  capabilities() {
    const live = this.services?.get('agent-link-relay')?.implementation?.subscribe ? 1 : null;
    return { 'browser-live-v1': live, 'browser-stream-v1': live, 'browser-commands-v1': live && this.services?.get('agent-hub')?.version === 1 ? 1 : null, serverTime: Date.now(), ...Object.fromEntries(['workspaces', 'credentials', 'agent-hub', 'git-catalog', 'agent-link-relay', 'agent-link-outbound'].map(name => [name, this.services?.get(name)?.version ?? null])), 'local-agent': this.localAgent, 'project-creation': this.localAgent };
  }
  service(name) {
    const value = this.services?.get(name);
    if (value?.version !== 1) throw Object.assign(Error(`Install backend plugin ${name} to use this feature`), { status: 409 });
    return value.implementation;
  }
  async handle({ req, res, url, body, json, principal = 'operator', authorized = () => true }) {
    if (!url.pathname.startsWith('/api/workspace')) return false;
    const route = url.pathname.slice('/api/workspace'.length);
    if (req.method === 'GET' && route === '/capabilities') { json(res, 200, this.capabilities()); return true; }
    if (req.method === 'GET' && route.startsWith('/git')) {
      const service = this.service('git-catalog');
      const match = /^\/git\/([a-z][a-z0-9_-]*)\/(organizations|repositories)$/.exec(route);
      if (route === '/git') json(res, 200, { providers: service.list() });
      else if (match) json(res, 200, match[2] === 'organizations' ? await service.organizations(principal, match[1], Number(url.searchParams.get('page') ?? 1)) : await service.repositories(principal, match[1], url.searchParams.get('organization') ?? undefined, Number(url.searchParams.get('page') ?? 1)));
      else throw Object.assign(Error('Git catalog route not found'), { status: 404 });
      return true;
    }
    if (route === '/agent-relay') {
      const relay = this.service('agent-link-relay');
      if (req.method === 'GET') json(res, 200, { agents: relay.list(principal), transport: 'hayate-wss' });
      else if (req.method === 'POST') json(res, 201, await relay.invite(principal, await body(req)));
      else return false;
      return true;
    }
    const relayAction = /^\/agent-relay\/([a-f0-9-]{36})\/(accept|reject)$/.exec(route);
    if (req.method === 'POST' && relayAction) {
      await body(req); const relay = this.service('agent-link-relay');
      const result = relayAction[2] === 'accept' ? await relay.accept(principal, relayAction[1], this.service('agent-hub')) : await relay.reject(principal, relayAction[1]);
      json(res, 200, result); return true;
    }
    if (route === '/agent-outbound') {
      const client = this.service('agent-link-outbound');
      if (req.method === 'GET') json(res, 200, client.status());
      else if (req.method === 'POST') { const input = await body(req); json(res, 200, input.action === 'disconnect' ? await client.disconnect() ?? { disconnected: true } : await client.enroll(input.endpoint, input.code)); }
      else return false;
      return true;
    }
    if (req.method === 'GET' && route === '/state') { json(res, 200, this.service('workspaces').snapshot(principal)); return true; }
    if (!this.localAgent && (route === '/files' || req.method === 'POST' && ['/projects', '/streams'].includes(route))) throw Object.assign(Error('No local execution host; use a registered agent'), { status: 409 });
    if (req.method === 'GET' && route === '/files') {
      const service = this.service('workspaces');
      const directory = url.searchParams.get('path');
      json(res, 200, directory ? await service.files.browse(directory) : { roots: service.files.roots() }); return true;
    }
    if (req.method === 'GET' && route === '/events') {
      const service = this.service('workspaces');
      if (this.#events.size >= 32) throw Object.assign(Error('Too many workspace subscriptions'), { status: 429 });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      const project = url.searchParams.get('project'), stream = url.searchParams.get('stream');
      const send = () => {
        if (res.destroyed) return;
        if (!authorized()) { res.end(); return; }
        if (res.writableLength > 1_000_000) { res.destroy(); return; }
        let snapshot = service.snapshot(principal);
        if (stream) snapshot = { ...snapshot, conversation: service.stream(principal, stream) };
        if (project) snapshot = { ...snapshot, streams: snapshot.streams.filter(s => s.projectId === project) };
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      };
      const subscription = { res, authorized, stop: service.subscribe(send) };
      this.#events.add(subscription);
      res.once('close', () => { subscription.stop(); this.#events.delete(subscription); });
      send(); return true;
    }
    if (req.method === 'HEAD' && route === '/revision') {
      const relay = this.service('agent-link-relay');
      if (typeof relay.revision !== 'function') throw Object.assign(Error('Live revision unavailable'), { status: 409 });
      const etag = '"' + relay.revision(principal) + '"'; res.setHeader('ETag', etag);
      res.writeHead(req.headers['if-none-match'] === etag ? 304 : 200); res.end(); return true;
    }
    const agentRead = /^\/agents\/([^/]+)\/read$/.exec(route);
    if (['GET', 'HEAD'].includes(req.method) && agentRead) {
      const encoded = url.searchParams.get('input') ?? '{}';
      if (encoded.length > 8192) throw Object.assign(Error('Read query too large'), { status: 413 });
      let input; try { input = JSON.parse(encoded); } catch { throw Object.assign(Error('Invalid read query'), { status: 400 }); }
      const capability = url.searchParams.get('capability');
      validateAgentRead(capability, input);
      // `changes` is answered from the bounded cache when it holds the window;
      // otherwise (miss, other epoch, gap) the agent answers as before.
      const value = capability === 'messages' && input.action === 'changes'
        ? await this.changes(principal, agentRead[1], input)
        : await this.service('agent-hub').request(principal, agentRead[1], capability, input);
      if (!authorized()) throw Object.assign(Error('Authentication required'), { status: 401 });
      // HEAD currently performs the same authorized read. A push-maintained
      // revision will replace this computation, not hide periodic upstream work.
      const { createHash } = await import('node:crypto');
      const etag = '"' + createHash('sha256').update(JSON.stringify(value)).digest('hex') + '"';
      res.setHeader('ETag', etag);
      // Closed history pages (explicit `before` cursor, declared immutable by the
      // agent) have a stable ETag. The browser may keep them but must revalidate
      // every use (`no-cache`), so session expiry and revoked access always apply;
      // an unchanged page then costs a 304 without body. Everything else no-store.
      if (capability === 'messages' && input.action === 'read' && typeof input.before === 'string' && input.before && value?.immutable === true) {
        res.setHeader('Cache-Control', 'private, no-cache'); res.setHeader('Vary', 'Cookie');
      }
      if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); }
      else if (req.method === 'HEAD') { res.writeHead(200); res.end(); }
      else json(res, 200, value);
      return true;
    }
    const agentRequest = /^\/agents\/([^/]+)\/request$/.exec(route);
    if (req.method === 'POST' && agentRequest) {
      const input = await body(req);
      // POST fallback of the WebSocket command channel: with an opId it shares
      // the same ledger. Requests without opId keep the previous behavior.
      if (input.opId !== undefined) {
        const outcome = await this.command(principal, { opId: input.opId, agentId: agentRequest[1], capability: input.capability, input: input.input });
        if (outcome.ok) { res.setHeader('X-Hayate-Op-Duplicate', outcome.duplicate ? '1' : '0'); json(res, 200, outcome.result); }
        else json(res, outcome.status ?? 502, { error: outcome.error, ...(outcome.executed !== undefined ? { executed: outcome.executed } : {}) });
        return true;
      }
      try { json(res, 200, await this.service('agent-hub').request(principal, agentRequest[1], input.capability, input.input)); }
      catch (error) { if (error?.status) throw error; const failure = describeAgentFailure(error); json(res, failure.status, { error: failure.error }); }
      return true;
    }
    const operation = /^\/operations\/([A-Za-z0-9_-]{16,64})$/.exec(route);
    if (req.method === 'GET' && operation) { json(res, 200, await this.ledger.status(principal, operation[1])); return true; }
    const dashboard = /^\/projects\/([^/]+)\/agents$/.exec(route);
    if (req.method === 'GET' && dashboard) {
      const project = this.service('workspaces').snapshot(principal).projects.find(project => project.id === dashboard[1]);
      if (!project) throw Object.assign(Error('Project not found'), { status: 404 });
      const cancellation = new AbortController();
      const close = () => cancellation.abort(); res.once('close', close);
      try { json(res, 200, await this.service('agent-hub').projectDashboard(principal, project.id, cancellation.signal)); }
      finally { res.removeListener('close', close); }
      return true;
    }
    const projectSync = /^\/projects\/([^/]+)\/sync$/.exec(route);
    if (req.method === 'POST' && projectSync) {
      await body(req);
      const project = this.service('workspaces').snapshot(principal).projects.find(project => project.id === projectSync[1]);
      if (!project) throw Object.assign(Error('Project not found'), { status: 404 });
      json(res, 200, { results: await this.service('agent-hub').syncProject(principal, { id: project.id, title: project.title, settings: project.settings }) }); return true;
    }
    const match = /^\/(projects|streams)\/([^/]+)(?:\/(messages|convert|fork|media|image))?$/.exec(route);
    if (req.method === 'GET' && match?.[1] === 'streams' && match[3] === 'image') {
      const index = Number(url.searchParams.get('index')), offset = Number(url.searchParams.get('offset') ?? 0), messageId = url.searchParams.get('message') ?? '';
      if (!messageId || messageId.length > 200 || !Number.isInteger(index) || !Number.isInteger(offset)) throw Object.assign(Error('Invalid image request'), { status: 400 });
      json(res, 200, await this.service('workspaces').imageChunk(principal, match[2], messageId, index, offset)); return true;
    }
    if (req.method === 'GET' && match?.[1] === 'streams' && !match[3]) {
      json(res, 200, this.service('workspaces').stream(principal, match[2])); return true;
    }
    if (req.method === 'POST' && route === '/projects') { json(res, 201, await this.service('workspaces').createProject(principal, await body(req))); return true; }
    if (req.method === 'POST' && route === '/streams') { json(res, 201, await this.service('workspaces').createStream(principal, await body(req))); return true; }
    if (req.method === 'POST' && match) {
      const service = this.service('workspaces'); const value = await body(req);
      if (match[1] === 'streams' && match[3] === 'media') json(res, 200, await service.uploadMedia(principal, match[2], value));
      else if (match[1] === 'streams' && match[3] === 'messages') json(res, 202, await service.submit(principal, match[2], value));
      else if (match[1] === 'streams' && match[3] === 'fork') json(res, 201, await service.forkStream(principal, match[2], value));
      else if (match[1] === 'streams' && match[3] === 'convert') json(res, 201, await service.convert(principal, match[2]));
      else if (!match[3]) { await service.update(principal, match[1] === 'projects' ? 'project' : 'stream', match[2], value); json(res, 200, { ok: true }); }
      else throw Object.assign(Error('Not found'), { status: 404 });
      return true;
    }
    if (req.method === 'POST' && route === '/settings') { await this.service('workspaces').update(principal, 'global', null, await body(req)); json(res, 200, { ok: true }); return true; }
    if (route === '/credentials') {
      const vault = this.service('credentials');
      if (req.method === 'GET') json(res, 200, { entries: vault.list(principal) });
      else if (req.method === 'POST') json(res, 201, await vault.put(principal, await body(req)));
      else return false;
      return true;
    }
    if (route.startsWith('/credentials/') && req.method === 'DELETE') { await this.service('credentials').remove(principal, route.slice('/credentials/'.length)); json(res, 200, { ok: true }); return true; }
    if (route === '/agents') {
      const hub = this.service('agent-hub');
      if (req.method === 'GET') json(res, 200, { agents: hub.list(principal), adapters: hub.adapters(), features: ['agent-presentation', 'connection-check'] });
      else if (req.method === 'POST') json(res, 201, await hub.connect(principal, await body(req)));
      else return false;
      return true;
    }
    const agentAction = /^\/agents\/([a-f0-9-]{36})(?:\/(check))?$/.exec(route);
    if (req.method === 'POST' && agentAction) {
      const hub = this.service('agent-hub'); const input = await body(req);
      if (agentAction[2] === 'check') json(res, 200, await hub.check(principal, agentAction[1]));
      else { await hub.update(principal, agentAction[1], input); json(res, 200, { agent: hub.list(principal).find(a => a.id === agentAction[1]) }); }
      return true;
    }
    if (req.method === 'POST' && route === '/pairing') {
      await body(req);
      const link = this.service('agent-link');
      const issued = await this.service('agent-hub').issueCode(principal, { name: 'Agent', capabilities: ['projects', 'streams', 'messages', 'activity'] });
      json(res, 201, { ...issued, endpoint: link.origin }); return true;
    }
    if (route.startsWith('/agents/') && req.method === 'DELETE') { const agentId = route.slice('/agents/'.length); this.cache.dropAgent(principal, agentId); await this.service('agent-hub').remove(principal, agentId); this.cache.dropAgent(principal, agentId); json(res, 200, { ok: true }); return true; }
    throw Object.assign(Error('Workspace route not found'), { status: 404 });
  }
  prune() { for (const subscription of this.#events) if (!subscription.authorized()) subscription.res.end(); }
  stop() { for (const subscription of this.#events) { subscription.stop(); subscription.res.end(); } this.#events.clear(); }
}
