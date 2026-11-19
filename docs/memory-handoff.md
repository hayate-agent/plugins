# Latest turn handoff (MemoryService)

## Structured model summary (v4)

`MemoryService.summaryBackend` is an injectable bounded model adapter. With it,
normal turn-end capture queues raw current-turn input durably, then asks the
backend to **synthesize** JSON `{decisions: string[], results: string[],
openPoints: string[]}`. This is model output, not regex extraction or the v5/v6
request/reply excerpts below. Each array has at most five 180-character items;
encoded summary JSON is limited to 3200 characters. Invalid/oversize output is
rejected, not repaired into a purported summary. The prompt distinguishes
explicit decisions from proposals, reported effects from verification, and turn
completion from task completion. It explicitly preserves supplied task IDs,
permissions, deadlines, budgets and stops; these must not be invented.
These are instructions to the model, not a
guarantee of semantic accuracy. Stored entries remain `verification: reported`
and recall labels them untrusted historical claims, never authority or replay
permission. Empty/`NO_REPLY` does not supply a visible result.

Only the current turn is supplied: request <=6000 and reply <=10000 characters,
with explicit truncation metadata; no full-history scan or per-tool inference.
The raw pending record is limited to 1 MiB; larger turns fail explicitly instead
of discarding data. The host must provide tool-free isolated execution,
timeout/cancellation and the configured low-cost model. One new inference per
flush and persisted 30-second to one-hour failure cooldown bound retries.

The existing `memoryPlugin` installs a lazy adapter only when the existing
`memory.consolidation` config is present, and resolves the registered v1
`memory-consolidation` service. **The host must also advertise
`turnSummaryVersion: 1`**, meaning it uses a compatible factual tool-free summary
purpose. Unmarked legacy hosts are rejected *before inference* (their generic
ephemeral system prompt is a code reviewer). The same MemoryService/provider
remains the single writer; there is no second orchestration engine. An explicitly
injected backend is not overwritten. No new settings or CLI contract is needed.

**Remaining Core bridge, not implemented here:** in
`src/memory-consolidation-host.ts`, register `turnSummaryVersion: 1` and change
`runtime.open(..., {ephemeral:true})` to
`runtime.open(..., {ephemeral:true, assessmentPurpose:"handover"})`. The current
handover purpose is factual and tool-free; do not advertise the marker without
this prompt isolation. Parent must coordinate that owned host change and its
fake-runtime test, then update the immutable plugin pin/materialization. No
runtime activation or live inference was performed in this slice.

v4 raw inputs use the existing `memory-pending/` queue. A generated entry is
persisted **before** provider put; write failures reuse the exact output, key
and payload without another inference. Backend/schema failures retain the raw
pending input, never invent a fallback summary or overwrite the prior latest
pointer. Startup/periodic background flush reuse the same queue; recall never
flushes or waits for inference. After provider put and latest-pointer persistence,
`memory-summary-receipts/` retains turn-ID/input hash receipts. New pending and
receipt records explicitly use `inputHashVersion: 2`: hashes include request,
reply, outcome, and timestamp presence/value. The v4 key remains unchanged;
changed content or timestamp under the same stable session/turn ID fails closed.
Exact new-format retries (including after restart) do not infer or write again.
New raw inputs also set `payloadVersion: 2`, requiring fixed-epoch immediate
review if source time is unknown. Pre-existing hash-v2 pending without that
marker retain their original absent-time policy, including generated output and
receipts: this boundary never rewrites or replays legacy data.

Old v4 records have no hash-version marker. Old raw pending turns supply enough
evidence to compare full timestamp-aware identity before accepting capture retry;
their files and hashes are not upgraded. Existing generated output is reused
verbatim. Old receipts contain no timestamp evidence, so new capture attempts
against them fail closed as unverifiable legacy replays, even when the old
text/reply/outcome hash matches. Normal queue recovery still recognizes those
receipts under their old hash without inference. No old pending/output/receipt
is deleted, rekeyed or migrated by capture. Legacy v2/v3 entries pass unchanged,
never resummarized, including PR102's actual `turn-handover-v3:` namespace; it can
establish a latest pointer only after successful provider persistence. Receipts grow with captured turns;
retention/GC is not introduced here. A crash between inference and output
persistence can repeat inference: the backend receives a stable requestId and
should deduplicate it if needed. Unknown external effects are not reconciled or
replayed by this feature.

Tests use synthetic backend output (not actual model inference) against the real
Core FileMemoryStore. They prove the synthesis contract and that generated
fields—not input prefixes—are persisted and recalled next turn after restart,
plus session isolation, concurrent/idempotent capture, raw failure retention,
provider-write uncertainty, schema/input bounds, lazy host gating and legacy
payload compatibility. `test/memory-provider-lifecycle.test.mjs` additionally
exercises gated v5/v4 writes through the actual Core lifecycle facade and
FileMemoryStore: reconnect waits for the leased write, blocks new calls, closes
the old store before reopening, drains pending, and recalls the authoritative
entry after restart. v5 pending bytes remain unchanged; v4 output is persisted
before put. Revocation and session isolation still apply after reconnect.
They do not establish real-model semantic quality.

CI159 (Plugins `b0da776`, Core `d08da973`) was reproduced exactly. Its retained
pending file came from the lifecycle test's invalid `put() => {} as any` stub,
not a lost lease: latest-pointer persistence needs the returned MemoryEntry's
session and ID. The same stub retains pending without any reconnect. Using a
real FileMemoryStore response fixes the test with its empty-pending and lease
assertions intact, and adds pointer-to-provider verification. Do not relax the
service to delete pending after an invalid provider response.

## Deterministic fallback (v5/v6, no summary backend)

`src/memory-service.ts` captures meaningful turns, including completed turns
without tools, as versioned `turn-handoff-v5:` (known time) or
`turn-handoff-v6:` (unknown time) operations. These are bounded,
deterministic request/result excerpts with a turn reference, reported outcome,
explicitly uninferred completion/next steps, and the original-authority boundary.
This is **not** an LLM summary, verified completion, semantic decision extraction,
or permission to replay any effect. `NO_REPLY`/empty results cannot manufacture
a visible result. Full host history and history pruning/selection are unchanged.

Knowledge-free empty/silent exchanges, exact greeting-only pairs and whole-string
plain failed transport messages without tools are excluded before any pending or
provider write or inference. Tool arrays normalize by length. Meaningful silent
requests, empty failure turns with context, operational errors, and substantive
replies containing greetings remain capturable.

The new fallback key hashes session, optional host ID, complete request/reply,
outcome and optional recordedAt; retries are stable without both ID and timestamp.
Changed payload-determining fields receive distinct keys. New fallback records
and payload-v2 summaries set `reviewAfter: 1970-01-01T00:00:00.000Z` without a
host timestamp, preserving merged PR102's immediate-review requirement; with a
timestamp they use that time plus seven days. The unknown-time fallback namespace
is v6 because the old v5 payload omitted reviewAfter. An existing v5 pending file
owns its exact payload instead of being replaced by a v6 write. Legacy v4 pending
without output retains its original review policy when first processed. Both new output paths
state the task-ID/permission/deadline/budget/stop boundary and require effect
reconciliation rather than effect replay or stopped-task resumption.

With an agent home, captures use the existing durable `memory-pending/` queue.
Existing queued entries are passed unchanged to `provider.put`; no legacy payload
migration/reinterpretation is performed. A successful new-version write updates
`memory-latest/<sha256(sessionKey)>.json` with only session, provider entry ID and
ordering timestamp. Content remains authoritative in the Memory provider. Older
replays cannot replace a newer pointer. Failed writes retain pending entries and
cannot publish a completion pointer. Pending queue bounds/fairness are unchanged.

Recall reads the **last successfully persisted handoff**, even when newer input
for the same session is pending or inference is in flight. It neither starts nor
joins a flush/inference and does not scan the global pending directory. Capture
and background/startup flush remain the single summary/write owner, including
after restart; repeated recalls cannot trigger duplicate inference or writes.
A pending turn is not a summary. Until its provider write and latest pointer
succeed, recall can return the previous handoff (or none if none was persisted).
Callers requiring newly captured output must arrange background processing;
`recall()` is not a read-your-capture or inference-completion barrier.

Recall resolves the same-session latest pointer
through `provider.get`, checks scope, active state and expiry, then supplements
with search within `recallLimit`. Revoked/expired targets are not resurrected;
search failure need not lose a valid latest handoff. Encoded excerpts remain
bounded JSON and explicitly untrusted historical claims, not instructions or
operator authorization. Without an agent home only the pointer is process-local;
the Memory entry is still provider-durable.

Limits: this assumes one service owner, not cross-process pointer serialization.
Freshness means the newest successfully persisted, provider-authoritative handoff
visible at pointer lookup under the existing timestamp/ID ordering, not the
latest captured turn or an atomic snapshot across pointer lookup and search.
The one-inference/32-entry flush budget, retry cooldown and global capture
serialization are unchanged: even awaiting one global flush cannot guarantee
that a particular pending session was processed. A large backlog/concurrent
flush may defer new output beyond the next recall. Failures retain the previous
latest and pending retry, not a fabricated summary. Recall still awaits its own
pointer/provider reads and search (which may have provider-wide IO costs); this
removes inference/pending-scan coupling, not every shared-storage latency.
Without host identity/time, identical fallback input has a stable retry key but
cannot distinguish two genuinely separate, byte-identical turns.
The pointer has no history fallback if its latest target is revoked/expired.

## Focused contract tests

Use a compatible Core checkout with `src/memory.ts`, `src/memory-worker.ts` and
`src/durable.ts`; the tests load the authoritative plugin source against the real
Core `FileMemoryStore`. No inference, runtime replay or live provider is used.

```sh
HARNESS_CORE_ROOT=/path/to/core node \
  --import /path/to/core/node_modules/tsx/dist/loader.mjs \
  --test test/memory-summary.test.mjs test/memory-handoff.test.mjs \
  test/memory-capture-retention.test.mjs test/memory-plugin.test.mjs \
  test/memory-provider-lifecycle.test.mjs test/memory-pr102-compatibility.test.mjs
```

Core materialization must pin this repository's immutable revision and SHA-256
for `memory-service.ts`. Do not edit generated `src/builtin-plugins/` as the
delivery: a build will overwrite it. After pinning, Core's old test asserting
that a latest third lesson is absent from recall must instead expect that latest
handoff while retaining its one-hit `recallLimit` check.
