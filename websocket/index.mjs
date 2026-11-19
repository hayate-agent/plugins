import { WebSockets } from './service.mjs';
import { Ingress, jsonHeartbeat } from './ingress.mjs';

export { Ingress, jsonHeartbeat, ruleGate } from './ingress.mjs';

// Extensions are trusted local modules supplied by an operator-owned overlay.
export function createWebSocketPlugin({ decide, routes = {}, correlate, extend } = {}) {
return {
  apiVersion: 1,
  activate(api) {
    const hostService = api.services?.get('ingress');
    const host = hostService?.version === 1 ? hostService.implementation : undefined;
    const infer = async (mode, event, context, config = context.gateConfig) => {
      if (!context.binding) throw Error('Host ingress binding unavailable');
      const requested = config?.[mode];
      if (!requested?.model) throw Error(`Explicit ${mode} model required in gateConfig`);
      const result = await context.binding.infer({ mode, requested, event, signal: context.signal });
      if (result.status !== mode) throw Error(`Host ${mode} inference failed`);
      return result;
    };
    const ingress = new Ingress({
      decide: decide ?? ((event, context, config) => infer('decision', event, context, config)),
      routes: {
        basic: async ({ event }, context) => {
          const result = await infer('basic', event, context);
          context.signal?.throwIfAborted();
          await context.send(result.text);
        },
        dispatcher: async (event, context) => {
          if (!context.binding) throw Error('Host ingress binding unavailable');
          const receipt = await context.binding.dispatch(context.eventId, JSON.stringify(event), async text => {
            context.signal?.throwIfAborted();
            await context.send(text);
          }, context.connection);
          context.signal?.throwIfAborted();
          await context.send(JSON.stringify({ type: 'websocket.dispatch.accepted', execution: receipt.id }));
        },
        ...routes,
      },
    });
    ingress.registerHandler('json-heartbeat', jsonHeartbeat);
    const service = new WebSockets({ ingress, correlate });
    ingress.routes.set('main', routes.main ?? (async ({ owner, connection, listener, eventId, event }, context) => {
      if (context.binding) {
        if (typeof context.binding.main !== 'function')
          throw Error('Host-bound Main routing requires an authority-preserving adapter');
        context.signal?.throwIfAborted();
        // Only the host-created binding may carry source authority into Main.
        // Never fall back to channel delivery after failed or uncertain admission.
        await context.binding.main(eventId, JSON.stringify({ owner, connection, listener, eventId, event }), async text => {
          context.signal?.throwIfAborted();
          await context.send(text);
        }, connection);
        return;
      }
      if (!service.deliver) throw Error('WebSocket channel not started');
      await service.deliver({ session: owner, target: connection, id: eventId,
        text: JSON.stringify({ type: 'websocket.event', connection, listener, event }) });
    }));
    extend?.(ingress);
    api.registerChannel({
      name: 'websocket',
      async start(deliver) { service.deliver = deliver; },
      async send(to, text) {
        // The reply target identifies a connection created by an owner session.
        const row = service.connections.get(to.target);
        if (!row) throw Error('WebSocket reply connection unavailable');
        await service.send(row.owner, row.id, text);
      },
      async stop() { service.stop(); },
    });
    api.onStop(() => service.stop());
    api.registerTool({
      name: 'plugin_websocket',
      description: 'Open persistent generic WebSocket clients/listeners; list, send or close session-owned connections. Incoming frames arrive on the websocket channel, not in the original chat session.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['action'],
        properties: {
          action: { type: 'string', enum: ['connect', 'listen', 'list', 'send', 'close', 'configure'] },
          profile: { type: 'object', additionalProperties: false, properties: {
            handlers: { type: 'array', maxItems: 32, items: { type: 'object', required: ['name'],
              properties: { name: { type: 'string' }, config: { type: 'object' } }, additionalProperties: false } },
            gate: { type: 'string' }, gateConfig: { type: 'object' },
          } },
          id: { type: 'string' }, url: { type: 'string' }, host: { type: 'string' },
          port: { type: 'integer', minimum: 0, maximum: 65535 }, token: { type: 'string' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          ca: { type: 'string' }, reconnectMs: { type: 'integer', minimum: 0, maximum: 300000 },
          data: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] },
        },
      },
      async execute(input, { sessionKey, signal }) {
        if (signal?.aborted) throw Error('WebSocket operation cancelled');
        switch (input.action) {
          case 'connect': return JSON.stringify(await service.connect(sessionKey, { ...input, signal, binding: host?.bind(sessionKey) }));
          case 'listen': return JSON.stringify(await service.listen(sessionKey, { ...input, binding: host?.bind(sessionKey) }));
          case 'configure': service.configure(sessionKey, input.id, input.profile); return 'configured';
          case 'list': return JSON.stringify(service.list(sessionKey));
          case 'send': await service.send(sessionKey, input.id, input.data, input.encoding); return 'sent';
          case 'close': service.close(sessionKey, input.id); return 'closed';
          default: throw Error('Unknown WebSocket action');
        }
      },
    });
  },
};
}

export default createWebSocketPlugin();
