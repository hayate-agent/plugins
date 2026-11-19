# TypeSafe / OpenJEV completion provider

`src/typesafe-validator-provider.ts` implements the published Core
`ValidatorProvider` API v1 (Core PR #347, merge f93a54f; Plugins PR #91,
merge 7ff45b2). It is a separate, optional provider; `legacy-llm` remains
replaceable and unchanged. No live installation is enabled by this source change.

## Explicit local configuration

An operator-owned ESM module can default-export
`createTypeSafeValidatorPlugin(config)`, using the materialized provider module.
The operator must supply the full `endpoint` (the `/v1/systemone` URL), `model`
and `questionbank`. There is no endpoint default, environment scan, model discovery
or implicit cloud fallback. Registration alone does not select it: the existing
host `completionCheck.provider` setting chooses the provider's name (`typesafe`
by default). Activation/configuration is deliberately outside this implementation.

The questionbank is a local versioned definition:

```ts
questionbank: {
  id: "completion_v1",
  instructions: "Judge supplied evidence only; choose unknown when inconclusive.",
  choices: {
    done: { description: "All mandated work has evidence of completion", category: "completed" },
    wait: { description: "Waiting on operator input", category: "waiting" },
    blocked: { description: "A concrete blocker prevents progress", category: "blocked" },
    unknown: { description: "Uncertain, insufficient evidence, or more work remains", category: "uncertain" }
  }
}
```

The bank ID is the question/answer key, not an undocumented remote bank parameter.
The bank compiles to one `choice` question with a criteria map. No score/noul
semantics are inferred. The wire format follows the public SystemOne API
<https://docs.typesafe.ai/api.md> and the upstream gateway schema retained in
research `453bed2b` (`internal/apischema/typesafe/systemone.go`). In particular,
choice answers contain `type`, `choice`, `confidence`, `probabilities`; raw noul
output is not a confidence score.

Optional settings: `name`, `timeoutMs` (1..60000, default 5000), `minConfidence`
(0..1, default .9), locally resolved `bearerToken`, and an explicitly supplied
trusted `fallback: ValidatorProvider`. Only transport/HTTP failures invoke that
fallback; invalid answers and uncertainty never escalate. No fallback is shipped
or selected automatically. Both primary and fallback share one total time budget
and cancellation signal. Even noncooperative fallback promises are bounded.
The host may impose a shorter budget/deadline and retains final authority.

## Safety and results

Only the host-budgeted prompt is sent as `state`, not the raw request, input,
authorization object or backend. That prompt can still contain task evidence:
endpoint selection is an explicit operator trust decision; do not enable this
provider for private tasks without separate authorization. Tests send synthetic
fixtures to an ephemeral loopback server only. This change made no live inference
requests and configured no credentials, endpoint or service.

Answer IDs, choice IDs, union tag, answer keys, category mappings, confidence,
probability keys/ranges/normalization and maximal selected probability are checked
at runtime. Unknown fields in the answer (including host-state commands) fail
closed. Responses are capped at 64 KiB with bounded streaming reads and no redirect
following. Invalid responses and technical failures produce no verdict; low
confidence or the explicit uncertain choice produces `{state:"uncertain"}`, which
the existing completion orchestrator treats as inconclusive, never completed.
Continue/next commands are not synthesized from classifier output; questions that
need more work must map to uncertain, leaving host policy in charge.

Diagnostics are fixed labels, never server bodies, endpoints, tokens or task text.
Providers have no authority over actual host state, stop, evidence, deadline,
authorization or worker ownership. Existing orchestration and host fences remain
unchanged. No shadow mode or parallel second judge is introduced.

## Local tests

Use a compatible Node (the installed launcher's `LD_LIBRARY_PATH` may need removal):

```sh
env -u LD_LIBRARY_PATH /usr/bin/node --import /absolute/core/node_modules/tsx/dist/loader.mjs \
  --test test/typesafe-validator-provider.test.mjs test/completion-validator.test.mjs
```

The fixtures cover invalid schema, answer IDs, category/choice injection, noul,
uncertainty, malformed/oversized response, HTTP failure, timeout during the body,
pre/in-flight cancellation, expired authorization, explicit fallback and total
budget. Compatibility builds must materialize this provider alongside the current
locked plugin set in an isolated Core tree; no existing Core checkout is modified.
Live usage remains unverified/unavailable while the separate rollout is broken.
