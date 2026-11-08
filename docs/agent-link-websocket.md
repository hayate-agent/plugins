# Outbound AgentLink over WebSocket

An agent can initiate a persistent WSS connection to the central dashboard. The
central instance sends scoped RPC requests and receives replies over that same
connection. The target needs outbound HTTPS access, not an inbound listening port,
NAT rule, Tailscale membership or a second agent runtime.

Direct AgentLink HTTPS remains supported. This transport is selected explicitly;
it does not automatically resend productive requests over another path.

## Central instance

Install the independently released backend overlay. Enable these startup plugins
in order, preserving other agent-specific modules:

```yaml
plugins:
  - /installed-overlay/credentials/index.mjs
  - /installed-overlay/workspace/index.mjs
  - /installed-overlay/agent-link/index.mjs
  - /installed-overlay/agent-link/relay.mjs
  - /installed-overlay/agent-hub/index.mjs
  - /installed-overlay/dashboard-api/index.mjs
```

`agent-link-relay.json`:

```json
{"origin":"https://dashboard.example.org"}
```

`agent-hub.json`:

```json
{"adapters":["hayate","hayate-wss"]}
```

The API-only dashboard gateway provides native TLS and the identity service as
usual. Add the identity plugin where authenticated network administration is
used. Deploy the independent WebUI with a verified HTTPS upstream to that API.
The frontend forwards only the fixed enrollment/leave paths and authenticated
WebSocket upgrade path, not arbitrary tunnels. Both the standalone frontend and
combined administration use the same relay service and protocol.

Public paths on the dashboard HTTPS origin:

- `POST /api/agent-link/v1/enroll`: one-use invitation exchange.
- `GET /api/agent-link/v1/connect`: authenticated WebSocket upgrade.
- `POST /api/agent-link/v1/leave`: authenticated target-initiated revocation.

Browser administration uses authenticated `/api/workspace/agent-relay` routes;
agent connections use separate scoped credentials, never browser cookies.

## Target agent

Enable `credentials/index.mjs`, `workspace/index.mjs` and
`agent-link/outbound.mjs`. No `agent-link/server.mjs` listener is required.

`agent-link-outbound.json`:

```json
{
  "relays":[{"origin":"https://dashboard.example.org"}],
  "capabilities":["projects","streams","messages","activity"],
  "projects":{},
  "shareStandalone":true
}
```

Local project mappings remain explicit. Empty mappings grant no access to local
projects; `shareStandalone` independently permits chats without a project. The
central invitation can reduce, but not expand, the target's capability list.
For private certificate authorities, an operator may configure a local `caFile`
on a relay entry. Certificate verification and hostname checks remain enabled.
`allowOperatorRelays:true` optionally permits operator-entered trusted HTTPS
origins without enumerating them; the default is the explicit relay allowlist.

Startup changes use the agent's normal configuration owner and fresh update
admission. Installing the overlay alone does not enable either side.

## Manual enrollment and approval

1. Centrally: **Agents → Invite outbound agent**. Choose a name and get a masked,
   single-use invitation, valid for five minutes.
2. On the target: **Agents → Connect this agent outbound**, or as administrator:
   `/agent-link-outbound enroll https://dashboard.example.org <invitation-code>`.
3. Centrally: refresh incoming connections, inspect identity and permissions, then
   choose **Approve and register**. Merely opening a socket does not register an
   agent or grant permission to execute work.
4. Use the registered agent through the normal AgentHub API and dashboard.

Headless central commands: `/agent-relay invite <name>`, `list`, `accept <id>` and
`reject <id>`. Target commands: `/agent-link-outbound status` and `disconnect`.
Codes must not appear in URLs or permanent browser storage. Permanent tokens stay
in backend vaults; relay state stores only token hashes.

## Failure and lifecycle behavior

- TLS must validate at both hops. Redirects, browser-cookie authentication and
  arbitrary proxy destinations are not supported.
- Ping/pong detects stale sessions; reconnect has bounded exponential backoff.
- An expired/revoked authorization stops reconnecting until operator action.
- Reconnect creates a new connection generation. Pending requests on a lost
  connection fail with an explicit unknown-outcome error; they are never replayed.
- Explicit message retry retains the original message UUID. Stream creation over
  WSS requires an idempotency UUID. Core ingress remains responsible for durable
  acceptance and deduplication, including after transport loss.
- Cancelling a wait does not cancel already accepted agent work. Target shutdown
  fences new input and drains entered work before releasing lifecycle ownership.
- Idle sockets do not block update admission. Enrollment, administration and RPC
  calls participate in foreground-work admission.
- Frames, pending requests, connections and response buffers are bounded. There
  is no interactive shell, generic HTTP forwarding or private host-control API.
- Removing the registration revokes the outbound authorization and closes the
  live socket. It does not delete histories or undo previously accepted work.

## Build and test

```sh
npm ci --prefix agent-link --include=dev --ignore-scripts
npm run build --prefix agent-link
node --test agent-link/test/*.test.mjs
```

The build packages the pinned `ws` implementation and its license under
`agent-link/vendor/` for standalone overlay installation. No runtime npm install
or new Core revision pin is required. Real Core-host tests additionally exercise
host ownership, immutable cwd, durable deduplication and idle update admission.
