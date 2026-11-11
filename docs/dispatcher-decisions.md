# Dispatcher parent decisions

Requires a compatible Core with `Dispatcher.decide` and the durable execution
receipt contracts. The plugin remains an adapter; it does not edit the ledger or
override completion, recovery, approval or task-authority policy.

Tool: `plugin_dispatch({action: "decide", id, requestId, decision})`.
Command (host-authenticated admin): `/dispatch decide <id> <requestId> <text>`.
The parent is always the trusted session context, never a tool argument. Nested
`dispatch:` and `subagent:` sessions are rejected through both surfaces.

Acceptance returns `recorded: true` and a receipt with `state: pending|applied`.
Pending means not delivered to a strategy boundary yet. Applied means consumed
by trusted strategy code, not acceptance of the requested deviation or proof of
completion. Original mandate/constraints and independent evidence checks remain
binding. See Core `docs/dispatcher.md` for boundary fencing and supported strategies.

Read exact retained receipts with status `id` plus `field: decisions`; use
`charOffset` for 8,000-character pages. Ordinary status and `/dispatch status`
show bounded receipt summaries. An identical retry reuses its original receipt;
a conflicting requestId is rejected. Preserve command whitespace when retrying:
the text after the id/requestId separator is kept verbatim, including newlines.

Core bounds: requestId 1–128 ASCII alphanumerics/`._:-` starting alphanumeric;
nonblank decision text at most 4,000 UTF-8 bytes; at most 32 receipts and 16,000
UTF-8 bytes of JSON decision input per execution. Cancelled/completed/foreign
or parent-stopped tasks reject writes. Audits are retained through reload.

Resume does not accept task text: use decide for steering, answer for an existing
pending question, and resume only for an otherwise-resolvable pause.

Build against Core using an explicit local materialization lock for development.
The adapter also typechecks against older Core contracts through an optional
capability projection, but never emulates a missing decision API. Production needs a new immutable plugins revision/hash lock in Core.
New adapters fail explicitly for decide on older running hosts; older adapters do
not expose decide. Source builds do not activate changes: external authorized
rollout/restart is required. No live execution/ledger edits are part of this change.
