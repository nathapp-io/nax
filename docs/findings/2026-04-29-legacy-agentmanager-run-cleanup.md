# Legacy `agentManager.run` cleanup — post ADR-018/019/020

**Date:** 2026-04-29
**Reporter:** williamkhoo
**Related issue:** [#762](https://github.com/nathapp-io/nax/issues/762)
**Related ADRs:**
- [ADR-018 — Runtime layering with session runners](../adr/ADR-018-runtime-layering-with-session-runners.md)
- [ADR-019 — Adapter primitives and session ownership](../adr/ADR-019-adapter-primitives-and-session-ownership.md)
- [ADR-020 — Dispatch boundary SSOT](../adr/ADR-020-dispatch-boundary-ssot.md)
- Predecessor finding: [2026-04-27 post ADR-018/019 dogfood](./2026-04-27-post-adr-018-019-dogfood-issues.md)

---

## TL;DR

Issue #762 names two files (`semantic.ts`, `adversarial.ts`), but the same
`if (runtime) { callOp/runWithFallback } else { legacy keepOpen agentManager.run }`
pattern exists in **six source files** plus one unrelated interactive callsite.

After PR #761 threaded `runtime` into every per-story `PipelineContext`,
most of those `else` branches are dead under `executeUnified()`. **However**,
a few callers still pass `runtime: undefined`, so blindly deleting the
`else` block will silently regress those flows.

This finding catalogs every legacy site, classifies it by readiness, and
recommends a 3-PR cleanup sequence.

---

## Pattern under review

The legacy pattern is:

```ts
if (runtime) {
  // ADR-019 Pattern A — dispatch via callOp / runWithFallback + buildHopCallback
  // Middleware (audit, cost, cancellation) fires uniformly.
  ...
} else {
  // @deprecated Legacy keepOpen path
  // TODO(ADR-019): Remove once all callers thread runtime.
  logger?.warn(scope, "LLM call via legacy agentManager.run — middleware skipped", { storyId });
  ...
  const result = await agentManager.run({ runOptions: { ..., keepOpen: true } });
  ...
  void legacyCloser?.closePhysicalSession?.(sessionName, workdir);
}
```

Per ADR-019 §1 + ADR-020 Wave 3, all dispatch must flow through:
- **Layer 4 (preferred):** `callOp(ctx, op, input)`
- **Layer 3:** `agentManager.completeAs` / `runAsSession` / `runWithFallback`
- **Layer 2:** `sessionManager.openSession` + `runAsSession × N` + `closeSession`
- **Layer 1 (wiring only):** `adapter.openSession` / `sendTurn` / `closeSession` / `complete`
  (allowed only inside `src/agents/manager.ts`, `src/agents/utils.ts`, `src/session/manager.ts`)

`agentManager.run({ runOptions: { ..., keepOpen: true } })` is a Layer-3
escape hatch that:
1. Skips most middleware (audit / cost / cancellation hooks fire from
   `runAsSession`, not from `run`).
2. Implicitly creates an ACP session inside the adapter, requiring callers
   to manually `closePhysicalSession` later (visible as the `legacyCloser`
   helper in semantic/adversarial).
3. Bypasses fallback/handoff because it does not go through `buildHopCallback`.

Removing it is the goal of ADR-019 Wave 3 follow-through.

---

## Inventory

### Sites found

```bash
$ grep -rn "agentManager\.run\b\|agentManager\.runAs\b" src/ --include="*.ts" \
    | grep -v "\.test\.ts\|runAsSession\|runWithFallback"
```

| # | File | Line | Function / context |
|---|------|------|--------------------|
| 1 | [src/review/semantic.ts](../../src/review/semantic.ts) | 309–478 | `runSemanticReview` legacy `else` branch |
| 2 | [src/review/adversarial.ts](../../src/review/adversarial.ts) | 266–466 | `runAdversarialReview` legacy `else` branch |
| 3 | [src/pipeline/stages/autofix-adversarial.ts](../../src/pipeline/stages/autofix-adversarial.ts) | 192–196 | `runTestWriterRectification` legacy `else` |
| 4 | [src/pipeline/stages/autofix-agent.ts](../../src/pipeline/stages/autofix-agent.ts) | 329–385 | `runAgentRectification` legacy `else` |
| 5 | [src/verification/rectification-loop.ts](../../src/verification/rectification-loop.ts) | 312–376 | `runRectificationLoop` legacy `else` |
| 6 | [src/tdd/rectification-gate.ts](../../src/tdd/rectification-gate.ts) | 330–394 | `runRectificationLoop` (TDD full-suite gate) legacy `else` |
| 7 | [src/cli/plan.ts](../../src/cli/plan.ts) | 259 | `agentManager.runAs(...)` interactive plan — different concern |

---

## Classification by readiness

### Group A — Safe to delete now

`runtime` is unconditionally threaded by all current callers. The `if (runtime)` guard can be replaced with a `NaxError` ("fail fast, not fail-open") so the dispatch boundary is enforced rather than silently downgraded.

| # | File | Lines | Notes |
|---|------|-------|-------|
| 1 | `src/review/semantic.ts` | 309–478 | Issue #762 — already annotated `@deprecated` with `TODO(ADR-019)` |
| 2 | `src/review/adversarial.ts` | 266–466 | Issue #762 — already annotated `@deprecated` with `TODO(ADR-019)` |
| 3 | `src/pipeline/stages/autofix-adversarial.ts` | 192–196 | Takes `ctx: PipelineContext`; `ctx.runtime` always present after PR #761 |
| 4 | `src/pipeline/stages/autofix-agent.ts` | 377–385 | Takes `ctx: PipelineContext`; `ctx.runtime` always present after PR #761 |

**Verification of #3 and #4:** both functions accept `ctx: PipelineContext`. `executeUnified()` constructs every per-story context literal with `runtime: ctx.runtime` after PR #761:

- [src/execution/iteration-runner.ts:185, 247](../../src/execution/iteration-runner.ts) ✅
- [src/execution/unified-executor.ts:151, 253, 292, 575](../../src/execution/unified-executor.ts) ✅
- [src/execution/lifecycle/acceptance-loop.ts:145](../../src/execution/lifecycle/acceptance-loop.ts) ✅
- [src/execution/merge-conflict-rectify.ts:144](../../src/execution/merge-conflict-rectify.ts) ✅

So Group A can be cleaned in one direct PR without further wiring work.

**Cleanup template (per file):**

```ts
// Before
if (runtime) {
  // ADR-019 Pattern A...
  ...
} else {
  // @deprecated Legacy keepOpen path
  ...
}

// After
if (!runtime) {
  throw new NaxError(
    "runtime required — legacy agentManager.run path removed (ADR-019 Wave 3)",
    "DISPATCH_NO_RUNTIME",
    { stage, storyId: story.id },
  );
}
// ADR-019 Pattern A...
...
```

---

### Group B — Needs upstream wiring fix first

Same legacy `else` branch, but **at least one production caller passes `runtime: undefined`**, so the legacy path is currently live. Removing it without first threading `runtime` will regress those flows.

| # | File (legacy branch) | Caller missing `runtime` | Symptom if removed prematurely |
|---|----------------------|--------------------------|-------------------------------|
| 5 | `src/verification/rectification-loop.ts:312–376` | [src/pipeline/stages/rectify.ts:130](../../src/pipeline/stages/rectify.ts#L130) — `runRectificationLoop({...})` literal omits `runtime` | Every post-verify rectification crashes with `DISPATCH_NO_RUNTIME` |
| 5 | (same) | [src/execution/lifecycle/run-regression.ts:323](../../src/execution/lifecycle/run-regression.ts#L323) — deferred regression gate omits `runtime` | Deferred regression rectification crashes |
| 6 | `src/tdd/rectification-gate.ts:330–394` | [src/tdd/orchestrator.ts:260](../../src/tdd/orchestrator.ts#L260) — `runFullSuiteGate(...)` does not forward `runtime` | Every TDD full-suite gate regression rectification fires the legacy path; removal crashes the entire TDD path |

`merge-conflict-rectify.ts:144` is OK — it already passes `runtime: options.runtime`.

**Wiring fix shape:**
- Add `runtime?: NaxRuntime` to `RectificationLoopOptions` (already done — see line 82 doc-comment) and **forward it** from the two production callers.
- Add a `runtime` parameter (or thread via options) on `runFullSuiteGate` and forward from `tdd/orchestrator.ts:260`.

After the wiring fix, apply the same `if (!runtime) throw NaxError` pattern as Group A.

---

### Group C — Out of scope (different concern)

| # | File | Pattern | Why different |
|---|------|---------|---------------|
| 7 | [src/cli/plan.ts:259](../../src/cli/plan.ts#L259) | `agentManager.runAs(agentName, { runOptions: { ..., interactionBridge, ... } })` | This is the **interactive** plan path — TTY user co-drives the session via `interactionBridge`. Auto-mode plan already uses `callOp(planOp, ...)` at [line 188](../../src/cli/plan.ts#L188). Migrating the interactive variant requires either an `interactivePlanOp` or formally admitting the canonical Layer-3 manager API path; this is **not a "remove legacy" cleanup** — it is design work tracked separately. |

---

## Recommended PR sequence

Three PRs, ordered by risk and to keep diffs reviewable:

### PR-A — issue #762 literal scope

- Files: `src/review/semantic.ts`, `src/review/adversarial.ts`
- Action: drop the `else` legacy block; replace `if (runtime)` with `if (!runtime) throw NaxError`
- Removes the per-stage `legacyCloser` / `formatSessionName(role: "reviewer-…")` / model-resolution helpers used only by the legacy path
- AC mirrors issue #762:
  - [ ] Both `else` legacy branches deleted
  - [ ] `if (runtime)` guard replaced with `NaxError` (fail fast, not fail-open)
  - [ ] All tests pass (`bun run test`)
  - [ ] `bun run typecheck` clean
  - [ ] `grep -r "agentManager\.run" src/review/` returns nothing

### PR-B — sibling cleanup (no wiring change)

- Files: `src/pipeline/stages/autofix-adversarial.ts`, `src/pipeline/stages/autofix-agent.ts`
- Same diff shape as PR-A — collapse `if (ctx.runtime) { … } else { legacy }` to a fail-fast guard
- Cheap, identical pattern, prevents drift on the same boundary

### PR-C — wiring fix + cleanup (highest impact)

- Wiring:
  - Thread `runtime: ctx.runtime` from `src/pipeline/stages/rectify.ts:130` into the `runRectificationLoop({ … })` literal
  - Thread `runtime` from `src/execution/lifecycle/run-regression.ts:323` (likely needs `DeferredRegressionOptions.runtime` field)
  - Thread `runtime` from `src/tdd/orchestrator.ts:260` into `runFullSuiteGate(...)` (and through to inner `runRectificationLoop` at `src/tdd/rectification-gate.ts:182`)
- Cleanup:
  - Drop legacy `else` in `src/verification/rectification-loop.ts:312–376`
  - Drop legacy `else` in `src/tdd/rectification-gate.ts:330–394`
- Add a regression test that asserts `runtime` is forwarded into `runRectificationLoop` / `runFullSuiteGate`
- Recommended split: do the wiring + cleanup in one PR per gate (rectify, regression, tdd) so each can be reverted independently if a downstream consumer surfaces

---

## Why fail-fast, not fail-open

ADR-019 §3 + ADR-020 §D3 §D4 are clear: the dispatch boundary is the SSOT
for middleware (audit, cost, cancellation). Silently downgrading to the
legacy path:

- Loses prompt-audit entries for the affected hops (issue #1 in the dogfood
  finding)
- Under-counts per-check cost (`ReviewCheckResult.cost` becomes 0)
- Skips the cancellation middleware → orphan acpx subprocesses on Ctrl+C
  (issue #792)
- Bypasses fallback policy → no agent handoff if the primary fails

A `NaxError` makes wiring gaps **loud** instead of silent — this is the
same lesson the ADR-012 phase-6 legacy-key guard (`CONFIG_LEGACY_AGENT_KEYS`)
encodes for config.

---

## Out-of-scope notes

- **`src/cli/plan.ts:259`** — interactive planning. Not a fallback; needs design (interactivePlanOp or formal Layer-3 admission). File a separate issue if desired.
- **`src/agents/manager.ts:463–469`** — `AgentManager.run()` and `AgentManager.complete()` themselves remain as Layer-3 primitives. They are not "legacy"; they are the manager API. Group A/B/C only delete the **callsites that bypass higher layers**, not the methods themselves. Whether to ultimately privatize `agentManager.run` (keep `runAs`/`runAsSession`/`runWithFallback` only) is a follow-up after Group C lands.

---

## Quick verification commands

```bash
# After PR-A
grep -rn "agentManager\.run\b" src/review/ | grep -v "\.test\.ts"
# expect: no matches

# After PR-B
grep -rn "agentManager\.run\b" src/pipeline/stages/ | grep -v "\.test\.ts"
# expect: no matches

# After PR-C
grep -rn "agentManager\.run\b" src/verification/ src/tdd/ | grep -v "\.test\.ts"
# expect: no matches

# Final sweep — should leave only src/cli/plan.ts and intra-manager calls
grep -rn "agentManager\.run\b\|agentManager\.runAs\b" src/ --include="*.ts" \
  | grep -v "\.test\.ts\|runAsSession\|runWithFallback"
```
