import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GitCatalog } from './service.mjs';
export { GitCatalog };
export default {
  apiVersion: 1, updateAdmission: 'foreground-owned',
  async activate(api) {
    if (!api.foregroundWork) throw Error('Git catalog requires host foreground-work admission');
    const config = JSON.parse(await readFile(path.join(api.home, 'git-catalog.json'), 'utf8'));
    const credentials = api.services.get('credentials');
    if (config.providers.some(p => p.credential) && credentials?.version !== 1) throw Error('Install credentials before authenticated Git discovery');
    const catalog = new GitCatalog({ providers: config.providers, credentials: credentials?.implementation });
    let closing = false; const pending = new Set();
    const owned = action => {
      if (closing) return Promise.reject(Error('Git catalog stopping'));
      const work = api.foregroundWork(action); pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
    };
    api.onStop(async () => { closing = true; await Promise.allSettled([...pending]); });
    const service = Object.freeze({ list: () => catalog.list(),
      organizations: (...args) => owned(() => catalog.organizations(...args)),
      repositories: (...args) => owned(() => catalog.repositories(...args)),
    });
    api.registerService('git-catalog', 1, service);
    api.registerCommand({ name: 'git-catalog', admin: true, help: 'Read-only configured Git inventory: providers | orgs <provider> | repos <provider> [organization]', async run(args) {
      const [op = 'providers', provider, organization] = args.trim().split(/\s+/);
      if (op === 'providers') return JSON.stringify(service.list());
      if (op === 'orgs') return JSON.stringify(await service.organizations('operator', provider));
      if (op === 'repos') return JSON.stringify(await service.repositories('operator', provider, organization));
      throw Error('Use providers | orgs <provider> | repos <provider> [organization]');
    } });
  },
};
