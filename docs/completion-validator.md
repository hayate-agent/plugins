# Completion validator and provider extensions

`src/completion-validator-plugin.ts` owns completion assessment orchestration,
strict answer interpretation and the legacy LLM judge. This is separate from the
code-review policy engine and from the prompt-only completion strategy.
Core owns the API-version-1 `ValidatorProvider` contract, per-host registry,
prompt budgeting, authorization and execution/worker precedence fences. The
existing completion prompt and step prompt are unchanged.

The shipped plugin registers `legacy-llm` version 1 through
`api.registerValidatorProvider(provider)`. Dedicated plugins register their own
unique provider names through the same API. A provider implements
`{ apiVersion: 1, name, version, assess(request): Promise<unknown> }`.
The request contains the bounded host prompt, input/reply evidence, authorization,
selected model, assessment backend and abort signal. Results are semantic advisory
answers, never new permissions, execution receipts or host routing instructions.
Providers must honor abort; the orchestration also bounds noncooperative promises.

Host installation setting `completionCheck.provider` chooses a name, defaults to
`legacy-llm`, or accepts `false` to disable assessment. Registration is startup-only.
Missing, disabled, failing or invalid providers never imply completed; there is no
implicit fallback to the LLM or a cloud service. Existing completion strategy
configuration still controls prompts and may disable assessment independently.

Answers retain the existing persisted continuation shape: state completed/waiting/
blocked, or continue with next, optional progress and contextPreparation. Uncertain
or malformed answers produce no verdict. Host stop, authorization/deadline,
checkpoint, actual worker outcome and evidence checks still take precedence.

Test the plugin sources with the Core-provided tsx loader:
`node --import ../core/node_modules/tsx/dist/loader.mjs --test test/completion-validator.test.mjs`.
Core integration tests additionally cover registry validation, provider selection,
task/step parity, persisted shapes, host fences and timeout behavior.
The new Core contract is required for activation; it is not provided by historical
Core main. Publish the plugin commit before pinning it in the Core integration PR.
