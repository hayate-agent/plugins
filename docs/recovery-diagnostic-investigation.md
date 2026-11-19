# Recovery diagnostics investigation — 2026-11-12

Inspected freshly fetched Core `629e6c7` and Plugins `7ff45b2` in isolated worktrees; existing dirty checkouts were not changed.

## Observed on Randy (read-only Kubernetes inspection)

The live execution store contained three paused direct executions with diagnosticCode `runtime-failure`, classifier receipt phase `initial`, classifier model `homelab/gpt-6-luna`, and recoveryReason:

> Classifier HTTP outcome unknown; retained receipt forbids automatic replay.

Executions:
- `b81559c1-2d06-4bc8-9752-02e59f232226` / `night16-window-checkpoint`
- `17b56043-f5ef-421d-9889-44cc5fe045f0` / `selfservice-pr49-pr32-authenticated-ci-readonly-1`
- `aceb6362-9912-416d-9ea3-260d1fa75b77` / `integrated-selfservice-activation-successor-1`

None had a stored worker intent, checkpoint, or result. These records establish interrupted classification, not failure of an activated worker or a user prohibition. Current pod logs contained `Error: Assessment stopped` at 09:34:22Z and 09:58:57Z; these log lines carry no execution ID and do not establish a per-execution timeout cause.

## Code path

Core `src/dispatcher-runtime.ts` gives HTTP classification a 15-second AbortSignal combined with the owning execution signal. Classification precedes worker intent and worker launch. `src/classifier-http.ts` durably persists `initial` before a possible HTTP send and `observed` after obtaining an outcome. An interruption may leave `initial` even if the remote request was not sent or was completed remotely.

Core `src/execution.ts` (`scheduleWorkerRetry`, `recover`) treats any non-observed receipt as a no-automatic-replay hold. The normal backoff recovery therefore cannot recover these executions. This is an explicit runtime rule, not evidence of an operator prohibition or an identified custom ExecutionRecoveryPolicy.

Plugins `src/dispatcher-plugin.ts` previously mapped every unrecognized recoveryReason to “Recovery blocked by host policy”. That projection hides this known technical cause and overstates the evidence for unknown causes. It also hides known deadline and missing-reconciliation holds.

## Bounded correction

Expose fixed, sanitized messages for those three known reasons; label all remaining reasons unclassified, without claiming a specific host policy or user prohibition. Preserve protection against leaking raw exception/policy prose. No recovery behavior, authority, replay permission, execution state, or live deployment changed.

Validation: all 15 `test/dispatcher-*.test.mjs` tests passed with the existing Core tsx loader. Tests cover tool/command parity, paginated field diagnostics, unknown hostile prose, and bounded output.

## Remaining work

Improving classification failure recovery requires a separate lifecycle change: distinguish a routing-only HTTP assessment from productive worker effects, define bounded retry or fallback under the existing mandate, preserve claim fencing, and test timeout/abort/restart boundaries. Do not blindly resume these executions or delete their receipts: current code deliberately rejects non-observed receipts on re-entry. The original classifier transport failure remains insufficiently diagnosed by the persisted record.
