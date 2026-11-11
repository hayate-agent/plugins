# Memory consolidation policy plugin

`src/memory-consolidation.mjs` implements a bounded, persistent consolidation
orchestrator. Core PR #315 supplies the trusted host adapter (merged as
`66d4882b207440dd9a772570619615f66ed8ab2f`). A host must run that revision or newer
and configure `memory.consolidation` to register service version 1 before loading
this module. Installing this source alone does not activate consolidation.

Service contract:
- `tier`: explicit `frontier` (2 hours) or `local` (12 hours).
- `capture(turn)` / `recall(sessionKey, text)`: existing memory service delegation.
- `put({sessionKey}, entry)`: current memory provider, preserving session isolation.
- `summarize({sessionKey, requestId, sources, instruction})`: isolated, no-tool,
  low-cost model execution. The adapter owns model configuration, cancellation,
  bounded execution, authorization and durable dispatcher dedup by requestId if
  implemented via the dispatcher. No additional authority is inferred from data.
- Optional `log(message)`.

The module registers `consolidating` as a memory orchestrator. Host configuration
must select it explicitly. Timers use foreground admission and drain on plugin
shutdown. A one-minute poll processes at most one conversation batch of 16 sources;
64 pending sources per conversation and 1000 conversations are bounded.
Eligible conversations are ordered by oldest attempt. Failures retain their batch
and receive a persisted exponential cooldown (one minute up to one hour), so a
broken model/provider request cannot monopolize subsequent ticks. Remaining
backlog after a successful batch stays immediately due instead of waiting another
full interval. Budgets
fail explicitly rather than discarding queued raw information. They are not a
promise that an overloaded/offline worker can meet the cadence.

Captured raw outcomes remain in the normal memory provider. The plugin retains a
private derived work queue and isolates conversation scopes. Successful summaries
are stored as reported lessons with input IDs recorded as provenance text, never
as independent verification. Provider `links` are reserved for actual memory-entry
IDs and remain empty; message IDs must not be passed as memory links. They do not expire automatically. Pending work and generated output
survive restart; provider-write retries reuse the exact same key and payload.
A crash before the generated result is persisted can repeat a model call, so the
host adapter should deduplicate requestId if it uses durable workers. No source
instructions are executed. Prompt instructions alone do not guarantee semantic
summary quality; a no-tool runtime is required in the host adapter.

This slice establishes tested policy and persistence only. Core adapter and model routing are supplied by Core PR #315. The combined
plugin/host/provider test passes against that revision using a fake model runtime;
live activation and real-model acceptance remain delivery dependencies.

Run the combined check with:

```
HARNESS_CORE_ROOT=/path/to/core node --import /path/to/core/node_modules/tsx/dist/loader.mjs --test test/memory-consolidation*.test.mjs
```
