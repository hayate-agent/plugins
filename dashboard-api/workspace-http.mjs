/** HTTP projection only. Projects, files, secrets and agent registration belong
 * to independently installed backend plugins, never to the WebUI data store. */
export class WorkspaceHTTP {
  #events = new Set();
  constructor(services, { localAgent = true } = {}) { this.services = services; this.localAgent = localAgent; }
  capabilities() {
    return { ...Object.fromEntries(['workspaces', 'credentials', 'agent-hub', 'git-catalog', 'agent-link-relay', 'agent-link-outbound'].map(name => [name, this.services?.get(name)?.version ?? null])), 'local-agent': this.localAgent, 'project-creation': this.localAgent }; 
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
    const agentRequest = /^\/agents\/([^/]+)\/request$/.exec(route);
    if (req.method === 'POST' && agentRequest) {
      const input = await body(req);
      json(res, 200, await this.service('agent-hub').request(principal, agentRequest[1], input.capability, input.input)); return true;
    }
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
    const match = /^\/(projects|streams)\/([^/]+)(?:\/(messages|convert))?$/.exec(route);
    if (req.method === 'GET' && match?.[1] === 'streams' && !match[3]) {
      json(res, 200, this.service('workspaces').stream(principal, match[2])); return true;
    }
    if (req.method === 'POST' && route === '/projects') { json(res, 201, await this.service('workspaces').createProject(principal, await body(req))); return true; }
    if (req.method === 'POST' && route === '/streams') { json(res, 201, await this.service('workspaces').createStream(principal, await body(req))); return true; }
    if (req.method === 'POST' && match) {
      const service = this.service('workspaces'); const value = await body(req);
      if (match[1] === 'streams' && match[3] === 'messages') json(res, 202, await service.submit(principal, match[2], value));
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
    if (route.startsWith('/agents/') && req.method === 'DELETE') { await this.service('agent-hub').remove(principal, route.slice('/agents/'.length)); json(res, 200, { ok: true }); return true; }
    throw Object.assign(Error('Workspace route not found'), { status: 404 });
  }
  prune() { for (const subscription of this.#events) if (!subscription.authorized()) subscription.res.end(); }
  stop() { for (const subscription of this.#events) { subscription.stop(); subscription.res.end(); } this.#events.clear(); }
}
