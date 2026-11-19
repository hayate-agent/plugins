# Extensible ingress: protocol handlers and routing gates

## Implemented boundaries

```
ws library (native ping/pong)
  -> bounded, ordered frame queue
  -> selected protocol handlers
       handled       -> done, no model
       correlated    -> correlation adapter, no new Main task
       pass          -> next handler
       forward       -> normalized event -> gate
  -> selected gate (rules first, optional Decision Model)
  -> mechanical | basic | dispatcher | main route adapter
```

No handler claiming a frame means the original frame reaches the gate. `forward`
ends the protocol chain and sends its normalized event to the gate. The default
gate is `decision`. There is deliberately **no implicit fallback to Main**.
Missing model/route adapters and invalid extension results fail processing and
close the connection with a generic delivery error. Received frames are not
replayed. Client reconnect never replays application messages.

**Host integration:** the stock plugin discovers Core service `ingress` version 1.
The matching Core bridge binds the current operator mandate when `connect` or
`listen` executes; the binding stays with that resource and accepted peers. It is
not selected from incoming payloads or rebound when another task uses the session.
Decision and Basic run isolated, tool-free SDK inference using explicit models.
Dispatcher uses durable admission under the captured original task; its receipt
is not worker completion. Worker result/status/question output returns to the
socket, never the ordinary chat. A lost socket does not trigger chat fallback or
application-message replay. Durable results remain in the execution store.

Set `profile.gateConfig.decision` and `.basic` to model pairs, for example:

```json
{"gate":"decision","gateConfig":{"decision":{"model":"provider/decision-model","thinking":"off"},"basic":{"model":"provider/basic-model","thinking":"off"}}}
```

The names above are placeholders; configure actual available models. Missing
service, model, provider credentials or adapters fail explicitly, without Main
fallback. `main` is not the default. For host-bound resources it requires an
explicit authority-preserving `routes.main` adapter: ordinary channel admission
would otherwise create a new task from untrusted network input. The legacy
unbound/custom-factory path retains its explicit channel route. Correlation
and custom mechanical routing still require trusted adapters. The matching Core
changes and plugin changes must both be installed; local tests are not activation
receipts. No provider billing request or production activation is claimed.

## Trusted extension module

The normal ESM export remains an API-v1 Hayate plugin. An operator-owned entry
module can use `createWebSocketPlugin` to inject existing host integrations:

```js
import { createWebSocketPlugin, ruleGate } from './websocket/index.mjs';

// These functions are supplied by your trusted deployment, not remote messages.
export function configure({ decide, basic, dispatch, correlate, storeStatus }) {
  return createWebSocketPlugin({
    decide, // async (event, context, gateConfig) -> { target }
    correlate, // async ({owner, connection, listener, eventId, correlationId, event}, context)
    routes: { basic, dispatcher: dispatch, mechanical: storeStatus },
    extend(ingress) {
      ingress.registerHandler('device-json', async (frame, context, config) => {
        if (frame.encoding !== 'utf8') return { status: 'pass' };
        let value;
        try { value = JSON.parse(frame.data); } catch { return { status: 'pass' }; }
        if (value.type !== 'device-status') return { status: 'pass' };
        return { status: 'forward', event: { kind: 'status', value } };
      });
      ingress.registerGate('device-routing', ruleGate([
        event => event.kind === 'status' ? { target: 'mechanical' } : null,
      ], decide));
    },
  });
}
```

A Decision adapter returns **only** `{ target: 'mechanical' | 'basic' |
'dispatcher' | 'main' }`. It gets the normalized event plus transport-owned
context; model-selected owner/session/connection fields are never used. The gate
selects work, it does not create new permission. Route adapters must retain the
original operator scope, origin and required host admission/approval checks.
Incoming network content is not an operator mandate. Dispatcher adapters must use
host-owned durable admission, not shell calls or copied credentials.

No dynamic imports, file paths or executable code are accepted from WebSocket
data or tool configuration. `extend` is trusted local code, not a new global
Core plugin registration API. Adding modules can be done through a wrapper;
changing extension code requires the supported plugin lifecycle. This is not
hot-code reload or individual plugin unload.

## Handler contract

`registerHandler(name, async (event, context, config) => result)`.

- `context`: owner, connection, optional listener, eventId, AbortSignal,
  `send(data, encoding = 'utf8')` and optional correlation adapter.
- `config`: per-selection structured clone, not shared mutable plugin state.
- Results: `{status:'pass'}`, `{status:'handled'}`,
  `{status:'forward', event}`, or `{status:'correlated', correlationId, event?}`.
- Return `handled` only after the intended action succeeded. The infrastructure
  invokes the correlation adapter for `correlated`; a missing adapter is an error,
  not a silently discarded reply. That adapter must validate the existing job.
- Honor the AbortSignal and settle promptly. Cancellation fences routing after
  await, but cannot retract an already-started external effect or forcibly
  terminate a hung trusted in-process module.

The included `json-heartbeat` is an **optional extension**, not hard-coded in the
transport. It matches an exact JSON `type` (default `ping`), sends `pong`, preserves
only a string `id`, and returns handled. Binary/non-JSON/other types pass through.
Native WebSocket ping/pong stays with `ws` and never enters this pipeline.

## Per-connection/listener configuration

`connect` and `listen` accept a `profile`:

```json
{
  "handlers": [
    {"name":"json-heartbeat", "config":{"requestType":"heartbeat", "responseType":"alive"}},
    {"name":"device-json", "config":{}}
  ],
  "gate":"device-routing",
  "gateConfig":{}
}
```

Use `plugin_websocket` action `configure`, resource `id`, and `profile` to change
an existing resource without reconnecting it. Names must be registered. Ownership
is checked. Listener changes affect existing and future peers; a received frame
retains the profile active when it arrived. Client reconnect preserves its profile.
Only local tool input selects handlers/gates; normalized remote payloads cannot
change the configuration. Profiles default to no protocol handlers and the
Decision gate. Configuration is in-memory, not durable across agent restart.

Main-route events retain the dedicated `websocket` channel namespace, original
owner association and connection reply target. They are not posted to the
original console/Web/Matrix room. Mechanical/basic/dispatcher adapters do not
traverse Main unless they explicitly choose to. Normal channel replies can send
on accepted peers; the tool remains owner-scoped to the creating session.

## Tests and remaining delivery work

`npm test` covers all four handler outcomes, exact heartbeat interception before
any decision/model route, deterministic rules and fallback, all four routing
targets, malformed/missing adapters, cancellation, non-forgeable transport
identity, owner isolation, and live listener reconfiguration. Existing transport,
authentication, reconnect and binary tests remain included.

The Core bridge tests SDK HTTP serialization, strict Decision parsing, separate
Basic operation, host-owned authority, foreground admission and socket-only
Dispatcher output. Plugin loopback tests exercise the stock entrypoint with the
host service contract; they do not prove a live provider or real worker deployment.
Production packaging, full cross-repository end-to-end verification and activation
remain separate delivery work; no test fixture is an activation receipt.

Current limits: host routing retains up to 1024 Dispatcher request reservations per
process, including uncertain admissions, to prevent blind replay. Socket delivery
is not durable and is not resumed after restart. Questions are delivered to the
socket, but application-specific question/answer correlation must be supplied by
a trusted protocol module; no arbitrary network text becomes an operator answer.
