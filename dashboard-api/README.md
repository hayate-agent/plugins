# Dashboard API

API-only native gateway for the independently deployed
[Hayate WebUI](https://git.vanillacore.net/harness/webui). This package contains no
HTML, CSS, browser JavaScript, frontend dependencies or browser build.

It owns HTTP/SSE projection of agent-owned conversations and delegates workspace,
identity, credentials and peer operations to their respective backend services.
It does not execute another agent runtime.

## Install

Configure the gateway module as `dashboard-api/index.mjs` in your separately
installed plugin overlay. Keep the existing gateway/channel name `webui`:

```yaml
gatewayPlugins:
  webui:
    module: /absolute/path/to/plugins/dashboard-api/index.mjs
```

The gateway name, host session keys `webui:<id>`, retained
`<agent home>/webui/conversations.json` and configuration files
`webui-network.json` / `webui/ui.json` are stable data/configuration identifiers.
Changing the package directory must not rename them or duplicate existing chats.

The optional settings tool remains an API/backend presentation contract for
operator-controlled declarative settings and trusted module lifecycle; there are
no browser renderers in this package.

## MCP management

With a Core version that provides native MCP user management, type `/mcp` in the
conversation UI. The gateway delivers it as an authenticated channel command;
it is not an agent instruction or a `/v1/runs` model request. Status, server
configuration and OAuth authorization links/results use the same conversation.
`/mcp help` lists the operations. Enroll the actual WebUI actor in the Core
administrator configuration when privileged user commands are restricted.
OAuth browser approval remains with the user; do not paste access/refresh tokens.

## Network

Absent explicit network configuration, bind to loopback. Network access requires
native TLS, exact canonical Host/Origin and a configured identity service.
Authentication sessions and peer tokens remain backend-owned. Unknown routes and
all former static asset paths return 404.

Deploy the standalone dashboard against this API before upgrading an installation
that previously depended on embedded assets. Update the module path through its
configuration owner and use fresh host update admission before runtime replacement.
Do not remove retained history, credentials, approvals or execution contexts.

## Tests

```sh
npm test --prefix dashboard-api
node --import ./core/node_modules/tsx/dist/loader.mjs dashboard-api/test/host.mjs ./core
```

Frontend builds and browser tests belong to the WebUI repository.
