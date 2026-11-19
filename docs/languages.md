# Output language: first adapter increment

Core owns language resolution. Plugins must not maintain independent defaults or
infer language from host/control text. The optional read-only `language` service,
version 1, provides `resolve(scope)` and `render(catalogs, key, scope, values)`.
Service scopes: conversation (exact sessionKey), system, background, MCP (exact
server name); a validated explicit occurrence language takes precedence.

`src/output-language.ts` negotiates that service and preserves English behavior
on old hosts. A language preference is not execution authority, follow-up scope,
permission to retry or a reason to translate schema keys/enums/identifiers.

The cron report adapter now:

- retains an explicitly admitted job language in its durable report;
- preserves legacy report identity and absent language metadata on old hosts;
- instructs analysis to produce summary/action prose in the retained language;
- keeps JSON keys and authorization disposition enums unchanged;
- uses English for legacy reports without language, without rewriting them.

The matching Core change introduces job definitions (`language: es`), persistent
per-job language overrides, per-MCP preferences, per-turn language instructions,
external lifecycle catalogs and `/language` management.

This does **not** claim all existing plugin/UI/attention strings have been
migrated. Next steps include plugin-owned external catalogs and their immutable
materialization/packaging contract, migration of deterministic management/channel
messages, inherited presentation metadata on all worker/follow-up boundaries,
and end-to-end conversation-language observations. Keep stable technical codes
separate from translated human messages.
