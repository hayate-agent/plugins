import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from './service.mjs';
export { Workspace };

/** Headless agent overlay. WebUI, TUI and messaging are consumers of the same service. */
export default {
  apiVersion: 1,
  updateAdmission: 'foreground-owned',
  async activate(api) {
    if (!api.services || !api.registerService || !api.executionContexts) throw Error('Workspace plugin requires the host service/execution-context capabilities');
    let config = {};
    try { config = JSON.parse(await readFile(path.join(api.home, 'workspace.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (config.roots !== undefined && (!Array.isArray(config.roots) || config.roots.some(p => typeof p !== 'string' || !path.isAbsolute(p)))) throw Error('workspace.json roots must be absolute directories');
    const workspace = new Workspace({ home: api.home, cwd: api.cwd, agent: api.agent, roots: config.roots, executionContexts: api.executionContexts });
    await workspace.open();
    api.onStop(() => workspace.stop());
    api.registerService('workspaces', 1, workspace);
    api.registerChannel(workspace.channel);
    api.registerCommand({ name: 'workspace', admin: true,
      help: 'Headless projects: list | browse <path> | project <JSON> | stream <JSON> | send <JSON> | read <id> | update <JSON> | convert <id>',
      async run(args) {
        const [operation, ...rest] = args.trim().split(/\s+/); const raw = rest.join(' ');
        // This command is protected by the host administrator check. Operator is
        // the local workspace domain principal, not an impersonated host admin.
        const principal = 'operator';
        if (!operation || operation === 'list') return JSON.stringify(workspace.snapshot(principal));
        if (operation === 'browse') return JSON.stringify(await workspace.files.browse(raw));
        if (operation === 'read') return JSON.stringify(workspace.stream(principal, raw));
        if (operation === 'convert') return JSON.stringify(await workspace.convert(principal, raw));
        const input = JSON.parse(raw);
        if (operation === 'project') return JSON.stringify(await workspace.createProject(principal, input));
        if (operation === 'stream') return JSON.stringify(await workspace.createStream(principal, input));
        if (operation === 'send') return JSON.stringify(await workspace.submit(principal, input.streamId, { id: input.id, text: input.text }));
        if (operation === 'update') { await workspace.update(principal, input.kind, input.id, input.patch); return 'Workspace saved'; }
        throw Error('Unknown workspace operation');
      },
    });
    api.registerPanel({ name: 'workspace', render() {
      const value = workspace.snapshot('operator');
      const projects = value.projects.filter(p => !p.deleted && !p.archived);
      const streams = value.streams.filter(s => !s.deleted && !s.archived);
      return [`Projects ${projects.length} · Streams ${streams.length} · Unread ${streams.filter(s => s.unread).length}`];
    } });
  },
};
