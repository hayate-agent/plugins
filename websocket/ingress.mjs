const outcomes = new Set(['handled', 'correlated', 'forward', 'pass']);
const targets = new Set(['mechanical', 'basic', 'dispatcher', 'main']);

/** Trusted extension registry. Remote messages can select neither code nor authority. */
export class Ingress {
  constructor({ decide, routes = {} } = {}) {
    this.handlers = new Map(); this.gates = new Map(); this.routes = new Map(Object.entries(routes));
    this.registerGate('decision', async (event, context, config) => {
      if (!decide) throw Error('Decision adapter not configured');
      return decide(event, context, config);
    });
    this.registerGate('main', async () => ({ target: 'main' }));
  }
  register(map, name, fn) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || typeof fn !== 'function' || map.has(name)) throw Error('Invalid or duplicate extension');
    map.set(name, fn);
  }
  registerHandler(name, fn) { this.register(this.handlers, name, fn); }
  registerGate(name, fn) { this.register(this.gates, name, fn); }
  profile(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid ingress profile');
    const { handlers = [], gate = 'decision', gateConfig = {} } = structuredClone(input);
    if (!Array.isArray(handlers) || handlers.length > 32 || !this.gates.has(gate)) throw Error('Unknown gate or invalid handlers');
    for (const h of handlers) {
      if (!h || typeof h !== 'object' || !this.handlers.has(h.name)) throw Error('Unknown protocol handler');
    }
    return { handlers, gate, gateConfig };
  }
  async process(frame, context, profile) {
    // Identity is always transport-owned, never taken from normalized payloads/model output.
    const identity = Object.freeze({ owner: context.owner, connection: context.connection,
      listener: context.listener, eventId: context.eventId });
    const ctx = Object.freeze({ ...identity, signal: context.signal, send: context.send, correlate: context.correlate,
      binding: context.binding, gateConfig: structuredClone(profile.gateConfig) });
    let event = frame;
    for (const entry of profile.handlers) {
      context.signal?.throwIfAborted();
      const result = await this.handlers.get(entry.name)(event, ctx, structuredClone(entry.config ?? {}));
      if (!result || !outcomes.has(result.status)) throw Error('Invalid protocol result');
      if (result.status === 'pass') continue;
      if (result.status === 'handled') return { status: 'handled' };
      if (result.status === 'correlated') {
        if (!context.correlate || typeof result.correlationId !== 'string' || !result.correlationId) throw Error('Correlation adapter/id required');
        context.signal?.throwIfAborted();
        await context.correlate({ ...identity, correlationId: result.correlationId, event: result.event ?? event }, ctx);
        return { status: 'correlated' };
      }
      if (!Object.hasOwn(result, 'event')) throw Error('Forward result requires event');
      event = result.event;
      break;
    }
    context.signal?.throwIfAborted();
    const decision = await this.gates.get(profile.gate)(event, ctx, structuredClone(profile.gateConfig));
    if (!decision || !targets.has(decision.target)) throw Error('Invalid routing decision');
    const route = this.routes.get(decision.target);
    if (!route) throw Error('Selected route adapter not configured');
    context.signal?.throwIfAborted();
    await route({ ...identity, event }, ctx);
    return { status: 'routed', target: decision.target };
  }
}

/** Example extension: opt-in exact application-level JSON heartbeat, no model call. */
export function jsonHeartbeat(frame, context, { requestType = 'ping', responseType = 'pong' } = {}) {
  if (frame.encoding !== 'utf8') return { status: 'pass' };
  let value;
  try { value = JSON.parse(frame.data); } catch { return { status: 'pass' }; }
  if (!value || value.type !== requestType) return { status: 'pass' };
  return context.send(JSON.stringify({ type: responseType, ...(typeof value.id === 'string' ? { id: value.id } : {}) }))
    .then(() => ({ status: 'handled' }));
}

/** Deterministic rules first, with optional Decision Model fallback. */
export function ruleGate(rules, fallback) {
  return async (event, context, config) => {
    for (const rule of rules) {
      const decision = await rule(event, context, config);
      if (decision != null) return decision;
    }
    if (!fallback) throw Error('No routing rule matched');
    return fallback(event, context, config);
  };
}
