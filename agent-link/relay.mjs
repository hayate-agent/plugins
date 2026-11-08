import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentRelay } from './websocket-relay.mjs';

/** Optional central plugin. WSS shares the dashboard HTTPS listener. */
export default {
  apiVersion: 1, updateAdmission: 'foreground-owned',
  async activate(api) {
    if (!api.foregroundWork) throw Error('Relay requires host foreground-work admission');
    const config = JSON.parse(await readFile(path.join(api.home, 'agent-link-relay.json'), 'utf8'));
    const relay = new AgentRelay({ home: api.home, origin: config.origin, foregroundWork: api.foregroundWork });
    api.onStop(() => relay.stop());
    await relay.open({ listen: false });
    api.registerService('agent-link-relay', 1, relay);
    api.registerService('agent-adapter-hayate-wss', 1, relay.adapter);
    api.registerCommand({ name: 'agent-relay', admin: true, help: 'Outbound connections: list | invite <name> | accept <id> | reject <id>. Invitations are single-use; do not put passwords or tokens in commands.', async run(args) {
      const [action = 'list', ...rest] = args.trim().split(/\s+/);
      if (action === 'list') return JSON.stringify(relay.list('operator'));
      if (action === 'invite') return JSON.stringify(await relay.invite('operator', { name: rest.join(' ') }));
      if (action === 'accept') {
        const hub = api.services.get('agent-hub'); if (hub?.version !== 1) throw Error('AgentHub is required for manual approval');
        return JSON.stringify(await relay.accept('operator', rest[0], hub.implementation));
      }
      if (action === 'reject') return JSON.stringify(await relay.reject('operator', rest[0]));
      throw Error('Use agent-relay list | invite <name> | accept <id> | reject <id>');
    } });
  },
};
