# Hayate-to-Hayate overlay connection

A small HTTPS adapter and target endpoint, independent of WebUI. No Core asset
pins, additional runtime or dependency framework. It uses the existing version-1
workspace/agent-hub services and Core foreground admission. Pi/Claude Code/Codex
can get separate adapters later; this implementation does not pretend to support them.

## Explicit setup

Keep the overlay checkout separate from Core. On each participating host install
Node >=22.19 and a compatible Core providing execution contexts, service lookup
and foreground work. These capabilities are checked during plugin activation.

For a target accepting requests, load in this order:

```yaml
plugins:
  - /opt/hayate-plugins/credentials/index.mjs
  - /opt/hayate-plugins/workspace/index.mjs
  - /opt/hayate-plugins/agent-link/index.mjs
  - /opt/hayate-plugins/agent-hub/index.mjs
  - /opt/hayate-plugins/agent-link/server.mjs
```

A client-only central host omits the final target-server entry. `agent-link/index`
registers the outbound adapter before agent-hub loads it. The server entry registers
a host-owned channel; it only listens when the host starts its channels and drains
accepted requests when the host stops them.

`<home>/agent-hub.json`:

```json
{ "adapters": ["hayate"] }
```

`<home>/agent-link.json` on a central/client host:

```json
{ "peers": [], "allowOperatorTargets": true }
```

A target adds `listen` to its file:

```json
{
  "peers": [],
  "listen": {
    "host": "127.0.0.1",
    "port": 3211,
    "origin": "https://target.example.org:3211",
    "keyFile": "/absolute/private/key.pem",
    "certFile": "/absolute/fullchain.pem",
    "projects": { "central-project-uuid": "existing-local-project-uuid" }
  }
}
```

The example binds only to loopback. DNS, certificates, firewall and any external
bind address are explicit operator choices, never changed by installation. Native
TLS is mandatory. Keys must be private regular files owned by the process user.
With `allowOperatorTargets: true`, the authenticated operator can register additional
target origins through the UI without editing deployment files. The default remains
allowlist-only; `peers` can still specify private CA trust per target. Both modes
accept canonical HTTPS origins only and verify certificates
against system trust; an optional per-peer `caFile` adds an explicit operator CA.
There is no `rejectUnauthorized:false` option or redirect following.

The project map is the complete set of target projects exposed by this endpoint.
It maps an origin-side project's ID to an existing target-side project. All paired
peers see only mapped projects, restricted further by their granted capability
names. There is no per-peer project selector yet: use separate endpoint/host trust
boundaries if peers must see different project sets. A peer cannot supply cwd or
clone paths; created streams use the target project's existing local directories.

## Pair and use

On the **target**, generate a five-minute, single-use code with
`/agent-hub pair https://central.example.org`
from an administrator TUI/messaging session, or with the WebUI registration-code
button. The slash command returns the target endpoint, code, expiry and optional
WebUI origin. It refuses to imply usable pairing if the target endpoint is not
installed. The WebUI address is guidance, not an automatic credential destination;
codes are never embedded in URLs. The code is temporary pairing authority, not a reusable password. Store
and transport it accordingly. Only its hash is persisted by the target.

On the **central** WebUI: Projects → workspace menu → Agents → Register an agent.
Choose adapter `hayate`, the allowlisted target HTTPS origin, its code and a display
name/color. The browser submits the code once; the returned peer token stays in the
server vault and is never returned to the browser. Open streams to view/send target
work. A project's dashboard also resolves the target mapping, lists local and
remote streams and offers the target in the shared composer. While visible, the
selected project's remote state refreshes every five seconds, with manual refresh
available. This is bounded read-only polling, not federated SSE or automatic
productive request retry. Unavailable/unshared/unsupported targets are displayed
explicitly; the composer never silently falls back to another agent.

Headless administrators can use the same services/commands:

```text
/agent-hub connect {"adapter":"hayate","endpoint":"https://target.example.org:3211","code":"<temporary-code>","name":"Target"}
/agent-hub request {"agentId":"<registration-id>","capability":"streams","input":{"action":"list"}}
/agent-hub sync <local-project-id>
/agent-hub remove <registration-id>
```

Only temporary pairing codes belong in the connect flow; never paste vault tokens
or passwords into a command/transcript. Shared settings use the explicit project
mapping. Project sync sends only ID/title/settings, not the central cwd. Individual
failures are returned to the caller. Target work still enters its normal workspace
channel, host queue, approvals, tool policy and durable reply delivery.

The protocol supports `projects` (list/resolve/apply), `streams` (list/create), `messages`
(read/send/mark-read) and `activity` (list), gated by the issued code's capabilities. Message
submission requires the original stable UUID on retries. The WebUI preserves an
unconfirmed remote send in session storage, without automatically resending it.
Creating a stream from the shared composer also uses a stable creation UUID; the
workspace stores/deduplicates it before any work is submitted. Targets advertise
`idempotent-stream-create` and `read-markers` in the mapping response. The UI only
offers these additions when advertised, so independently updated overlays do not
need an exact revision match. Mapping/stream failures do not retarget work.

## Revocation and failure handling

- The target stores only peer-token hashes; the client stores plaintext tokens only
  in its encrypted vault. Tokens expire after 30 days by default; target
  `listen.tokenLifetimeMs` may be explicitly set between one second and 365 days.
- Removing a Hayate registration first revokes the token on the target. If the
  target is unavailable, the local registration is retained for an explicit retry.
  Revocation is idempotent; it does not replay productive work.
- Target administrators can use `/agent-link list` and `/agent-link revoke <id>`
  without the central host. Revoked/expired tokens cannot submit further requests.
- A lost pairing response can leave an orphan target grant. List/revoke it on the
  target before pairing with a new code. Codes are not restored or silently reused.
- A lost productive response has unknown outcome. Read the target stream and retry
  only with the same message ID when appropriate. No automatic reconnect retry or
  assumption that an HTTP error means no work occurred.
- Target API requests reject browser Origin/Cookie headers, enforce canonical Host,
  JSON/body bounds and bounded concurrent pairing. It exposes no login/CORS or
  generic shell endpoint. TLS calls have absolute timeouts and no connection pool.

## Verification without live exposure

```sh
node --test agent-link/test/*.test.mjs
HARNESS_CORE_ROOT=/path/to/core node --import /path/to/core/node_modules/tsx/dist/loader.mjs --test agent-link/test/*.test.mjs
npm run test:browser --prefix webui
```

Temporary loopback certificates are explicitly trusted as test CAs, not bypassed.
Tests cover pairing replay, certificate rejection, allowlist/scope/project checks,
settings propagation, message/reply delivery, expiry/revocation and the actual Core
plugin/channel registration, deduplication and update admission. The Chromium test
registers a target through the authenticated central UI, sends remote work and
verifies target authorization is revoked when the registration is removed.
