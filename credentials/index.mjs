import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalVault, OpenBaoVault } from './vault.mjs';
import { Store } from '../shared/store.mjs';
export { LocalVault, OpenBaoVault };

export default {
  apiVersion: 1, updateAdmission: 'foreground-owned',
  async activate(api) {
    if (!api.registerService || !api.foregroundWork) throw Error('Credential plugin requires host service and foreground-work capabilities');
    let closing = false; const pending = new Set();
    const owned = work => {
      if (closing) return Promise.reject(Error('Credential plugin stopping'));
      const operation = api.foregroundWork(work); pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    };
    let config = { provider: 'local' };
    try { config = JSON.parse(await readFile(path.join(api.home, 'credentials.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let provider;
    if (config.provider === 'local') { provider = new LocalVault(api.home); await provider.open(); }
    else if (config.provider === 'openbao') provider = new OpenBaoVault(config);
    else {
      const registration = api.services.get(`secret-provider-${config.provider}`);
      if (registration?.version !== 1) throw Error('Install/configure the selected secret-provider plugin before credentials');
      provider = registration.implementation;
    }
    if (['put', 'withSecret', 'remove'].some(name => typeof provider?.[name] !== 'function')) throw Error('Invalid secret provider contract');
    const metadata = new Store(path.join(api.home, 'credentials/metadata.json'), { version: 1, entries: [] });
    await metadata.load();
    const service = Object.freeze({
      list(owner) { if (!owner) throw Error('Credential principal required'); return metadata.read().entries.filter(e => e.owner === owner); },
      put(owner, input) { return owned(async () => {
        const receipt = await provider.put(owner, input);
        await metadata.change(data => {
          const index = data.entries.findIndex(e => e.id === receipt.id && e.owner === owner);
          const entry = { id: receipt.id, owner, label: receipt.label, kind: receipt.kind, provider: config.provider, updatedAt: Date.now() };
          if (index >= 0) data.entries[index] = entry; else data.entries.push(entry);
        });
        return service.list(owner).find(e => e.id === receipt.id);
      }); },
      remove(owner, id) { return owned(async () => { await provider.remove(owner, id); await metadata.change(data => { data.entries = data.entries.filter(e => e.owner !== owner || e.id !== id); }); }); },
      withSecret(owner, id, consume) { return owned(() => provider.withSecret(owner, id, consume)); },
    });
    api.registerService('credentials', 1, service);
    api.onStop(async () => { closing = true; await Promise.allSettled([...pending]); await metadata.stop(); await provider.stop?.(); });
    // Deliberately no model tool or chat command for accepting/returning secret
    // values: a transcript must never become a credential-entry interface.
    api.registerCommand({ name: 'credentials', admin: true, help: 'Credential metadata only: list | remove <id>. Secret entry uses a trusted write-only frontend.', async run(args) {
      const [operation = 'list', id] = args.trim().split(/\s+/);
      if (operation === 'list') return JSON.stringify(service.list('operator'));
      if (operation === 'remove' && id) { await service.remove('operator', id); return 'Credential removed'; }
      throw Error('Use credentials list | remove <id>; never paste secret values into chat');
    } });
  },
};
