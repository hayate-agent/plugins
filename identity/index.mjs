import { open, constants } from 'node:fs/promises';
import path from 'node:path';
import { Identity } from './service.mjs';
import { Store } from '../shared/store.mjs';
export default {
  apiVersion: 1, updateAdmission: 'foreground-owned',
  async activate(api) {
    if (!api.foregroundWork) throw Error('Identity requires foreground-work admission');
    const file = await open(path.join(api.home, 'identity.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    let config;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.mode & 0o077) throw Error('Identity config must be a private operator-owned regular file');
      config = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    const accountFile = path.join(api.home, 'identity/account.json');
    try {
      const file = await open(accountFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.mode & 0o077) throw Error('Account config must be a private operator-owned regular file');
      } finally { await file.close(); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const store = new Store(accountFile, { version: 1, account: config }); await store.load();
    const identity = new Identity({ ...store.read().account, sessions: store.read().sessions ?? [],
      persist: account => store.change(data => { data.account = account; data.sessions = []; }),
      persistSessions: (sessions, account) => store.change(data => {
        if (data.account.username !== account.username || data.account.password.hash !== account.password.hash) throw Error('Account changed; sign in again');
        data.sessions = sessions;
      }),
    }); const pending = new Set();
    const owned = work => {
      const operation = api.foregroundWork(work); pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation)); return operation;
    };
    const service = Object.freeze({
      login: (...args) => owned(() => identity.login(...args)),
      account: (...args) => identity.account(...args),
      changeCredentials: (...args) => owned(() => identity.changeCredentials(...args)),
      authenticate: (...args) => identity.authenticate(...args),
      renew: (...args) => owned(() => identity.renew(...args)),
      revoke: (...args) => owned(() => identity.revoke(...args)),
    });
    api.onStop(async () => { identity.stop(); await Promise.allSettled([...pending]); await store.stop(); });
    api.registerService('identity', 1, service);
  },
};
