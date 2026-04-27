# Review: ADR-018 Runtime Layering + ADR-019 Session Ownership Exit Criteria

**Date:** 2026-04-27
**Project under test:** `@nathapp/nax`
**Scope:** `docs/adr/ADR-018-runtime-layering-with-session-runners.md`, `docs/adr/ADR-019-adapter-primitives-and-session-ownership.md`
**Related issues:** #688, #689, #690, #691, #692, #693, #706
**Status:** Reviewed — implementation is test-green, but exit criteria are only partially met

`bun run typecheck`, `bun run lint`, and the full `bun run test` suite passed during this review. The findings below are therefore not "red test" failures; they are implementation-vs-ADR / implementation-vs-exit-criteria mismatches.

---

## Finding 1 — `callOp()` run-ops do not follow the ADR-019 ownership boundary

### Severity

High

### Summary

The shipped `callOp()` implementation for `kind: "run"` does not construct `buildHopCallback()` and does not route through `agentManager.runWithFallback(...)`. Instead, it calls `sessionManager.runInSession(...)` directly.

That differs from the accepted ADR-019 design, which states that:

- `callOp` should build `buildHopCallback`
- `runWithFallback` should remain the fallback-chain owner
- the callback should own rebuild + open + handoff + dispatch per hop

### Evidence

Current implementation:

- [src/operations/call.ts:38-58](../../src/operations/call.ts#L38-L58)

ADR-019 target:

- [docs/adr/ADR-019-adapter-primitives-and-session-ownership.md:474-478](../adr/ADR-019-adapter-primitives-and-session-ownership.md#L474-L478)

Wave 3 tracking claim:

- [docs/superpowers/plans/2026-04-26-adr-018-wave-3.md:277-279](../superpowers/plans/2026-04-26-adr-018-wave-3.md#L277-L279)

### Why it matters

This means the run-ops introduced by ADR-018 Wave 3 do not inherit the documented fallback/context-rebuild path "by construction". The architecture described in ADR-019 is not what `callOp()` currently does.

### Recommended follow-up

Refactor `callOp()` run-paths to:

1. Build the prompt
2. Construct `buildHopCallback(...)`
3. Call `agentManager.runWithFallback({ ..., executeHop })`
4. Parse the final `AgentResult.output`

That brings the implementation back in line with ADR-019 and the Wave 3 exit-criteria wording.

---

## Finding 2 — `keepOpen` / `sessionHandle` retirement is incomplete

### Severity

High

### Summary

The tracking docs mark "zero `keepOpen: true` / `sessionHandle:` usages in `src/`" as completed, but the repository still contains several live `keepOpen` call paths.

### Evidence

Exit criteria marked complete:

- [docs/superpowers/plans/2026-04-26-adr-018-wave-3.md:198-205](../superpowers/plans/2026-04-26-adr-018-wave-3.md#L198-L205)
- [docs/superpowers/plans/2026-04-26-adr-018-wave-3-phase-e.md:1887-1899](../superpowers/plans/2026-04-26-adr-018-wave-3-phase-e.md#L1887-L1899)

Remaining code paths:

- [src/review/semantic.ts:545-604](../../src/review/semantic.ts#L545-L604)
- [src/review/adversarial.ts:315-377](../../src/review/adversarial.ts#L315-L377)
- [src/verification/rectification-loop.ts:286-306](../../src/verification/rectification-loop.ts#L286-L306)
- [src/tdd/rectification-gate.ts:290-302](../../src/tdd/rectification-gate.ts#L290-L302)
- [src/pipeline/stages/autofix.ts:541-575](../../src/pipeline/stages/autofix.ts#L541-L575)

### Why it matters

The caller-managed-session migration is real in `review/dialogue.ts` and the debate runner paths, but it is not complete across the broader runtime/review/rectification surface. The implementation and the recorded exit state have drifted.

### Recommended follow-up

Either:

1. Finish the migration for the remaining `keepOpen` flows, or
2. Narrow the written exit criteria so they only claim what actually landed

Right now the code and the completion docs disagree.

---

## Finding 3 — `buildHopCallback()` weakens failure classification

### Severity

Medium

### Summary

`buildHopCallback()` converts any `runAsSession()` error into a generic `availability / fail-adapter-error` result. The older hop path preserved typed session failures such as rate-limit outcomes via `SessionFailureError`.

### Evidence

Current callback behavior:

- [src/operations/build-hop-callback.ts:154-183](../../src/operations/build-hop-callback.ts#L154-L183)

Existing richer mapping:

- [src/runtime/session-run-hop.ts:67-82](../../src/runtime/session-run-hop.ts#L67-L82)

Typed failure surface:

- [src/agents/types.ts:271-281](../../src/agents/types.ts#L271-L281)

### Why it matters

If a typed session failure gets flattened into generic availability failure, fallback policy can make the wrong decision:

- swap when it should back off
- swap when shutdown/abort semantics should stop work
- lose rate-limit classification

This is subtle, because tests can still stay green while the fallback behavior changes under load.

### Recommended follow-up

Make `buildHopCallback()` mirror the `SessionFailureError` handling already used in `session-run-hop.ts` instead of reclassifying all errors as generic availability failures.

---

## Finding 4 — review-stage debate is only safely wired for one-shot mode

### Severity

Medium

### Summary

The semantic-review debate path constructs a synthetic runtime object with `sessionManager` and `signal` filled using unsafe placeholders. That is fine for one-shot debate, but review-stage debate config still permits `sessionMode: "stateful"` and `mode: "hybrid"`.

### Evidence

Synthetic runtime in semantic-review debate path:

- [src/review/semantic.ts:320-362](../../src/review/semantic.ts#L320-L362)

Debate config surface still permits stateful/hybrid review debate:

- [src/debate/types.ts:45-62](../../src/debate/types.ts#L45-L62)

### Why it matters

If review debate is configured to use stateful or hybrid mode, the current review path is not obviously backed by a real session manager/runtime. The config surface is broader than the safely wired implementation.

### Recommended follow-up

Either:

1. Restrict review debate to one-shot/panel in config validation, or
2. Thread a real runtime/session manager through the semantic-review debate path

Without that, the implementation contract is underspecified.

---

## Overall Exit-Criteria Assessment

### Met

- Wave 3.5 adapter method deletion appears landed
- DebateRunner exists and the old `DebateSession` entrypoint is gone
- Retry-loop unification for Wave 4 is present
- `bun run typecheck`, `bun run lint`, and full tests are green

### Not fully met

- The ADR-019 `callOp -> runWithFallback -> buildHopCallback` run-op architecture is not what the code currently does
- The "zero `keepOpen` / `sessionHandle` usages in `src/`" claim is false
- Some completion docs overstate what actually landed

---

## Suggested Next Steps

1. Decide whether the source of truth is the current code or the ADR/tracking docs.
2. If the ADR is still the target, treat Finding 1 and Finding 2 as follow-up implementation work before declaring the rollout complete.
3. If the current code is the intended end state, update the ADR/tracking docs to remove the stronger claims.
4. Add a structural test around `callOp()` run-path behavior so this boundary cannot silently drift again.
