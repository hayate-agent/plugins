# Hayate Agent Plugins

Plugin adapters for [Hayate Agent](https://github.com/hayate-agent/core): commands,
channels, task delegation, context management and integrations for a persistent
AI assistant.

**To use Hayate, start with [Core's installation guide](https://github.com/hayate-agent/core#readme).**
Core includes a tested set of plugins. You do not need to install this repository
separately for a normal installation.

## Included adapters

- **Task delegation:** dispatcher commands and managed subagents.
- **Context and sessions:** compaction, handover, continuation and session observation.
- **Ongoing work:** loops, cron reports and nightly task strategies.
- **Gateways:** channel registration, routing and activity reporting.
- **Review and improvement:** review commands and experiment evaluation adapters.
- **Tools and memory:** memory commands, reloadable tools and optional Wasm tools.

The [manifest](manifest.json) lists the plugin entry points. Core provides the
underlying runtime, persistence, scheduling and policy enforcement.

## How plugins are used

Core pins a plugin revision and file hashes in `plugins.lock.json`, then
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

## Related projects

- [Core](https://github.com/hayate-agent/core) — runtime, terminal interface and documentation
- [Deployments](https://github.com/hayate-agent/deployments) — deployment examples

## License

[Apache-2.0](LICENSE).
