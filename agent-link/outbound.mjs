import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OutboundAgentLink } from './websocket-client.mjs';

/** Optional target plugin: no inbound listener, no new model/runtime. */
export default {
  apiVersion: 1, updateAdmission: 'foreground-owned',
  async activate(api) {
    if (!api.foregroundWork) throw Error('Outbound AgentLink requires host foreground-work admission');
    const workspace = api.services.get('workspaces'), credentials = api.services.get('credentials');
    if (workspace?.version !== 1 || credentials?.version !== 1) throw Error('Install workspace and credentials before outbound AgentLink');
    const config = JSON.parse(await readFile(path.join(api.home, 'agent-link-outbound.json'), 'utf8'));
    const client = new OutboundAgentLink({ home: api.home, agent: api.agent, workspace: workspace.implementation, credentials: credentials.implementation, config, foregroundWork: api.foregroundWork });
    api.onStop(() => client.stop());
    api.registerService('agent-link-outbound', 1, client);
    api.registerChannel({ name: 'agent-link-outbound', async start() { await client.open(); }, async stop() { await client.stop(); }, async send() { throw Error('Remote output belongs to its original workspace channel'); } });
    api.registerCommand({ name: 'agent-link-outbound', admin: true, help: 'Outbound WSS: status | enroll <https-origin> <single-use-invitation> | disconnect', async run(args) {
      const [action = 'status', endpoint, code] = args.trim().split(/\s+/);
      if (action === 'status') return JSON.stringify(client.status());
      if (action === 'enroll' && endpoint && code) return JSON.stringify(await client.enroll(endpoint, code));
      if (action === 'disconnect') { await client.disconnect(); return 'Outbound authorization revoked and connection removed'; }
      throw Error('Use agent-link-outbound status | enroll <https-origin> <single-use-invitation> | disconnect');
    } });
  },
};
