# Headless workspace plugins and optional WebUI

This is a separately installed agent overlay, not part of the Core distribution.
It requires compatible Core execution-context, version-1 service-registry and
foreground-work contracts, checked when plugins activate. It does not require Core
to pin or package an exact overlay revision. Older hosts without these contracts
are unsupported; do not overwrite managed Core files to install it.

## Ownership

| Package | Responsibilities | Browser required? |
| --- | --- | --- |
| `workspace/` | Projects, subprojects, immutable stream execution directories, organization, settings inheritance, persistent messages and unread revisions | No |
| `credentials/` | Write-only submissions, encrypted local vault, optional OpenBao KV-v2, trusted secret-provider service adapters | No |
| `git-catalog/` | Configured Forgejo/GitHub organization/repository inventory and local-checkout mappings | No |
| `agent-link/` | Explicitly configured HTTPS Hayate adapter and headless target endpoint | No |
| `agent-hub/` | Agent identities/presentation, one-use target codes, credential references and adapter-based requests/project synchronization | No |
| `identity/` | Single-operator scrypt authentication, audience-bound sessions and revocation | No |
| `dashboard-api/` | Authenticated HTTP/SSE projection of backend services and retained conversations; no browser assets | Yes |

Core owns transport-neutral execution-context binding and versioned in-process
service discovery. It does not own project records, vault implementations, HTTP
routes or federation policy. Model runtime, persona resources, tools, policy hooks,
formal review adapters and host-owned worker descendants resolve the stream's cwd.
Moving a stream in the project tree is organization only and never retargets execution.

Services are trusted in-process capabilities, not sandbox boundaries. `operator`
is the current single-operator principal shared with admin commands. Multiuser hosting is not implemented. [Explicit authenticated HTTPS](authenticated-webui.md)
is now available in development via the separate identity plugin and operator-owned
TLS configuration; it preserves the existing operator principal. Absent explicit
configuration, the WebUI remains exact-loopback only. Do not expose legacy mode
with a public proxy; no forwarded-header trust is inferred.

## Installation layout

Keep this overlay checkout (the package directories and `shared/`) together in a
trusted, operator-owned location, separate from Core's release directory. Update it
independently through the normal stop/update/restart workflow. Node must be at least
22.19; plugin API and service contracts are version 1. Features check the actual host
capabilities instead of requiring a matching Core Git revision. Once those contracts
are in a released Core version, document that minimum version here; do not invent a
minimum release number for the currently unreleased contracts.

Enable ESM entry points explicitly using Core's `plugins` configuration:

```yaml
plugins:
  - /opt/hayate-plugins/credentials/index.mjs
  - /opt/hayate-plugins/workspace/index.mjs
  - /opt/hayate-plugins/git-catalog/index.mjs
  - /opt/hayate-plugins/agent-hub/index.mjs
```

The last two entries are optional. Configure any `secret-provider-<name>` or
`agent-adapter-<name>` version-1 service before its consumer. Backend packages have
no browser dependencies; install/build WebUI separately as documented in its README.
Existing standalone chats remain available using the Projects/Chats toggle and
nonempty histories attach automatically under Existing chats. Project moves and
conversion preserve the original `webui:<id>` runtime key and original transcript;
workspace submission delegates back to that original gateway. No model history is
copied or reset, and the host context is never retargeted by project organization.

Configuration files in the agent home:

- `workspace.json`: optional `{ "roots": ["/srv/work"] }`; defaults to the host cwd.
  Picker and project creation enforce realpath containment, including symlinks.
- `credentials.json`: optional `{ "provider": "local" }` (default), or provider
  `openbao` with `address` (canonical HTTPS origin), `mount`, `prefix` and `tokenFile`.
  Other names resolve `secret-provider-<name>` implementations.
- `git-catalog.json`: required when enabling Git inventory; example below.
- `agent-hub.json`: optional `{ "adapters": [] }`; configured adapter names resolve
  trusted `agent-adapter-<name>` implementations.

```json
{
  "providers": [{
    "id": "company",
    "kind": "forgejo",
    "origin": "https://git.example.org",
    "credential": "vault-entry-id",
    "checkouts": { "team/application": "/srv/work/application" }
  }]
}
```

Git inventory is read-only. Repositories without an operator-configured local
checkout are displayed but cannot become execution contexts. Automatic clone,
credential injection into Git subprocesses, arbitrary password-manager commands
and remote write operations are deliberately absent. GitHub's API origin should
be `https://api.github.com`.

## Headless operation

Admin commands work without installing WebUI:

```text
/workspace project {"title":"Application","cwd":"/srv/work/application"}
/workspace stream {"projectId":"<project-id>","title":"Investigate"}
/workspace send {"streamId":"<stream-id>","id":"<stable-message-id>","text":"Inspect the checkout"}
/git-catalog providers
/git-catalog orgs company
/git-catalog repos company team
```

`workspace`, `credentials` and `agent-hub` also register version-1 services for trusted
frontends/integrations. Secrets are consumed only through backend `withSecret`
callbacks. Listing/UI/commands return metadata, never plaintext. Local encryption
protects files at rest, not against the same OS user or unrestricted agent shell
access. Restrict host filesystem/tool permissions accordingly.

[Hayate-to-Hayate connectivity](agent-link.md) is implemented as a separately
configured HTTPS adapter/endpoint. Pi, Claude Code and Codex remain future adapters.
Codes are
hashed in state and consumed atomically once. Adapters must validate target identity,
request scope and HTTPS before returning server-held tokens. Project synchronization
is explicit and returns per-agent failures; productive requests are not silently
retried. External-agent support should implement these adapters, not fork the UI.

## Verification

```sh
node --test workspace/test/*.test.mjs credentials/test/*.test.mjs git-catalog/test/*.test.mjs agent-hub/test/*.test.mjs identity/test/*.test.mjs agent-link/test/*.test.mjs
node --import ../core/node_modules/tsx/dist/loader.mjs workspace/test/host.mjs ../core
npm ci --prefix webui --include=dev
npm run build --prefix webui
npm test --prefix webui
npm run test:browser --prefix webui
npm test --prefix dashboard-api
# Frontend/browser tests run in the separate harness/webui repository.
```

The real-host headless test covers channel/service registration, commands, context
binding, durable replies, retry deduplication and update admission without an HTTP
server. Core's execution-context runtime test exercises actual PI bash/plugin tools
concurrently in two directories and a worker-inherited directory. The review adapter tests also run the real formal-review service against two
independent Git changesets while the startup cwd is not a repository. Immutable
compatibility with the first Core release providing the required contracts remains
to be verified. Overlay updates do not require changing Core's asset/source locks.

No additional repository or frontend framework is needed for this separation.
A later repository extraction must preserve these service contracts and version
compatibility rather than move domain logic back into the browser.
