# Generic WebSocket overlay

Independent Hayate API-v1 plugin, unrelated to AgentLink and the Web dashboard.
The entry point is `websocket/index.mjs`. Run `npm ci --ignore-scripts` in this
folder before configuring this local plugin entry point in your Hayate plugin
configuration. Distribution through the central manifest/lock is not yet wired.
Do not copy only index.mjs: service.mjs, ingress.mjs and the installed ws dependency are needed.

**Ingress extension API:** see [EXTENSIONS.md](EXTENSIONS.md) for protocol handlers,
application heartbeats, per-resource profiles, live reassignment, rules and
Decision routing. The default gate is `decision`; the matching Core bridge
provides service `ingress` version 1 for actual isolated Decision/Basic inference
and durable Dispatcher admission. Configure explicit model pairs in
`profile.gateConfig.decision` and `.basic` (see EXTENSIONS). Older hosts need
trusted factory adapters or fail explicitly. The stock entry point does not silently route unknown
traffic to Main. Explicit `profile: {"gate":"main"}` opts into direct Main routing.

## Tool

Enable `plugin_websocket` when using an explicit tool allowlist. Actions:

- `listen`: optional `host` (default `127.0.0.1`), `port` (default ephemeral),
  `token` (optional incoming Bearer authorization). Returns listener ID/address.
- `connect`: `url` (`ws://` or `wss://`), optional `headers`, PEM `ca`, and
  `reconnectMs` (0 disables reconnect, maximum 300000). Returns connection ID.
- `list`: only lists the calling session's resources; accepted peers have their
  own connection IDs and identify their listener.
- `send`: `id`, `data`, optional `encoding` (`utf8` or `base64`). Text stays text;
  base64 sends binary frames. Successful send is transport acceptance, not a
  remote application acknowledgment. No send retries or message replay.
- `close`: `id` of a connection or listener. Closing a listener closes its peers.
- `configure`: `id` and `profile` select registered handlers/gate on an existing
  resource; listeners propagate changes to existing peers. `connect` and `listen`
  also accept `profile`.

Clients and listeners outlive a tool call, but are intentionally not restored
across agent restart. Client reconnect retains its ID. An initial failed handshake
returns an error and leaves no background retry; reconnect applies after a
successful connection. There is no offline send queue.

## Incoming frames and replies

When a host-bound frame selects `main`, the stock plugin calls
`binding.main(eventId, input, send, connection)` on Core's `ingress` service.
Core runs real Main in a separate Harness session while retaining the creator's
original task ID, scope and deadline. The frame remains untrusted ingress data,
not a new operator instruction. Replies go only to the originating connection;
this does **not** inject a message into the original Matrix/console conversation.
Missing adapters, revocation and failed/uncertain admission never fall back to
normal channel delivery. Core persists request reservations before admission;
restart does not recreate a live socket/authority capability or replay requests.

The JSON envelope contains owner, connection, listener, event ID and normalized
event (raw frames include encoding/data). Sending from the original session uses
the tool and its session-owned connection ID. A trusted factory without a host
binding can still supply its own native channel adapter explicitly.
Anonymous peers do not get a trusted sender identity; remote command admin
configuration and all normal host approvals still apply.

## Limits and deployment

Default limits: 64 total connections, 16 listeners, 1 MiB frames, 32 pending
inbound deliveries per connection, bounded send buffers. Delivery is ordered per
connection. Queue overload closes that socket; failed delivery closes it without
replaying application effects. Cleanup is idempotent on both channel stop and
plugin stop. An in-flight host delivery cannot be recalled by socket close.

Incoming listeners serve plain WS. For WSS, use an operator-managed TLS reverse
proxy. Outbound WSS validates certificates normally, with optional custom CA.
Binding to a non-loopback interface explicitly exposes a service; configure
Bearer authentication and network access appropriately. Omitted token means an
unauthenticated listener. Tool arguments may be retained in conversation history:
do not paste long-lived credentials into prompts; use deployment-level secret
injection for production credentials. Returned resource listings omit URLs,
headers and tokens; connection errors are sanitized.

## Verification

`env -u LD_LIBRARY_PATH npm test` runs local loopback-only tests for persistent
client/server messaging, text/binary delivery, owner isolation, token auth,
failed-handshake cleanup, reconnect without replay, payload limits, cancellation,
and plugin/channel lifecycle. The stock-entrypoint host-contract test checks
zero-model heartbeats, distinct Decision/Basic models and socket-only Dispatcher
receipts/results. Core has separate SDK-HTTP and real durable Dispatcher/store
reload tests; no fixture is evidence of live provider authentication. No external
service, Matrix message or agent restart is used. This overlay has not been published or activated by these tests.
