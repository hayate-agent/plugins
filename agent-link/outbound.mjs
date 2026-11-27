import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OutboundAgentLink } from './websocket-client.mjs';

export function connectTool(client) {
  return {
    name: 'plugin_agent_link_connect',
    description: 'Connect this agent outward to a central Hayate dashboard with a single-use invitation code (action "enroll"), or show the connection state (action "status"). The dashboard operator still approves the connection centrally. Never repeat the invitation code in replies, files or memory.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['enroll', 'status'] },
      endpoint: { type: 'string', description: 'HTTPS origin of the central dashboard, e.g. https://dashboard.example.org' },
      code: { type: 'string', description: 'Single-use invitation code from the dashboard' },
    } },
    async execute(input, { signal } = {}) {
      if (signal?.aborted) throw Error('Outbound enrollment cancelled');
      if (input.action === 'status') return JSON.stringify(client.status());
      if (input.action === 'enroll') {
        if (typeof input.endpoint !== 'string' || typeof input.code !== 'string' || !input.endpoint || !input.code.trim()) throw Error('enroll needs endpoint and code');
        return JSON.stringify(await client.enroll(input.endpoint.trim(), input.code.trim()));
      }
      throw Error('Use action enroll or status');
    },
  };
}

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
    api.registerTool(connectTool(client));
    api.registerCommand({ name: 'agent-link-outbound', admin: true, help: 'Outbound WSS: status | enroll <https-origin> <single-use-invitation> | disconnect', async run(args) {
      const [action = 'status', endpoint, code] = args.trim().split(/\s+/);
      if (action === 'status') return JSON.stringify(client.status());
      if (action === 'enroll' && endpoint && code) return JSON.stringify(await client.enroll(endpoint, code));
      if (action === 'disconnect') { await client.disconnect(); return 'Outbound authorization revoked and connection removed'; }
      throw Error('Use agent-link-outbound status | enroll <https-origin> <single-use-invitation> | disconnect');
    } });
  },
};
