# Shared TypeSafe API + both decision consumers

`typesafe-api-plugin.ts` exports `createTypeSafeAPIPlugin(config)` and
`createTypeSafeAPI(config)`, registering service `typesafe-api` v1.
`typesafe-decision-plugin.ts` exports `typeSafeDecisionPlugin` and immutable
application-owned banks `hayate_completion_v1`, `hayate_dispatch_step_v1`,
`hayate_dispatch_ready_v1` (re-exported from `typesafe-question-banks.ts`).
That shared module is the frozen application registry used by the transport:
unknown IDs/versions, over-limit banks, or altered instructions/criteria under a
known ID return uncertain before credential reads or network I/O. Valid exact
copies resolve to canonical frozen policy before any await. Bounds are 2..8
choices, <=2000 UTF-8 instruction bytes and <=500 bytes per criterion; no remote
bank registration or policy override is accepted. The adapters register independently as
`typesafe-completion` and `typesafe-dispatch`. Core must provide the additive
`registerDispatchDecisionProvider` hook; Validator registration alone does not
cover Dispatcher. The existing optional `typesafe-validator-provider.ts` export
remains available for compatibility, but is not the new shared architecture.

Transport request: `{model,state,samples:1,questions:{[bank]:{type:'choice',instructions,criteria}}}`.
Response requires a valid resolved model name and matching bank, `choice`, `confidence>=.9` for a decisive result, a complete unit
probability distribution, and optional bounded usage counts. Unknown fields,
invalid/uncertain output, `noul`, missing service, timeout and HTTP failure cannot
authorize continuation/completion or cause implicit cloud/legacy fallback.
Confidence is NOT equated with the chosen probability.

The retained completed contract receipt pins Envoy AI Gateway v1.2.0 at
`daa9f891a8afcb18576d4593ad18870d1d18abac`,
`internal/apischema/typesafe/systemone.go:11-54`: model/state/questions,
choice/noul/score answers, optional usage. `samples` is not mandatory there;
`samples:1` additionally matches the fleet OpenJEV native consumer. The narrower
choice/confidence/probabilities dialect intentionally rejects score-only or noul
answers rather than inferring authorization. This may reject valid server
responses; it never accepts uncertainty. Local fixtures prove this dialect, not
live Gateway acceptance. Model `openjev-latest` and Gateway origin are from prior
metadata and fleet route evidence; no new discovery/inference is needed for
registration.

Configuration uses endpoint, model, bearerTokenFile (absolute, owner-only regular
file with plain token, final symlinks prohibited), optional timeoutMs 1..120000 (default120000, aligned with the host's bounded completion execution budget). Explicit shorter operator deadlines remain exact; caller stop/expiry/abort can only shorten a request. Real retained evidence can take more than5–10s even when the service is healthy. HTTP failure, network/credential failure and transport timeout are projected through a fixed public diagnostic vocabulary (technical/provider_error with bounded HTTP status, or timeout/ETIMEDOUT), never as a fabricated malformed classifier answer. No error bodies, endpoint strings or credentials are exported. Valid uncertainty still grants no continuation; backend failure never invokes another provider.
No inline credentials, URL credentials/query, environment scan or discovery.
State is UTF-8 <=56000 bytes, matching the host completion envelope; response is streamed <=16384 bytes. Decision adapters advertise a24KiB routine host-evidence budget inside the56KiB raw transport ceiling. Compatible hosts project optional old observations to that budget without truncating original authority/expiry. This avoids repeatedly sending large prefill contexts into a single-slot native classifier; oversized exact authority still fails closed rather than being silently shortened. The response `model` may differ from the configured request alias (public SystemOne contract); it never changes the configured request endpoint/model. Valid confidence below .9 maps to explicit uncertainty, not malformed response or completion. The .9 decision floor and all probability/schema checks remain unchanged. Sensitive-looking
assignments/private keys and the bound token in exported state are rejected. This
is not general-purpose DLP for arbitrary prose. Keep existing host sanitization.
No exception text, token, header or response body is copied into diagnostics.

Services resolve lazily after plugin activation, so either registration order
works. `requiresModel:false` lets the host bypass unrelated LLM qualification.
Results are advisory; host authorization/deadlines, stop/decision fences,
continuation budget, progress, unknown effects and ready-candidate membership
remain authoritative. `more` returns only a fixed scope-preserving correction;
no model-authored host directive is accepted. No questionbank design input from
the operator is required.

Core's `docs/typesafe-decisions.md` supplies the unapplied secure-reference config
fragment and offline two-repository test command. Production plugin-lock
materialization, protected publication/review/CI, native activation and released
live verification are separate outstanding gates, not consequences of local tests.
