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

## Matrix activity output

Matrix displays native activity, including Dispatcher and Worker runs, by default.
Set `MATRIX_NATIVE_ACTIVITY=false` to disable this output explicitly.
`MATRIX_NATIVE_ACTIVITY_COALESCE_MS` controls update coalescing (default: 1000 ms).
This switch is independent of the legacy `MATRIX_PROGRESS` setting.

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

## Nightly delivery

The default nightly strategy distinguishes assigned skill/instance repositories,
private product variants and deliberate upstream contributions. Core/WebUI/plugin
adaptations can remain in assigned non-upstream repos as reproducible, versioned
variants; upstream is not mandatory for every local improvement. Product-source
changes require independent external review before integration/live activation,
including private variants. Self-review, CI or a different merger alone do not
suffice. Existing external review workflows supply evidence; required Forgejo
approvals remain0. Missing review is a concrete blocker, not a self-grant.
Good tested changes should be committed, pushed and handed into the normal
integration/release path using existing authority, not left as local proposals.
Repo owners are resolved from configuration/SOUL/remotes, not invented by the
strategy. Existing operator scope, credentials, protection and time budgets remain.

Experiment receipts may carry structured `delivery` evidence: stream, local /
pushed / integrated / deployed / blocked status, repository, branch, full commit,
optional PR, activation evidence or concrete blocker. The strategy distinguishes
reported facts from independent verification. A push is not deployment. It can
update delivery on retained candidates without counting another experiment;
compatible Core hosts retain unactivated candidates across nights. Missing legacy
evidence is unverified, not proof of non-publication. Blockers stay visible and
unsafe candidates can be rejected. No blanket merge restriction or new permission
is introduced. See Core's nightly controller documentation for host persistence
and closure semantics.

## Memory turn handoff

[Latest turn handoff](docs/memory-handoff.md) describes the bounded deterministic
MemoryService record, provider-authoritative latest lookup, legacy pending-payload
preservation and focused peer-Core contract checks. It does not prune host history
or grant replay authority.

## Public snapshot updates

The public repository receives reviewed source snapshots through publishing pull
requests. Changed exports are tested against the public Core before integration;
unchanged snapshots do not require another release. The independent
[WebUI frontend](https://github.com/hayate-agent/webui) remains in its own
repository, while the dashboard API and agent services are maintained here.

## License

[Apache-2.0](LICENSE). This covers the plugin source and backend packages;
Core, WebUI and deployment examples publish their own license files.
