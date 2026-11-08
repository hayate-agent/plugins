# Hayate Agent Plugins

Plugin adapters for [Hayate Agent](https://github.com/hayate-agent/core): commands,
channels, task delegation, context management and integrations for a persistent
AI assistant.

Optional standalone gateway: [Slack Socket Mode installation](docs/slack-gateway.md)
([app manifest](examples/slack-app-manifest.json)). This local ESM module is
installed explicitly, not fetched or enabled automatically by Core.

**To use Hayate, start with [Core's installation guide](https://github.com/hayate-agent/core#readme).**
Core includes a tested set of plugins. You do not need to install this repository
separately for a normal installation.

## Headless workspace and agent overlay (development)

[Workspace architecture and setup](docs/workspace-architecture.md) describes the
independent `workspace/`, `credentials/`, `git-catalog/`, `identity/` and `agent-hub/` packages.
They own backend state and integrations; the optional WebUI consumes their services.
External agent runtimes are future adapters, not dependencies of the frontend.
This overlay is installed and updated separately from Core. It checks required
host capabilities and service versions; Core need not pin its exact revision or
bundle it.
[Explicit authenticated HTTPS](docs/authenticated-webui.md) protects the API;
[Hayate-to-Hayate HTTPS connectivity](docs/agent-link.md) is implemented as an
optional headless adapter/endpoint; external runtimes remain future adapters.

## Included adapters

- **Task delegation:** dispatcher commands and managed subagents.
- **Context and sessions:** compaction, handover, continuation and session observation.
- **Ongoing work:** loops, cron reports and nightly task strategies.
- **Gateways:** channel registration, routing and activity reporting.
- **[Dashboard API](dashboard-api/README.md):** authenticated HTTP/SSE access to
  conversations and backend services. Contains no browser assets or frontend build.
  The [WebUI](https://github.com/hayate-agent/webui) is a separate project.
- **Review and improvement:** review commands and experiment evaluation adapters.
- **Tools and memory:** memory commands, reloadable tools and optional Wasm tools.

The [manifest](manifest.json) lists the plugin entry points. Core provides the
underlying runtime, persistence, scheduling and policy enforcement.

## How plugins are used

For its existing bundled TypeScript adapters (not the optional overlay), Core
pins a plugin revision and file hashes in `plugins.lock.json`, then
materializes those sources at build time. Published Core checkouts include their
matching sources for offline materialization. Plugin code is not downloaded on
each agent turn.

Plugins are **trusted code with the agent process's permissions**. Review modules
before enabling them. Plugins do not grant permission to bypass tool approvals,
access rules or task boundaries.

## Develop a plugin

Clone this repository alongside a compatible Core checkout:

```sh
git clone https://github.com/hayate-agent/core.git
git clone https://github.com/hayate-agent/plugins.git
```

Follow the [plugin API guide](https://github.com/hayate-agent/core/blob/main/docs/plugins.md)
for commands, tools, channels and lifecycle hooks. Built-in adapters use Core's
TypeScript interfaces; their compatibility gate is Core's typecheck and tests.
For local changes, use Core's materializer with an explicit local source directory
and matching development lock, as described in its
[development guide](https://github.com/hayate-agent/core/blob/main/docs/development.md).

Submit focused pull requests with tests for changed behavior. Never commit
provider credentials, agent identities or deployment-specific configuration.

## Which repository should I use?

| Goal | Project |
| --- | --- |
| Run the agent or use its terminal interface | [Core](https://github.com/hayate-agent/core) |
| Add integrations or backend services | This repository |
| Use the browser dashboard | [WebUI](https://github.com/hayate-agent/webui) |
| Start from deployment examples | [Deployments](https://github.com/hayate-agent/deployments) |

## Related projects

- [Core](https://github.com/hayate-agent/core) — runtime, terminal interface and documentation
- [WebUI](https://github.com/hayate-agent/webui) — independent browser dashboard; consumes the backend API
- [Deployments](https://github.com/hayate-agent/deployments) — deployment examples

## Public snapshot updates

The public repository receives reviewed source snapshots through publishing pull
requests. Changed exports are tested against the public Core before integration;
unchanged snapshots do not require another release. The independent
[WebUI frontend](https://github.com/hayate-agent/webui) remains in its own
repository, while the dashboard API and agent services are maintained here.

## License

[Apache-2.0](LICENSE). This covers the plugin source and backend packages;
Core, WebUI and deployment examples publish their own license files.
