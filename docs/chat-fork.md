# Workspace chat fork

`POST /api/workspace/streams/:id/fork` accepts `{ idempotencyKey, title? }`.
The key must be a UUID. The returned stream is independent of the source.
Agent-Link exposes the same operation as `streams` action `fork` with
`streamId`, `idempotencyKey` and optional `title`, advertised by `fork-streams`.
Source ownership and Agent-Link project sharing checks apply before forking.

A fork snapshots the visible conversation messages, stream settings and working
directories. It neither submits old messages nor transfers pending tasks,
receipts, approvals, credentials or hidden runtime state. Subsequent submissions
include the captured transcript as explicitly historical context in turn
instructions, alongside the stream's current configured instructions. This uses
the existing runtime-independent turn contract and works with the embedded PI
runtime without a Core session-file mutation API. It is a transcript-context fork,
not a byte-for-byte clone of the PI SDK session tree or compaction state.

The captured transcript is persisted before any new work can be submitted.
Oversized transcripts (>120,000 UTF-8 bytes) fail explicitly rather than silently
truncating context. Repeating the same key and source/title returns the original
fork; conflicting use of the key fails.

Chat rename uses the existing local stream update `title` field. Agent-Link adds
`streams` action `rename` (`streamId`, `title`), advertised by `rename-streams`.
Renaming does not execute work or alter history.
