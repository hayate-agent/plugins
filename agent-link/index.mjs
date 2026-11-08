import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { HayateAdapter } from './transport.mjs';
export default {
  apiVersion: 1,
  async activate(api) {
    if (!api.registerService) throw Error('Agent adapter requires host service registration');
    const config = JSON.parse(await readFile(path.join(api.home, 'agent-link.json'), 'utf8'));
    if (!Array.isArray(config.peers)) throw Error('Explicit peer allowlist required');
    api.registerService('agent-adapter-hayate', 1, new HayateAdapter(config.peers, { allowOperatorTargets: config.allowOperatorTargets }));
  },
  // The adapter holds no sockets until the hub owns an operation; HTTPS calls
  // disable connection pooling so no unowned persistent client survives a turn.
  updateAdmission: 'foreground-owned',
};
