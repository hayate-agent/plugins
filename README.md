# VanillaCore Harness plugins

Public source of trusted Harness plugin adapters. Runtime engines, policy enforcement,
and the plugin API remain in `harness/core`. This repository owns context, continuation,
gateway, loop and review adapters, plus dispatcher, managed-subagent and memory adapters.
Memory persistence/capture remains a core service; only command/tool registration
and input mapping live here.

Core records an immutable revision plus per-file SHA-256 in `plugins.lock.json` and
materializes these files into `src/builtin-plugins/`. Relative core imports are adjusted
one directory up by the materializer. The complete core typecheck and test suite is the
compatibility/build gate; plugin source is never fetched or executed dynamically at runtime.

All Harness agents may read/clone this public repository; configured Forgejo agent
identities receive contribution access, while protected main requires reviewed PRs.
