# Prompt audit dispatch boundary regression

**Date:** 2026-04-28
**Reporter:** williamkhoo
**Observed in:** `/home/williamkhoo/Desktop/projects/nathapp/nax-dogfood/fixtures/hello-lint/.nax/prompt-audit/hello-lint`
**Reference convention:** `logs/prompt-audit/memory-phase4-graph-code-intelligence/`

## Summary

Prompt audit file names drifted after ADR-018 / ADR-019 moved audit recording into the runtime middleware chain. A single logical run prompt could be recorded twice:

- once by the outer `AgentManager.runAs()` middleware envelope, without session identity
- once by the inner `AgentManager.runAsSession()` dispatch, with the real session identity

This produced mixed audit names in the same feature folder, for example:

```text
1777359039605-nax-07a92405-hello-lint-us-001-implementer.txt
1777359039822-run-run-US-001.txt
1777358910568-complete-acceptance-US-001.txt
```

The historical convention was consistent and session-oriented:

```text
1777211627107-nax-b37155e8-memory-phase4-graph-code-intelligence-us-000-implementer-run-t01.txt
1777219140491-nax-b37155e8-memory-phase4-graph-code-intelligence-us-001-reviewer-semantic-review-t01.txt
1777211320978-nax-52d67808-memory-phase4-graph-code-intelligence-us-001-refine-complete.txt
1777211412033-nax-b37155e8-memory-phase4-graph-code-intelligence-acceptance-gen-complete.txt
```

## Root Cause

The outer/inner runtime shape is intentional:

- `runAs()` / `runWithFallback()` owns fallback policy and the logical run envelope.
- `runAsSession()` owns the concrete session turn and calls `SessionManager.sendPrompt()`.

The design bug was making prompt audit a generic middleware side effect at both layers. For `executeHop` runs, the same prompt crosses both middleware boundaries, but only the inner boundary is the actual agent dispatch. The outer boundary lacks session handle, turn number, and protocol correlation, so it can only derive fallback-style names such as `run-run-US-001`.

One-shot `complete` calls have a different shape: they do not go through `runAsSession()`, so their prompt audit still needs to happen at `completeAs()`. The missing piece was preserving enough complete-call metadata in `MiddlewareContext` to derive the same session-style filename convention.

## Fix Applied

The short-term fix restores the prior operator-facing convention while keeping ADR-018 / ADR-019 layering:

1. `auditMiddleware` skips outer `run` audit entries when `ctx.request.executeHop` is present and no `sessionHandle` exists. The inner `runAsSession()` audit entry remains the source of truth.
2. `completeAs()` threads `CompleteOptions` into `MiddlewareContext` so complete calls can derive session-style audit names from `workdir`, `featureName`, `storyId`, and `sessionRole`.
3. `callOp()` now forwards `featureName` for `complete` operations, matching the metadata already passed for `run` operations.
4. `PromptAuditor` writes legacy-style suffixes for session-named entries:
   - `run` entries: `<epoch>-<sessionName>-<stage>-tNN.txt`
   - `complete` entries: `<epoch>-<sessionName>-complete.txt`

## Long-Term Recommendation

Prompt audit should eventually stop inferring dispatch intent from generic middleware context. A more durable design is:

- keep middleware for operation telemetry, cost, cancellation, fallback events, and logs
- emit prompt audit from explicit concrete dispatch boundaries:
  - `SessionManager.sendPrompt()` / `runAsSession()` for session turns
  - `completeAs()` or the adapter complete boundary for one-shot completions
- use a typed `PromptDispatchAuditEvent` that already contains `sessionName`, `callType`, `stage`, `turn`, `featureName`, `storyId`, and protocol IDs

That would make duplicate prompt audit structurally impossible instead of relying on an `executeHop` guard.

