# SPEC: Rectification Unification — One `runFixCycle` SSOT

**Parent specs:**
- [SPEC-story-orchestrator.md](./SPEC-story-orchestrator.md) (US-001..US-004 — builder + ops + ExecutionGates + SessionKeeper)
- [SPEC-story-orchestrator-consolidation.md](./SPEC-story-orchestrator-consolidation.md) (US-005 — one builder per story; promotes full-suite gate + greenfield gate to phases)

**Story IDs:** US-006a (additive) + US-006b (terminal cleanup)
**Branch:** `refactor/rectification-unification`
**Status:** Draft — **planned (do not start until US-005 lands; US-006b blocks on US-006a)**

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

### 0. Extend `FullSuiteGateOutput` and remove internal rectification from the op

`fullSuiteGateOp` is a `DeterministicOperation<FullSuiteGateInput, FullSuiteGateOutput, …>`
with `execute(input, ctx)`. It has no `build()` or `parse()` methods and is **not** converted
to `RunOperation` by this spec. Two targeted changes instead:

**a. Add `findings: Finding[]` to `FullSuiteGateOutput`:**

```typescript
export interface FullSuiteGateOutput {
  readonly success: boolean;
  readonly passed: boolean;
  readonly status: FullSuiteGateStatus;
  readonly estimatedCostUsd: number;
  readonly durationMs?: number;
  readonly attempts?: number;
  /**
   * Structured test failures for the rectification phase.
   * Empty when tests pass or when the parser returns no structured records
   * (status: "execution-failed").
   */
  readonly findings: Finding[];
}
```

`execute()` populates `findings` via `testSummaryToFindings(parsedSummary)` (§1 adapter) when
tests fail. When tests pass, `findings: []`.

**b. Retire `"rectification-exhausted"` and rename `"failed-no-rectification"` in `FullSuiteGateStatus`:**

After US-006, the op no longer drives rectification — that moves to the general phase (§3). So:

- `"rectification-exhausted"` is unreachable and is removed.
- `"failed-no-rectification"` becomes `"failed"` (the `rectificationEnabled` input flag is
  removed from `FullSuiteGateInput`; whether to run rectification is now a caller concern).

```typescript
export type FullSuiteGateStatus =
  | "passed"
  | "failed"           // tests failed; findings populated
  | "execution-failed" // runner exited non-zero but parser found 0 structured failures
  | "inconclusive";
```

The `_fullSuiteGateDeps.runRectificationLoop` dep and the `FullSuiteGateDeps.runRectificationLoop`
interface method are removed. The `FullSuiteGateInput.rectificationEnabled` and
`FullSuiteGateInput.implementerTier` fields are removed (no longer needed by the op).

---

### 1. Test-failure → `Finding` adapter

Add `src/findings/adapters/test-failure.ts`:

```typescript
import type { TestFailure, TestSummary } from "../../test-runners";
import type { Finding } from "../types";

/**
 * Convert a parsed test-suite failure into a Finding suitable for runFixCycle.
 * Each failed test becomes one Finding with source: "test-runner",
 * category: "failed-test", and rule set to the test name.
 */
export function testFailureToFinding(failure: TestFailure): Finding {
  return {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: failure.testName,
    file: failure.file,
    message: failure.error,
  };
}

export function testSummaryToFindings(summary: TestSummary): Finding[] {
  return summary.failures.map(testFailureToFinding);
}
```

`Finding.source` uses `"test-runner"` — the existing `FindingSource` member for test runner
output. **No extension to `FindingSource` is needed.** The `category: "failed-test"` discriminates
this adapter's findings from the acceptance-diagnose adapter's `acFailureToFinding`
(category `"assertion-failure"`). `TestFailure` has no `line` field; the `Finding.line` is
left unset (it is optional).

### 2. Full-suite gate rectification strategy

Add `src/operations/full-suite-rectify.ts` (or extend `autofix-cycle.ts`):

```typescript
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { ImplementerInput, ImplementerOutput } from "./implement";
import { implementerOp } from ".";
import type { TddConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder } from "../prompts";

/**
 * Factory so buildInput closes over `story` rather than reading ctx.story
 * (optional on CallContext; unsafe outside pipeline invocations).
 * Per cycle-types.ts §buildInput: "Captures closure context — do not thread
 * extras through FixCycleContext."
 */
export function makeFullSuiteRectifyStrategy(
  story: UserStory,
): FixStrategy<Finding, ImplementerInput, ImplementerOutput, TddConfig> {
  return {
    name: "full-suite-rectify",
    appliesTo: (finding) => finding.source === "test-runner" && finding.category === "failed-test",
    fixOp: implementerOp,
    buildInput: (findings) => ({
      story,
      contextMarkdown: RectifierPromptBuilder.failingTestContext(findings),
    }),
    extractApplied: () => ({ targetFiles: [], summary: "Fixed failing tests" }),
    maxAttempts: 3, // from config.execution.rectification.maxRetries
    coRun: "exclusive",
  };
}
```

The strategy reuses `implementerOp` — no new fix-op needed. Prompt construction
(`RectifierPromptBuilder.failingTestContext`) must be added to
`src/prompts/builders/rectifier-builder.ts` per the project's prompt-builder convention
(all LLM prompt construction lives in `src/prompts/builders/`; inline prompt templates in
strategy files are forbidden).

### 3. Extend `addRectification`'s validator

`addRectification`'s `cycle.validate` callback in `src/execution/story-orchestrator.ts`
currently re-runs the verifier only and ignores its second argument:

```typescript
validate: async (_validateCtx) => {
  await runPhase(ctx, verifierPhase, phaseCosts, phaseOutputs);
  return extractPhaseFindings(phaseOutputs[verifierPhase.slot.op.name]);
},
```

US-006 extends it to (a) also re-run the full-suite gate (if present) and aggregate
findings from **both**, and (b) honor the `opts.mode === "lite"` second argument that
`runFixCycle` already passes on the terminal-exhausted branch (`src/findings/cycle.ts:309`).
In lite mode, only the verifier re-runs — the full-suite gate is the expensive op and
skipping it is the entire point of lite-validate. `fullSuiteGatePhase` is derived from
`state.fullSuiteGate` at the top of `runRectification`:

```typescript
validate: async (_validateCtx, opts) => {
  if (ctx.runtime.signal?.aborted) return [];
  const lite = opts?.mode === "lite";
  // Re-run validators in canonical order: gate before verifier (matches phase order).
  // Lite mode skips the full-suite gate to keep terminal exhausted re-validation cheap.
  const fullSuiteGatePhase = state.fullSuiteGate;
  if (fullSuiteGatePhase && !lite) {
    await runPhase(ctx, fullSuiteGatePhase.slot, phaseCosts, phaseOutputs);
  }
  await runPhase(ctx, verifierPhase.slot, phaseCosts, phaseOutputs);
  const findings: Finding[] = [];
  if (fullSuiteGatePhase && !lite) {
    findings.push(...extractPhaseFindings(phaseOutputs[fullSuiteGatePhase.slot.op.name]));
  }
  findings.push(...extractPhaseFindings(phaseOutputs[verifierPhase.slot.op.name]));
  return findings;
},
```

**Performance note:** re-running the full test suite every rectification iteration is
expensive. Two mitigations:
- **(i)** Use the scoped test runner (`src/verification/scoped-runner.ts`) when failures are
  attributable to a small file set — already a pattern in `runRectificationLoop`.
- **(ii)** Add a `rectificationValidateMode: "full" | "scoped"` config knob (new key) that
  defaults to `"scoped"`. Out-of-scope flag if scope grows; see §Open Questions.

### 4. Short-circuit carve-out

**Today's behaviour.** `ExecutionPlan.run()` (`src/execution/story-orchestrator.ts:332-348`)
loops over phases, runs each, and breaks on the first `!phasePassed`. After the loop —
*regardless of whether it broke* — `runRectification` is called unconditionally. So
rectification already runs after gate failure today; the bug US-006 fixes is *upstream*
of that: when the loop breaks at the gate, the verifier never runs, and the
existing single-source-validator pulls findings only from whatever phases completed
before the break. The carve-out's purpose is therefore not "let rectification run" — it is
**"let both the gate and the verifier emit findings into `phaseOutputs` before
rectification consumes them, so the §3 multi-source validator has both sources to
aggregate."**

Without rectification configured, the exempt set must stay empty so a gate failure still
halts the plan (no point continuing to the verifier if nothing will repair the failure).

Add to `ExecutionPlan.run()`:

```typescript
// Exempt gate + verifier from short-circuit only when rectification is configured
// (it will consume their failures). Without rectification, failures still halt the plan.
const shortCircuitExempt = this.state.rectification
  ? new Set<string>([fullSuiteGateOp.name, verifierOp.name])
  : new Set<string>();

for (const phase of collectOrderedPhases(this.state)) {
  await runPhase(this.ctx, phase.slot, phaseCosts, phaseOutputs);
  const passed = phasePassed(phase.slot.op.name, phaseOutputs[phase.slot.op.name]);
  if (!passed && !shortCircuitExempt.has(phase.slot.op.name)) {
    break; // existing short-circuit
  }
  // exempt phases continue; rectification picks up their failures
}
```

Both the verifier (already exempt today by virtue of rectification consuming its failures)
and the full-suite gate (newly exempt) flow into rectification when present. When
rectification is NOT configured, the exempt set is empty and both still short-circuit.

### 5. Triage logic in `fullSuiteGateOp.execute()` (post-US-005 state)

`fullSuiteGateOp.execute()` (US-005 implementation) already encodes the following decision
tree. US-006 removes the internal rectification call and adds `findings` to the output; the
rest of the triage stays unchanged.

| Condition | Current status | US-006 change |
|:---|:---|:---|
| Tests pass | `{ success: true, status: "passed", findings: [] }` | None |
| Tests fail, parser returns structured failures | `{ success: false, status: "failed-no-rectification" }` → loops into `runRectificationLoop` | Remove `runRectificationLoop`; rename status to `"failed"`; populate `findings: testSummaryToFindings(parsedSummary)` |
| Tests fail, parser returns 0 structured failures (`failed > 0` but `failures.length === 0`) | `{ success: false, status: "execution-failed" }` | Add `findings: []`; no other change |
| `rectificationEnabled = false` (tests failed) | `{ success: false, status: "failed-no-rectification" }` | Remove `rectificationEnabled` flag entirely — caller decides whether to wire rectification; status becomes `"failed"` |

After §0, `FullSuiteGateInput.rectificationEnabled` is gone. The op always runs tests and
returns `findings`; whether to run rectification is now determined by whether the plan
includes a rectification phase (§4 short-circuit carve-out handles the gateway).

### 6. Delete sites

US-006 retires:

- `src/verification/rectification-loop.ts` — `runRectificationLoop` deleted. There are
  **three** callers that must be addressed before deletion:

  | Caller | Current import | Action |
  |:---|:---|:---|
  | `src/operations/full-suite-gate.ts` | `from "../tdd"` (tdd/rectification-runner.ts) | ✅ Already migrated in US-005; removed in §0 above |
  | `src/pipeline/stages/rectify.ts:140` | `from "../../verification/rectification-loop"` | Rewire to use `runFixCycle` via the general rectification phase, or redirect import to `"../../tdd"` if the TDD version is semantically equivalent for this call-site |
  | `src/execution/lifecycle/run-regression.ts:18` | `from "../../verification/rectification-loop"` | Same: rewire to `runFixCycle` or redirect to `"../../tdd"` |

  AC-7's verification grep must confirm zero callers remain after all three are addressed.

- `fullSuiteGateOp`'s internal rectification deps — `FullSuiteGateDeps.runRectificationLoop`
  method, `FullSuiteGateInput.rectificationEnabled`, `FullSuiteGateInput.implementerTier`
  (gate no longer drives rectification; see §0).

- `test/unit/verification/rectification-loop*.test.ts` — replaced by rectification-phase tests
  that exercise the full-suite-failure path through `runFixCycle`.

---

## Stories

Two stories. **US-006a** is additive — it stands up the replacement rectification path
without removing the legacy one. **US-006b** is a terminal-cleanup story — pure deletions
and grep-zero assertions over the artefacts US-006a obsoleted. Splitting per the
spec-writing terminal-cleanup-story rule (additive and destructive ACs must not co-mingle).

### US-006a: Wire full-suite rectification into the general rectification phase (additive)

**Depends on:** US-005 (StoryOrchestratorBuilder consolidation must land first — gates must
exist as phases, builder must dispatch them, before this story can rewire the rectification
contract).

Implement Design §0–§5 and the additive parts of §6 (rewire callers in
`pipeline/stages/rectify.ts` and `execution/lifecycle/run-regression.ts`; do **not** delete
`src/verification/rectification-loop.ts` yet — that lands in US-006b once all callers are
proven gone).

**Covers ACs:** 1, 2, 3, 4, 5, 6, 7.

#### Context Files

- `src/findings/cycle.ts` — `runFixCycle` SSOT (read-only reference for validator semantics)
- `src/findings/types.ts` — `Finding`, `FindingSource` (no extension needed; `"test-runner"` already exists)
- `src/findings/adapters/` — add `test-failure.ts`
- `src/operations/full-suite-rectify.ts` — new file (strategy definition)
- `src/operations/full-suite-gate.ts` — created in US-005; modified in §0 to remove internal
  rectification, extend `FullSuiteGateOutput` with `findings`, simplify `FullSuiteGateStatus`
- `src/execution/story-orchestrator.ts` — extend `addRectification` validator (§3) to
  re-run gate+verifier and honor `opts.mode === "lite"`; add short-circuit carve-out (§4)
- `src/test-runners/types.ts` — source of `TestSummary` / `TestFailure` for the adapter
- `src/prompts/builders/rectifier-builder.ts` — add `failingTestContext(findings: Finding[]): string`
- `src/execution/build-plan-for-strategy.ts` — created in US-005; updated to include
  `fullSuiteRectifyStrategy` in the rectification strategies array
- `src/pipeline/stages/rectify.ts` — rewire `runRectificationLoop` import (§6)
- `src/execution/lifecycle/run-regression.ts` — rewire `runRectificationLoop` import (§6)

### US-006b: Retire the legacy rectification loop (terminal cleanup, deletion-only)

**Depends on:** US-006a (replacement path live; AC-7's grep proves the new strategy is
wired; only then can the legacy loop and its tests be removed safely).

Delete-only. No new logic, no new tests, no behavioural change beyond removal of dead code.

**Covers ACs:** 8, 9, 10.

#### Context Files

- `src/verification/rectification-loop.ts` — to delete (no remaining callers after US-006a)
- `src/verification/index.ts` — remove `runRectificationLoop` export
- `test/unit/verification/rectification-loop*.test.ts` — to delete (replacement coverage
  lives in the rectification-phase tests added in US-006a)

---

## Acceptance Criteria

### US-006a — Additive (no deletions)

1. **[file]** `src/findings/adapters/test-failure.ts` exists and exports both
   `testFailureToFinding(failure: TestFailure): Finding` and
   `testSummaryToFindings(summary: TestSummary): Finding[]` with the field mapping from §1
   (`failure.error → message`, `failure.testName → rule`, `failure.file → file`,
   `source: "test-runner"`, `category: "failed-test"`). No changes to `FindingSource`.
   **[verbatim] [grep]** `grep -nE 'export function testFailureToFinding\(failure: TestFailure\): Finding' src/findings/adapters/test-failure.ts` returns ≥1 match AND
   `grep -nE 'export function testSummaryToFindings\(summary: TestSummary\): Finding\[\]' src/findings/adapters/test-failure.ts` returns ≥1 match.

2. **[file]** `src/operations/full-suite-rectify.ts` exists and exports
   `makeFullSuiteRectifyStrategy(story: UserStory): FixStrategy<Finding, ImplementerInput, ImplementerOutput, TddConfig>`.
   The factory closes over `story` so `buildInput` never reads `ctx.story` (optional on
   `CallContext`; unsafe outside pipeline invocations). Per `cycle-types.ts` §buildInput:
   "Captures closure context — do not thread extras through FixCycleContext."
   `appliesTo` matches `source: "test-runner" && category: "failed-test"`. `fixOp`
   references `implementerOp` (no new fix-op created). Prompt construction delegates to
   `RectifierPromptBuilder.failingTestContext`.
   **[verbatim] [grep]** `grep -nE 'export function makeFullSuiteRectifyStrategy' src/operations/full-suite-rectify.ts` returns ≥1 match AND
   `grep -nE 'fixOp: implementerOp' src/operations/full-suite-rectify.ts` returns ≥1 match AND
   `grep -nE 'RectifierPromptBuilder\.failingTestContext' src/operations/full-suite-rectify.ts` returns ≥1 match.

3. **[unit]** `fullSuiteGateOp.execute()` returns `{ success, status, findings: Finding[] }`
   populated from `testSummaryToFindings(parsedSummary)` when tests fail. Status is `"failed"`
   (not `"failed-no-rectification"` / `"rectification-exhausted"`). No internal rectification
   loop exists in the op; `FullSuiteGateInput.rectificationEnabled` is removed.
   **[verbatim] [grep]** `grep -nE '"rectification-exhausted"|"failed-no-rectification"|rectificationEnabled' src/operations/full-suite-gate.ts` returns 0 lines AND
   `grep -nE 'runRectificationLoop' src/operations/full-suite-gate.ts` returns 0 lines.

4. **[unit]** `addRectification`'s `cycle.validate` re-runs the full-suite gate (when
   present in the plan) AND the verifier in canonical order, returning aggregated findings
   from both. Unit test asserts `cycle.validate` triggers `runPhase` for both phases when
   `state.fullSuiteGate` is non-null, and only the verifier when null.

5. **[unit]** `cycle.validate` honors the `opts.mode === "lite"` second argument. When
   `mode: "lite"`, the validator skips re-running the full-suite gate (which is the
   expensive op) and re-runs only the verifier — matching the lite-validate branch in
   `runFixCycle` at `src/findings/cycle.ts:309`. Unit test passes `{ mode: "lite" }` and
   asserts the gate's `runPhase` is NOT invoked.

6. **[unit]** `ExecutionPlan.run()` short-circuit logic exempts `fullSuiteGateOp.name` and
   `verifierOp.name` from termination on `success: false` when a rectification phase is
   present. When rectification is absent, the exempt set is empty and both phases
   short-circuit as before. Table-driven test over
   `(gate-success, verifier-success, rectification-enabled)` covers the 2×2×2 matrix.

7. **[grep] [unit]** `makeFullSuiteRectifyStrategy` is wired into the rectification phase via
   `build-plan-for-strategy.ts`. End-to-end unit test passes through the full path:
   gate fails with structured findings → strategy fires → `implementerOp` dispatches.
   **[verbatim] [grep]** `grep -nE 'makeFullSuiteRectifyStrategy' src/execution/build-plan-for-strategy.ts` returns ≥1 match.

### US-006b — Terminal cleanup (deletion-only)

**Depends on:** US-006a (all additive work landed; gate-internal rectification has a
working replacement before the legacy loop is deleted).

8. **[verbatim] [file]** `src/verification/rectification-loop.ts` does not exist
   (`test -f src/verification/rectification-loop.ts && exit 1 || exit 0`).
   **[verbatim] [grep]** `grep -rnE 'from ["'\''"]\.\./\.\./verification/rectification-loop["'\''"]\|from ["'\''"]\.\./verification/rectification-loop["'\''"]' src/` returns 0 lines (all three callers from §6 — `full-suite-gate.ts`, `pipeline/stages/rectify.ts`, `execution/lifecycle/run-regression.ts` — rewired or redirected).

9. **[verbatim] [grep]** `runFixCycle` is the only rectification loop in the codebase.
   `grep -rnE 'function runRectification[A-Za-z]*\(' src/ | grep -v 'src/execution/story-orchestrator.ts' | grep -v 'src/tdd/rectification-runner.ts'` returns 0 lines.
   (The orchestrator's `runRectification` helper that wraps `runFixCycle` and the
   `runRectificationLoop` symbol re-exported from `src/tdd/rectification-runner.ts` are the
   only permitted matches — the latter is consumed by the legacy `full-suite-gate.ts`
   pre-§0 only, and is removed by AC-8 above.)

10. **[verbatim] [file]** Legacy test files removed:
    `test -f test/unit/verification/rectification-loop.test.ts && exit 1 || exit 0` AND
    `find test/unit/verification -name 'rectification-loop*.test.ts' | wc -l` returns `0`.
    **[verbatim] [grep]** Replacement coverage exists in the rectification-phase test:
    `grep -rnE 'full-suite-rectify|fullSuiteRectifyStrategy' test/unit/execution/ test/unit/findings/` returns ≥1 match.

---

## Failure Handling

- **Test-suite parser returns malformed `TestSummary`** — `testSummaryToFindings` returns
  `[]`. `fullSuiteGateOp.execute()` returns `{ success: false, status: "execution-failed",
  findings: [] }`. Rectification has no findings to fix; story fails through gate output.
- **`fullSuiteRectifyStrategy.maxAttempts` exhausted** — `runFixCycle` exits with
  `exitReason: "max-attempts-per-strategy"`. Wrapper maps this to
  `failureCategory: "full-suite-gate-exhausted"` for parity with current behavior.
- **Rectification re-validate hits abort signal** — `cycle.validate` returns `[]`
  immediately; `runFixCycle` exits as resolved (existing pattern).

---

## Non-Goals

- **No changes to `FindingSource`** — `"test-runner"` is reused as-is.
- **No changes to `runFixCycle` itself.** All US-006 work is in the validator callback,
  the strategy definition, and the gate op's `execute()`.
- **No changes to `StoryOrchestratorBuilder` API.** `addRectification` signature unchanged;
  callers pass an additional strategy in `RectificationPhaseOptions.strategies`.
- **No new builder phases.** US-005's `CANONICAL_ORDER` is unchanged.

---

## Open Questions

1. ~~**SessionKeeper consumer audit.**~~ **CLOSED.** `src/tdd/rectification-gate.ts` is
   confirmed deleted by US-005 (not present on disk). After deleting
   `src/verification/rectification-loop.ts`, `SessionKeeper` still has one caller:
   `src/tdd/rectification-runner.ts`. Exports from `src/session/index.ts` must stay;
   this is a no-op for US-006.

2. ~~**Performance: full-suite re-run cost per iteration.**~~ **CLOSED.** Resolution: the
   §3 validator honors `opts.mode === "lite"` and skips the full-suite gate on the
   terminal-exhausted lite-validate branch (AC-5). For non-terminal iterations, the gate
   re-runs in full — matching today's `runRectificationLoop` behaviour, which already
   re-runs the suite per iteration. Scoped-runner integration is out of scope for US-006;
   if cost regression is observed in practice, add a `rectificationValidateMode: "full"
   | "scoped"` config key in a follow-up. Decision recorded so implementers don't
   re-litigate during US-006a.

3. **Strategy ordering when both `fullSuiteRectifyStrategy` and review-finding strategies
   match.** `runFixCycle`'s `selectExecutionGroup` picks the first exclusive strategy. If a
   single rectification iteration sees both test failures (from gate) and lint findings
   (from semantic), which fix-op runs? Recommend: test failures take priority
   (`fullSuiteRectifyStrategy.coRun = "exclusive"` and declared first), since failing tests
   block downstream signal.

4. **Backwards compat for `failureCategory: "full-suite-gate-exhausted"`.** This category
   was previously emitted by `runFullSuiteGate` directly. After US-006, it must emerge from
   `runFixCycle`'s `exitReason: "max-attempts-per-strategy"` → `FailureCategory` mapping in
   the post-run wrapper. The wrapper should key on `exhaustedStrategy === "full-suite-rectify"`
   to emit `"full-suite-gate-exhausted"` vs. the generic `"rectification-exhausted"` for
   other strategy exhaustions. Confirm the mapping before marking AC-8 done.

---

## Revision History

| Rev | Date | Change |
|:---|:---|:---|
| 1 | 2026-05-19 | Initial draft — deferred from SPEC-story-orchestrator-consolidation.md OQ1. |
| 2 | 2026-05-20 | Spec review fixes: add §0 (DeterministicOperation stays, extend FullSuiteGateOutput); fix TestFailure field names (error not message, no line field); switch FindingSource to "test-runner" (no extension needed); rewrite Design §5 against post-US-005 codebase; expand §6 deletion scope to all 3 callers; fix shortCircuitExempt guard; fix validate signature; add RectifierPromptBuilder.failingTestContext; fix Context Files (test-runners/types.ts); close OQ-1. |
| 3 | 2026-05-20 | Second spec-review pass: tag every AC with `[file]` / `[grep]` / `[unit]` / `[verbatim]` mechanisms (Phase 7); add wiring AC for `fullSuiteRectifyStrategy` in `build-plan-for-strategy.ts` (was implicit in §6 Context Files, no AC); split single story into **US-006a** (additive, AC1–AC7) and **US-006b** (terminal cleanup, AC8–AC10) per deletion-isolation rule; add AC-5 for `opts.mode === "lite"` validator behaviour (§3 was silent on the second arg `runFixCycle` already passes); reword §4 to clarify the carve-out is about emission-into-`phaseOutputs`, not about whether rectification runs at all; close OQ-2 (lite-mode skip is the resolution, no new config key). |
