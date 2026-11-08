import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentHub } from './service.mjs';
export { AgentHub };

export default {
  apiVersion: 1, updateAdmission: 'foreground-owned',
  async activate(api) {
    if (!api.foregroundWork) throw Error('Agent hub requires host foreground-work admission');
    const credentials = api.services?.get('credentials');
    if (credentials?.version !== 1) throw Error('Install the credentials plugin before agent-hub');
    let config = {};
    try { config = JSON.parse(await readFile(path.join(api.home, 'agent-hub.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const hub = new AgentHub({ home: api.home, credentials: credentials.implementation, pairingLifetimeMs: config.pairingLifetimeMs, foregroundWork: api.foregroundWork });
    await hub.open(); api.onStop(() => hub.stop());
    if (config.adapters !== undefined && (!Array.isArray(config.adapters) || config.adapters.some(a => typeof a !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(a)))) throw Error('Invalid configured agent adapters');
    for (const name of config.adapters ?? []) {
      const adapter = api.services.get(`agent-adapter-${name}`);
      if (adapter?.version !== 1) throw Error(`Install agent adapter ${name} before agent-hub`);
      hub.registerAdapter(name, adapter.implementation);
    }
    api.registerService('agent-hub', 1, hub);
    api.registerCommand({ name: 'agent-hub', admin: true,
      help: 'Headless registry: list | pair [https://webui-origin] | connect <JSON> | check <id> | update <JSON> | request <JSON> | sync <project-id> | remove <id>. Never put tokens or passwords in commands.',
      async run(args) {
        const [operation = 'list', ...rest] = args.trim().split(/\s+/); const id = rest[0];
        if (operation === 'list') return JSON.stringify({ agents: hub.list('operator'), adapters: hub.adapters() });
        if (operation === 'pair') {
          let webui;
          if (id) {
            const url = new URL(id);
            if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Use a canonical HTTPS WebUI URL without credentials/path/query');
            webui = url.origin;
          }
          const link = api.services.get('agent-link');
          if (link?.version !== 1) throw Error('The target agent endpoint is not enabled; install/start agent-link/server before generating a usable code');
          const issued = await hub.issueCode('operator', { name: api.agent, capabilities: ['projects', 'streams', 'messages', 'activity'] });
          return JSON.stringify({ ...issued, agent: api.agent, endpoint: link.implementation.origin, ...(webui ? { webui } : {}), instructions: 'Open Agents → Register an agent in the WebUI. Enter endpoint and code. The code is single-use and expires; do not put it in a URL.' });
        }
        if (operation === 'connect') return JSON.stringify(await hub.connect('operator', JSON.parse(rest.join(' '))));
        if (operation === 'check' && id) return JSON.stringify(await hub.check('operator', id));
        if (operation === 'update') { const input = JSON.parse(rest.join(' ')); await hub.update('operator', input.agentId, input.patch); return 'Agent presentation updated'; }
        if (operation === 'request') { const input = JSON.parse(rest.join(' ')); return JSON.stringify(await hub.request('operator', input.agentId, input.capability, input.input)); }
        if (operation === 'sync' && id) {
          const workspace = api.services.get('workspaces');
          const project = workspace?.version === 1 && workspace.implementation.snapshot('operator').projects.find(p => p.id === id);
          if (!project) throw Error('Local workspace project not found');
          return JSON.stringify(await hub.syncProject('operator', { id: project.id, title: project.title, settings: project.settings }));
        }
        if (operation === 'remove' && id) { await hub.remove('operator', id); return 'Agent registration removed'; }
        throw Error('Use agent-hub list | pair [https://webui-origin] | connect <JSON> | check <id> | update <JSON> | request <JSON> | sync <project-id> | remove <id>');
      },
    });
  },
};
