# SPEC: Rectification Unification — One `runFixCycle` SSOT

**Parent specs:**
- [SPEC-story-orchestrator.md](./SPEC-story-orchestrator.md) (US-001..US-004 — builder + ops + ExecutionGates + SessionKeeper)
- [SPEC-story-orchestrator-consolidation.md](./SPEC-story-orchestrator-consolidation.md) (US-005 — one builder per story; promotes full-suite gate + greenfield gate to phases)

**Story ID:** US-006
**Branch:** `refactor/rectification-unification`
**Status:** Draft — **planned (do not start until US-005 lands)**

---

## Summary

After US-005, nax has two rectification implementations side-by-side:

1. **General rectification phase** (`StoryOrchestratorBuilder.addRectification`) — drives
   `runFixCycle` (`src/findings/cycle.ts`) against `Finding[]` aggregated from verifier +
   semantic + adversarial review outputs. SSOT-shaped: pluggable strategies, iteration
   records, classification, bail predicates, attempt caps.

2. **Gate-internal rectification** (`fullSuiteGateOp` — moved from `runFullSuiteGate`) —
   drives `runRectificationLoop` (`src/verification/rectification-loop.ts`) against
   parsed test-suite failures. A separate loop with its own retry mechanics, attempt
   bookkeeping, and prompt-building.

This duplication was preserved through US-005 by design (scope discipline). US-006 folds
gate-internal rectification into the general phase so `runFixCycle` becomes the **single**
rectification SSOT across the codebase.

---

## Motivation

**One loop, one mental model.** Today a developer fixing rectification behavior must consider
which loop the bug lives in. After US-006, there is only one: `runFixCycle`. Strategies are
the customization surface; the loop is invariant.

**`runRectificationLoop` is duplicated infrastructure.** It implements the same primitives
`runFixCycle` already owns: iterate, dispatch fix-op, re-validate, classify outcome, terminate
on cap/bail. The only domain difference is the validator (re-run `bun test` vs re-run the
verifier) and the strategy (test-failure-fix vs review-finding-fix). Both can be expressed
as a `FixStrategy<Finding, ...>` and a `validate` callback against the existing
`runFixCycle` API.

**Adds a future hook for unified failure analytics.** With one rectification loop, iteration
records (`FixIteration[]`) for the whole story live in one place. Currently full-suite gate
iterations and review-finding iterations are tracked separately — hard to render in a single
audit view.

---

## Design

### 1. Test-failure → `Finding` adapter

Add `src/findings/adapters/test-failure.ts`:

```typescript
import type { Finding } from "../types";
import type { TestSummary } from "../../verification/test-output-parser";

/**
 * Convert a parsed test-suite failure into a Finding suitable for runFixCycle.
 * Each failed test becomes one Finding with source: "test", category: "failed-test",
 * and rule set to the test name when extractable.
 */
export function testFailureToFinding(failure: TestSummary["failures"][number]): Finding {
  return {
    source: "test",
    severity: "error",
    category: "failed-test",
    rule: failure.testName,
    file: failure.file,
    line: failure.line,
    message: failure.message,
    // ... per Finding shape contract
  };
}

export function testSummaryToFindings(summary: TestSummary): Finding[] {
  return summary.failures.map(testFailureToFinding);
}
```

`Finding.source: "test"` requires extending `FindingSource` in `src/findings/types.ts` if
`"test"` isn't already a member. (Likely needs verification — `"test"` may already exist for
verifier output.)

### 2. Full-suite gate rectification strategy

Add `src/operations/full-suite-rectify.ts` (or extend `autofix-cycle.ts`):

```typescript
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import { implementerOp } from "./implement";

export const fullSuiteRectifyStrategy: FixStrategy<Finding, ImplementerInput, ImplementerOutput, TddConfig> = {
  name: "full-suite-rectify",
  appliesTo: (finding) => finding.source === "test" && finding.category === "failed-test",
  fixOp: implementerOp,
  buildInput: (findings, _iterations, ctx) => ({
    story: ctx.story,
    // Prompt the implementer with failing-test context
    contextMarkdown: renderFailingTests(findings),
  }),
  extractApplied: (_output, _input) => ({ targetFiles: [], summary: "Fixed failing tests" }),
  maxAttempts: 3, // from config.execution.rectification.maxRetries
  coRun: "exclusive",
};
```

The strategy reuses `implementerOp` — no new fix-op needed. Prompt construction
(`renderFailingTests`) is the only new code in this strategy.

### 3. Extend `addRectification`'s validator

`addRectification`'s `cycle.validate` callback in `src/execution/story-orchestrator.ts`
currently re-runs the verifier only:

```typescript
validate: async (_validateCtx) => {
  await runPhase(ctx, verifierPhase, phaseCosts, phaseOutputs);
  return extractPhaseFindings(phaseOutputs[verifierPhase.slot.op.name]);
},
```

US-006 extends it to also re-run the full-suite gate (if present) and aggregate findings
from **both**:

```typescript
validate: async (_validateCtx) => {
  if (ctx.runtime.signal?.aborted) return [];
  // Re-run validators in canonical order: gate before verifier (matches phase order).
  if (fullSuiteGatePhase) {
    await runPhase(ctx, fullSuiteGatePhase, phaseCosts, phaseOutputs);
  }
  await runPhase(ctx, verifierPhase, phaseCosts, phaseOutputs);
  return [
    ...extractPhaseFindings(phaseOutputs[fullSuiteGatePhase?.slot.op.name ?? ""]),
    ...extractPhaseFindings(phaseOutputs[verifierPhase.slot.op.name]),
  ];
},
```

**Performance note:** re-running the full test suite every rectification iteration is
expensive. Two mitigations:
- **(i)** Use the scoped test runner (`src/verification/scoped-runner.ts`) when failures are
  attributable to a small file set — already a pattern in `runRectificationLoop`.
- **(ii)** Add a `rectificationValidateMode: "full" | "scoped"` config knob (new key) that
  defaults to `"scoped"`. Out-of-scope flag if scope grows; see §Open Questions.

### 4. Short-circuit carve-out

Today, any phase returning `success: false` skips subsequent phases. After US-006, the
full-suite gate's `success: false` MUST allow the post-implementer rectification phase to
run — otherwise gate failures terminate the story without repair.

Add to `ExecutionPlan.run()`:

```typescript
const shortCircuitExempt = new Set<string>([fullSuiteGateOp.name, verifierOp.name]);

for (const phase of collectOrderedPhases(this.state)) {
  await runPhase(this.ctx, phase, phaseCosts, phaseOutputs);
  const passed = phasePassed(phaseOutputs[phase.slot.op.name]);
  if (!passed && !shortCircuitExempt.has(phase.slot.op.name)) {
    break; // existing short-circuit
  }
  // exempt phases continue; rectification picks up their failures
}
```

Both the verifier (already exempt today by virtue of rectification consuming its failures)
and the full-suite gate (newly exempt) flow into rectification when present. When
rectification is NOT configured, both still short-circuit (no consumer for the failures).

### 5. Relocate triage logic

`runFullSuiteGate` today has three triage exits before reaching the rectification call:

| Triage | Today's behavior | US-006 home |
|:---|:---|:---|
| `deferred-unattributable` (parser found 0 failures) | Returns `{ passed: true, status: "deferred-unattributable" }`; defers to run-level regression gate | `fullSuiteGateOp.parse` returns `{ success: true, status: "deferred-unattributable", findings: [] }`. Empty findings → rectification phase no-ops on this gate output. |
| `parser counter mismatch` (failed=0 but failures.length>0) | Returns `{ passed: false, status: "execution-failed" }` | `fullSuiteGateOp.parse` returns `{ success: false, status: "execution-failed", findings: [] }`. Empty findings means rectification has nothing to fix; gate's `success: false` flows out as a story failure. |
| `disabled` (rectification.enabled=false) | Returns `{ passed: false, status: "disabled" }` | Gate phase still runs (detection is useful even without rectification); op output `{ success: false, status: "disabled" }` short-circuits naturally since no rectification phase consumes it. |

All triage moves from imperative early-returns to structured op output. The wrapper inspects
`status` for run-level reporting (same way verdict categorization works today).

### 6. Delete sites

US-006 retires:

- `src/verification/rectification-loop.ts` — `runRectificationLoop` deleted. Existing callers
  (the `fullSuiteGateOp` migrated in US-005) are rewired to use `runFixCycle` via the
  general rectification phase. SessionKeeper consumers (per US-002) remain in
  `src/tdd/rectification-gate.ts` only — wait, that file was deleted in US-005. Confirm
  SessionKeeper consumer audit before deletion (see §Open Questions OQ-1).
- `fullSuiteGateOp`'s internal rectification call — replaced by the validator extension in §3.
- `test/unit/verification/rectification-loop*.test.ts` — replaced by rectification-phase tests
  that exercise the full-suite-failure path through `runFixCycle`.

---

## Stories

Single story (US-006). Sub-deliverables align with §1-§6.

### US-006: Fold gate-internal rectification into the general rectification phase

**Depends on:** US-005 (StoryOrchestratorBuilder consolidation must land first — gates must
exist as phases, builder must dispatch them, before this story can rewire the rectification
contract).

Implement Design §1–§6. Delete sites per §6.

#### Context Files

- `src/findings/cycle.ts` — `runFixCycle` SSOT
- `src/findings/types.ts` — `Finding`, `FindingSource` (verify `"test"` membership)
- `src/findings/adapters/` — add `test-failure.ts`
- `src/operations/full-suite-rectify.ts` — new file (strategy definition)
- `src/operations/full-suite-gate.ts` — created in US-005; modified here to drop internal
  rectification, surface findings via `parse()`
- `src/execution/story-orchestrator.ts` — extend `addRectification` validator (§3);
  add short-circuit carve-out (§4)
- `src/verification/rectification-loop.ts` — to delete
- `src/verification/test-output-parser.ts` — source of `TestSummary` for the adapter
- `src/execution/build-plan-for-strategy.ts` — created in US-005; updated to include
  `fullSuiteRectifyStrategy` in the rectification strategies array

---

## Acceptance Criteria

1. `testFailureToFinding(failure): Finding` and `testSummaryToFindings(summary): Finding[]`
   exist in `src/findings/adapters/test-failure.ts` with the field mapping from §1.
   `FindingSource` includes `"test"`.
2. `fullSuiteRectifyStrategy: FixStrategy<Finding, ImplementerInput, ImplementerOutput,
   TddConfig>` exists in `src/operations/full-suite-rectify.ts`. `appliesTo` matches
   `source: "test", category: "failed-test"`. `fixOp` references `implementerOp` (no new
   fix-op created).
3. `fullSuiteGateOp.parse()` returns `{ success, status, findings: Finding[] }` populated
   from `testSummaryToFindings(parsedSummary)`. The op's `build()` constructs the test
   command per current `runFullSuiteGate` resolution rules. No internal rectification loop
   exists in the op.
4. `addRectification`'s `cycle.validate` re-runs the full-suite gate (when present in the
   plan) AND the verifier in canonical order, returning aggregated findings from both.
   Verified by a unit test asserting `cycle.validate` triggers `runPhase` for both phases.
5. `ExecutionPlan.run()` short-circuit logic exempts `fullSuiteGateOp.name` and
   `verifierOp.name` from termination on `success: false` when a rectification phase is
   present. When rectification is absent, both phases short-circuit as before. Verified by
   table-driven test over `(gate-success, verifier-success, rectification-enabled)`.
6. Triage statuses (`deferred-unattributable`, `execution-failed`, `disabled`) are surfaced
   as `fullSuiteGateOp` output fields, not via early-return code paths. Wrapper post-run
   inspection (per US-005 §3) reads `status` for run-level reporting.
7. `src/verification/rectification-loop.ts` is deleted. `runRectificationLoop` has zero
   call sites in the codebase.
8. `runFixCycle` is the only rectification loop in the codebase. Verified by a grep test:
   no `while`/`for` loop in `src/` with a `// rectification` comment outside `findings/cycle.ts`;
   no function named `runRectification*` other than the orchestrator's `runRectification`
   helper that calls `runFixCycle`.

---

## Failure Handling

- **Test-suite parser returns malformed `TestSummary`** — `testSummaryToFindings` returns
  `[]`. `fullSuiteGateOp.parse()` returns `{ success: false, status: "execution-failed",
  findings: [] }`. Rectification has no findings to fix; story fails through gate output.
- **`fullSuiteRectifyStrategy.maxAttempts` exhausted** — `runFixCycle` exits with
  `exitReason: "max-attempts-per-strategy"`. Wrapper maps this to
  `failureCategory: "full-suite-gate-exhausted"` for parity with current behavior.
- **Rectification re-validate hits abort signal** — `cycle.validate` returns `[]`
  immediately; `runFixCycle` exits as resolved (existing pattern).

---

## Non-Goals

- **No changes to `FindingSource` semantics** other than verifying/adding `"test"` membership.
- **No changes to `runFixCycle` itself.** All US-006 work is in the validator callback,
  the strategy definition, and the gate op's `parse()`.
- **No changes to `StoryOrchestratorBuilder` API.** `addRectification` signature unchanged;
  callers pass an additional strategy in `RectificationPhaseOptions.strategies`.
- **No new builder phases.** US-005's `CANONICAL_ORDER` is unchanged.

---

## Open Questions

1. **SessionKeeper consumer audit.** `src/verification/rectification-loop.ts` consumes
   `SessionKeeper` per US-002. After deletion, is `rectification-gate.ts` (also deleted in
   US-005) the only other consumer? If so, `SessionKeeper` becomes used only inside ops
   wired through `callOp` middleware — confirm before removing exports from
   `src/session/index.ts`.

2. **Performance: full-suite re-run cost per iteration.** Re-running `bun test` per
   rectification iteration can multiply story wall-clock by 3-5x for slow suites. Design §3
   mentions scoped-runner mitigation (already used by `runRectificationLoop`); should
   US-006 default to scoped re-validate, full re-validate, or per-strategy choice? Recommend:
   default to scoped (matches current behavior), with explicit config opt-in for full.

3. **Strategy ordering when both `fullSuiteRectifyStrategy` and review-finding strategies
   match.** `runFixCycle`'s `selectExecutionGroup` picks the first exclusive strategy. If a
   single rectification iteration sees both test failures (from gate) and lint findings
   (from semantic), which fix-op runs? Recommend: test failures take priority
   (`fullSuiteRectifyStrategy.coRun = "exclusive"` and declared first), since failing tests
   block downstream signal.

4. **Backwards compat for `failureCategory: "full-suite-gate-exhausted"`.** This category
   is currently emitted by `runFullSuiteGate` directly. After US-006, it must emerge from
   `runFixCycle`'s exit reason → `FailureCategory` mapping in the wrapper. Confirm the
   mapping doesn't drop the distinction (vs generic rectification exhaustion).

---

## Revision History

| Rev | Date | Change |
|:---|:---|:---|
| 1 | 2026-05-19 | Initial draft — deferred from SPEC-story-orchestrator-consolidation.md OQ1. |
