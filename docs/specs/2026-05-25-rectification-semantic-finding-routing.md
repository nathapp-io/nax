# Rectification — semantic-finding routing & validation scope

**Date:** 2026-05-25
**Status:** Pre-implementation
**Scope:** Three patches across `src/execution/story-orchestrator.ts`, `src/operations/autofix-implementer-strategy.ts`, `src/operations/autofix-test-writer-strategy.ts`, `src/findings/cycle-types.ts`, `src/findings/cycle.ts`, and a new helper in `src/operations/_finding-to-check.ts`.
**Regression introduced by:** [#1084](https://github.com/nathapp-io/nax/pull/1084) (commit `f38aedf2` — execution unification)
**Evidence:**
- Run log: `logs/2026-05-24T16-23-29.jsonl` line 234 (`Semantic review failed: 3 findings`)
- Prompt audit: `logs/prompt-audit/cup-and-handle-detector/1779646952504-...-implementer-run-t04.txt` (Turn 4 sent `Fix the following 6 failing tests:` instead of the 3 semantic findings)

---

## 1. Problem statement

Cup-and-handle dogfood run (2026-05-24, story `US-001`):

1. `full-suite-gate` (deterministic) executed the polyglot test suite and produced **6 test-runner findings** that the verifier judged as pre-existing/unrelated regressions. Verifier session completed (log line 207, "Session complete: verifier") and "Isolation maintained" (line 208) — and crucially, semantic-review ran afterwards (line 213+), which would only happen if the verifier did not short-circuit the plan.
2. `semantic-review` then failed with **3 findings** (log line 234).
3. The rectification cycle should have routed those 3 semantic findings to `autofix-implementer`. Instead, Turn 4 of the warm implementer session received `Fix the following 6 failing tests:` for the 6 gate findings. The implementer's own response, captured in the audit file at the same turn, confirms these were pre-existing failures: *"Current status: 21 passed, 4 failed (same as before my involvement)"*. The implementer spent ~70 minutes (Duration: 4211422ms in the audit header) attempting fixes the story didn't own, and the 3 semantic findings were never addressed.

Two distinct defects produced the wrong prompt; a third defect re-dispatches the verifier on every rectification iteration even though TDD isolation is satisfied by the strategy-routing layer (see §1.3).

### 1.1 Defect A — `runRectification` ignores the verifier-as-SSOT carve-out

[src/execution/story-orchestrator.ts:228-249](../../src/execution/story-orchestrator.ts#L228-L249):

```ts
function gatherRectificationFindings(phaseOutputs, phases) {
  const findings: Finding[] = [];
  for (const phase of phases) {
    findings.push(...extractPhaseFindings(phaseOutputs[phase.slot.op.name]));
  }
  return findings;
}

function collectRectificationPhases(state) {
  return [
    state.fullSuiteGate, state.verifier, state.verifyScoped,
    state.lintCheck, state.typecheckCheck,
    state.semanticReview, state.adversarialReview,
  ].filter(...);
}
```

The same module already enforces a verifier-as-SSOT carve-out in two other sites — `ExecutionPlan.run` success aggregation (lines 629-644) and `deriveFailureCategory` in `post-run.ts:123-138`: when the verifier explicitly passed, `full-suite-gate` failures are treated as unrelated regressions and excluded from downstream decisions.

`gatherRectificationFindings` and the `validate` callback (lines 502-514) make no such exclusion, so the 6 gate findings enter the cycle alongside the 3 semantic findings.

Combined with `selectExecutionGroup` ([src/findings/cycle.ts:111-119](../../src/findings/cycle.ts#L111-L119)) which returns the **first exclusive** strategy when one is active:

```ts
const exclusive = active.find((s) => !s.coRun || s.coRun === "exclusive");
if (exclusive) return [exclusive];
```

and `makeFullSuiteRectifyStrategy` declaring `coRun: "exclusive"` ([src/operations/full-suite-rectify.ts:29](../../src/operations/full-suite-rectify.ts#L29)), the full-suite strategy monopolises the execution group and starves `autofix-implementer`.

### 1.2 Defect B — autofix strategies drop their `_findings` parameter

[src/operations/autofix-implementer-strategy.ts:17-20](../../src/operations/autofix-implementer-strategy.ts#L17-L20):

```ts
buildInput: (_findings, _prior, _cycleCtx): AutofixImplementerInput => ({
  failedChecks: [],
  story,
}),
```

Same shape in [autofix-test-writer-strategy.ts:17-21](../../src/operations/autofix-test-writer-strategy.ts#L17-L21).

`RectifierPromptBuilder.reviewRectification([], story)` falls through to the "mixed" branch ([rectifier-builder.ts:626](../../src/prompts/builders/rectifier-builder.ts#L626)) and emits a degenerate prompt with empty error sections. Even after Defect A is fixed, the implementer would receive no actual finding text.

### 1.3 Defect C — `validate` re-runs the verifier inside rectification, but TDD isolation is satisfied by routing, not by re-verification

[src/execution/story-orchestrator.ts:502-514](../../src/execution/story-orchestrator.ts#L502-L514):

```ts
validate: async (_validateCtx, opts) => {
  if (ctx.runtime.signal?.aborted) return [];
  const lite = opts?.mode === "lite";
  const findings: Finding[] = [];
  for (const phase of validationPhases) {
    if (lite && phase.kind === "full-suite-gate") continue;
    await runPhase(ctx, phase.slot, phaseCosts, phaseOutputs);
    findings.push(...extractPhaseFindings(phaseOutputs[phase.slot.op.name]));
  }
  return findings;
}
```

The verifier's job is **TDD isolation** — confirm the implementer modified source code without touching tests, against the git ref captured at story start. Inside rectification this re-run is redundant by design, because **rectification routes edits to the role that owns them**:

| Finding kind | Routed to | What it edits |
|:---|:---|:---|
| `fixTarget === "source"` + source-judging findings (lint, typecheck, semantic-review) | `autofix-implementer` | Source files only |
| `fixTarget === "test"` or adversarial-review findings | `autofix-test-writer` | Test files only |
| `test-runner` failed-test findings | `full-suite-rectify` → `implementerOp` | Source files (to make tests pass) |
| Mechanical (lint/format) | `mechanical-lintfix` / `mechanical-formatfix` | Source files |

Strategy `appliesTo` predicates ([autofix-implementer-strategy.ts:15](../../src/operations/autofix-implementer-strategy.ts#L15), [autofix-test-writer-strategy.ts:15](../../src/operations/autofix-test-writer-strategy.ts#L15)) enforce this partition. Test edits during rectification go through the test-writer role *by construction*; an implementer-role strategy that needs to touch a test file uses the explicit `TEST_EDIT_REASON` escape hatch (`autofix-implementer.ts:40-48`), which is parsed and logged, not policed by a re-dispatched verifier.

Two practical consequences of re-running the verifier today:

- The verifier is the most expensive LLM call in the pipeline (~4 minutes per turn in the 2026-05-24 affected run). Each rectification iteration re-spent it for no isolation gain.
- The isolation check anchors on `beforeRef` captured by `runPhase` at the moment of dispatch. On re-run inside rectification, `beforeRef` is captured *after* the prior fix commits, so the check degenerates — it sees only the most recent rectification commit, not the story-scoped diff it was designed to police.

A secondary concern is over-broad re-validation: after an `autofix-implementer` fix targets only semantic findings, validate also re-runs `full-suite-gate` + `lint-check` + `typecheck-check` + `adversarial-review`. Mechanical strategies (`mechanical-lintfix`, `mechanical-formatfix`) only touch lint findings yet trigger the same broad sweep. Cost and runtime savings are available without giving up correctness, provided the re-validation set scales with the strategy's impact surface.

---

## 2. Fix plan

### 2.1 Patch 1 — Verifier-as-SSOT carve-out in rectification (Defect A)

**File:** `src/execution/story-orchestrator.ts`

Centralise the carve-out as a helper, then apply it in both `gatherRectificationFindings` and the `validate` callback.

```ts
/**
 * Verifier-as-SSOT: when the verifier explicitly passed, full-suite-gate
 * failures represent unrelated regressions that this story did not cause.
 * Excluded from rectification (mirrors the carve-out in ExecutionPlan.run
 * success aggregation and post-run.ts:deriveFailureCategory).
 */
function shouldSkipPhaseForRectification(
  phase: InternalPhase,
  state: InternalBuildState,
  phaseOutputs: Record<string, unknown>,
): boolean {
  if (phase.kind !== "full-suite-gate") return false;
  const verifierName = state.verifier?.slot.op.name;
  if (!verifierName) return false;
  return phaseExplicitlyPassed(phaseOutputs[verifierName]);
}

function gatherRectificationFindings(
  phaseOutputs: Record<string, unknown>,
  phases: readonly InternalPhase[],
  state: InternalBuildState,
): Finding[] {
  const findings: Finding[] = [];
  for (const phase of phases) {
    if (shouldSkipPhaseForRectification(phase, state, phaseOutputs)) continue;
    findings.push(...extractPhaseFindings(phaseOutputs[phase.slot.op.name]));
  }
  return findings;
}
```

In `runRectification` (line 474) update the call site:

```ts
const initialFindings = gatherRectificationFindings(phaseOutputs, validationPhases, state);
```

And in the `validate` callback (line 502):

```ts
validate: async (_validateCtx, opts) => {
  if (ctx.runtime.signal?.aborted) return [];
  const lite = opts?.mode === "lite";
  const findings: Finding[] = [];
  for (const phase of validationPhases) {
    if (lite && phase.kind === "full-suite-gate") continue;
    await runPhase(ctx, phase.slot, phaseCosts, phaseOutputs);
    if (shouldSkipPhaseForRectification(phase, state, phaseOutputs)) continue;
    findings.push(...extractPhaseFindings(phaseOutputs[phase.slot.op.name]));
  }
  return findings;
}
```

**Notes.**
- We still *run* `full-suite-gate` during re-validation so its output remains current in `phaseOutputs` (consumed by `ctx.fullSuiteGatePassed` in `applyPostRunInspection`). We only stop *feeding* its findings into the cycle.
- The carve-out is **all-or-nothing per phase** — every gate finding is either included or excluded by the verifier's verdict. The prompt-routing fix downstream relies on this: with mixed gate + semantic findings included, `selectExecutionGroup` ([src/findings/cycle.ts:111-119](../../src/findings/cycle.ts#L111-L119)) picks `full-suite-rectify` (exclusive `coRun`) and starves `autofix-implementer` (co-run-sequential). Patch 1 must exclude gate findings fully, not partially, for Patch 2 to take effect.

### 2.2 Patch 2 — Convert findings to synthetic `ReviewCheckResult[]` (Defect B)

**Files:** `src/operations/autofix-implementer-strategy.ts`, `src/operations/autofix-test-writer-strategy.ts`. New shared helper in `src/operations/_finding-to-check.ts`.

Create the helper. Synthetic `ReviewCheckResult` entries are populated from findings grouped by `source`; downstream `RectifierPromptBuilder.reviewRectification` already routes on `check === "semantic" | "adversarial"`, so source-to-check mapping is the only logic needed.

```ts
// src/operations/_finding-to-check.ts
import type { Finding } from "../findings/types";
import type { ReviewCheckName, ReviewCheckResult } from "../review/types";

const SOURCE_TO_CHECK: Record<string, ReviewCheckName> = {
  "semantic-review": "semantic",
  "adversarial-review": "adversarial",
  lint: "lint",
  typecheck: "typecheck",
};

/**
 * Group findings by their producer-source and emit one synthetic
 * ReviewCheckResult per group. The prompt builder consumes
 * `check.check`, `check.findings`, and `check.output`; other fields are
 * inert defaults. Findings whose source has no review-check mapping are
 * dropped (they shouldn't reach an autofix strategy — `appliesTo` filters
 * them out upstream, but we stay defensive).
 */
export function findingsToFailedChecks(findings: readonly Finding[]): ReviewCheckResult[] {
  const grouped = new Map<ReviewCheckName, Finding[]>();
  for (const finding of findings) {
    const check = SOURCE_TO_CHECK[finding.source];
    if (!check) continue;
    const bucket = grouped.get(check) ?? [];
    bucket.push(finding);
    grouped.set(check, bucket);
  }

  return [...grouped.entries()].map(([check, findings]) => ({
    check,
    success: false,
    command: "",
    exitCode: 1,
    output: "",
    durationMs: 0,
    findings,
  }));
}
```

Update both strategies to consume `_findings`:

```ts
// src/operations/autofix-implementer-strategy.ts
buildInput: (findings, _prior, _cycleCtx): AutofixImplementerInput => ({
  failedChecks: findingsToFailedChecks(findings),
  story,
}),

// src/operations/autofix-test-writer-strategy.ts
buildInput: (findings, _prior, _cycleCtx): AutofixTestWriterInput => ({
  failedChecks: findingsToFailedChecks(findings),
  story,
  blockingThreshold: config.review?.blockingThreshold,
}),
```

Export `findingsToFailedChecks` from `src/operations/index.ts` so future strategies share it.

### 2.3 Patch 3 — Scope `validate` to the strategy that just ran (Defect C)

**Files:** `src/findings/cycle-types.ts`, `src/findings/cycle.ts`, `src/execution/story-orchestrator.ts`

**Premise.** Rectification routes test edits to `autofix-test-writer` and source edits to `autofix-implementer` by construction (strategy `appliesTo` predicates partition the finding space). TDD isolation is therefore satisfied by the routing layer — there is no rectification path that can produce an undeclared test edit by an implementer-role session, so a re-dispatched verifier has no isolation work to do. Patch 3 drops the verifier from validate re-runs unconditionally, and narrows the remaining re-validation phases to those whose output the just-applied fix can actually change.

Three steps.

**Step 3a — fix the current `FixCycle.validate` contract.** Today ([src/findings/cycle-types.ts:179](../../src/findings/cycle-types.ts#L179)):

```ts
validate: (ctx: FixCycleContext, opts: { mode: "full" | "lite" }) => Promise<F[]>;
```

`opts` and `mode` are both required. Extend with an optional `strategiesRun`:

```ts
validate: (
  ctx: FixCycleContext,
  opts: { mode: "full" | "lite"; strategiesRun?: readonly string[] },
) => Promise<F[]>;
```

Also: the orchestrator's current callback uses `opts?.mode === "lite"` defensively, masking the required contract. After this patch the orchestrator must read `opts.mode === "lite"` without the optional chain so the contract is enforced at the call sites that already comply.

**Step 3b — thread `strategiesRun` from `runFixCycle`.** Both validate call sites in `src/findings/cycle.ts` happen *after* the iteration's fixes have applied (lite at line 309 inside the `allExhausted` branch; full at line 386 after the standard fix loop), so `group.map(s => s.name)` is the in-scope value at both sites. Pass it through:

```ts
// cycle.ts:309 (lite recheck after per-strategy exhaustion)
liteFindingsAfter = await cycle.validate(ctx, {
  mode: "lite",
  strategiesRun: group.map((s) => s.name),
});

// cycle.ts:386 (full validate after each iteration's fixes)
findingsAfter = await cycle.validate(ctx, {
  mode: "full",
  strategiesRun: group.map((s) => s.name),
});
```

**Step 3c — strategy → re-validation phase mapping.** Verifier is excluded from every entry because its TDD-isolation job is one-shot:

```ts
const STRATEGY_TO_REVALIDATION_PHASES: Record<string, readonly PhaseKind[]> = {
  // Mechanical fixes touch only their own concern — narrow re-run.
  "mechanical-lintfix": ["lint-check"],
  "mechanical-formatfix": ["lint-check"],

  // LLM source fixes can affect any source-dependent judge AND the full test
  // suite, so we re-run all source-dependent phases except the verifier.
  "autofix-implementer": [
    "lint-check",
    "typecheck-check",
    "full-suite-gate",
    "verify-scoped",
    "semantic-review",
    "adversarial-review",
  ],

  // Test-code fixes can affect lint/typecheck on the test file, the suite
  // (a new or fixed test changes pass/fail counts), and adversarial coverage
  // judgments. Semantic-review judges source-vs-AC, unaffected by test edits.
  "autofix-test-writer": [
    "lint-check",
    "typecheck-check",
    "full-suite-gate",
    "verify-scoped",
    "adversarial-review",
  ],

  // Full-suite-rectify edits source to make tests pass — same impact surface
  // as autofix-implementer, minus adversarial (whose target is test design,
  // not behavior fixes).
  "full-suite-rectify": [
    "lint-check",
    "typecheck-check",
    "full-suite-gate",
    "verify-scoped",
    "semantic-review",
  ],
};

function phasesToRevalidate(
  strategiesRun: readonly string[] | undefined,
  allPhases: readonly InternalPhase[],
): readonly InternalPhase[] {
  // Always exclude verifier from rectification re-runs — its TDD-isolation
  // job is one-shot, anchored to the story-start git ref.
  const sourceFiltered = allPhases.filter((p) => p.kind !== "verifier");

  // No attribution available (initial validate, or unknown strategy) → run
  // every non-verifier phase. Conservative fallback.
  if (!strategiesRun || strategiesRun.length === 0) return sourceFiltered;

  const unknown = strategiesRun.some((name) => STRATEGY_TO_REVALIDATION_PHASES[name] === undefined);
  if (unknown) return sourceFiltered;

  const needed = new Set<PhaseKind>();
  for (const name of strategiesRun) {
    for (const kind of STRATEGY_TO_REVALIDATION_PHASES[name] ?? []) needed.add(kind);
  }
  return sourceFiltered.filter((p) => needed.has(p.kind));
}
```

Replace the `validate` callback body:

```ts
validate: async (_validateCtx, opts) => {
  if (ctx.runtime.signal?.aborted) return [];
  const lite = opts.mode === "lite";
  const phases = phasesToRevalidate(opts.strategiesRun, validationPhases);
  const findings: Finding[] = [];
  for (const phase of phases) {
    if (lite && phase.kind === "full-suite-gate") continue;
    await runPhase(ctx, phase.slot, phaseCosts, phaseOutputs);
    if (shouldSkipPhaseForRectification(phase, state, phaseOutputs)) continue;
    findings.push(...extractPhaseFindings(phaseOutputs[phase.slot.op.name]));
  }
  return findings;
}
```

**Conservative defaults summary.**
- Unknown strategy in `strategiesRun` (e.g. plugin-supplied) → fall back to all non-verifier phases.
- Empty/undefined `strategiesRun` → same fallback.
- Verifier is *never* re-run from inside rectification, regardless of the strategy. The initial verifier pass remains the SSOT for TDD isolation.

**Why this is correct, not a trade-off.** Test edits during rectification do not flow through implementer-role sessions; they flow through `autofix-test-writer` (which dispatches `testWriterRectifyOp` in a test-writer session). The verifier's isolation check exists to confirm the *initial* implementer session respected the source/test boundary — a one-shot check anchored to the story-start git ref. Inside rectification, the routing layer is the boundary; re-dispatching the verifier asks a question the architecture has already answered.

---

## 3. Acceptance criteria

### Patch 1 (Defect A)

- **AC1.1** — `gatherRectificationFindings` skips `full-suite-gate` findings when `verifier` produced `{ success: true }` or `{ passed: true }`. Asserted via unit test in `test/unit/execution/story-orchestrator-rectification-exhaustion.test.ts`: given a state with `verifier.success=true` and `fullSuiteGate.findings=[testRunnerFinding]`, the gathered initial findings exclude the test-runner finding.

- **AC1.2** — When the verifier explicitly failed (`success: false`), `full-suite-gate` findings are still included. Same test file, sibling case.

- **AC1.3** — When no verifier phase is registered (non-TDD strategy), gate findings flow through unchanged (no regression of the verify-scoped path).

- **AC1.4** — In the validate callback, after a fix iteration runs, full-suite-gate is still *executed* (so `phaseOutputs[fullSuiteGate.name]` stays current for `applyPostRunInspection`) but its findings are excluded from the returned `Finding[]` under the same verifier-passed condition.

### Patch 2 (Defect B)

- **AC2.1** — `findingsToFailedChecks([semanticFinding])` returns `[{ check: "semantic", findings: [semanticFinding], success: false, ... }]`. Test in new `test/unit/operations/finding-to-check.test.ts`.

- **AC2.2** — Mixed-source findings produce one `ReviewCheckResult` per source. Test: `[semanticFinding, adversarialFinding] → 2 entries`.

- **AC2.3** — `makeAutofixImplementerStrategy(...).buildInput([semanticFinding], [], ctx)` returns `failedChecks` with one semantic entry containing the original finding (round-trip test).

- **AC2.4** — `makeAutofixTestWriterStrategy(...).buildInput([adversarialFinding], [], ctx)` returns `failedChecks` with one adversarial entry.

- **AC2.5** — End-to-end: with Patches 1 + 2 in place, an orchestrator run that produces `gate.findings=[6 test-runner]`, `verifier.success=true`, `semantic.findings=[3 semantic]` dispatches `autofix-implementer` (not `full-suite-rectify`) with a prompt that contains all 3 semantic finding messages. Asserted by an integration-style test in `test/integration/execution/` that captures the prompt sent to `implementerRectifyOp`.

### Patch 3 (Defect C)

- **AC3.1** — `phasesToRevalidate(undefined, allPhases)` and `phasesToRevalidate([], allPhases)` both return all phases **except `verifier`** (conservative default; verifier is always one-shot).

- **AC3.2** — `phasesToRevalidate(["autofix-implementer"], allPhases)` returns `lint-check`, `typecheck-check`, `full-suite-gate`, `verify-scoped`, `semantic-review`, `adversarial-review` — and explicitly omits `verifier`.

- **AC3.3** — `phasesToRevalidate(["mechanical-lintfix"], allPhases)` returns only `lint-check`. Same for `mechanical-formatfix`.

- **AC3.4** — `phasesToRevalidate(["full-suite-rectify"], allPhases)` returns `lint-check`, `typecheck-check`, `full-suite-gate`, `verify-scoped`, `semantic-review` — omits `verifier` and `adversarial-review`.

- **AC3.5** — `phasesToRevalidate(["unknown-plugin-strategy"], allPhases)` falls back to all non-verifier phases (unknown-strategy guard).

- **AC3.6** — `phasesToRevalidate(["mechanical-lintfix", "autofix-implementer"], allPhases)` is the union of both strategies' phase sets (still excluding verifier).

- **AC3.7** — `FixCycle.validate` signature in `cycle-types.ts` is `(ctx, opts: { mode: "full" | "lite"; strategiesRun?: readonly string[] }) => Promise<F[]>`. Both call sites in `cycle.ts` (lines 309 lite, 386 full) compile and pass `strategiesRun` where attribution is available.

- **AC3.8** — Integration: in a mocked story-orchestrator run that triggers rectification with semantic findings only, `verifierOp` is dispatched exactly once across the entire cycle (the initial pre-rectification call). Asserted by counting `callOp` invocations against `verifierOp` in `test/integration/execution/rectification-routing.test.ts`.

- **AC3.9** — Integration: after an `autofix-implementer` iteration, `full-suite-gate` (deterministic) and `semantic-review` are re-dispatched; `verifier` is not. Asserted by phase-output snapshot in the same integration test.

---

## 4. Sequencing & risk

| Patch | Risk | Sequencing |
|:------|:-----|:-----------|
| 1 | Low — narrow predicate, mirrors existing carve-out logic | Land first. Fixes the proximate user-visible bug. |
| 2 | Low — pure data shape conversion, no control-flow change | Land second. Cosmetic on its own; combined with Patch 1 it produces the corrected end-to-end behavior. |
| 3 | Medium — changes `FixCycle.validate` contract; removes verifier from rectification re-runs (intentional — routing partitions edits between implementer and test-writer roles, so isolation re-checking is structurally unnecessary) | Land last, after Patches 1 + 2 are stable. Bundles an architectural correctness change with the per-strategy re-validation narrowing. |

Patches 1 and 2 should ship together — Patch 1 alone routes the right finding type to `autofix-implementer`, but Patch 2 is required to make the prompt non-empty. A bundled PR for 1+2 is appropriate; Patch 3 can be a follow-up.

### 4.1 Test fixtures touched

- `test/unit/execution/story-orchestrator-rectification-exhaustion.test.ts` — extend with AC1.1 / AC1.2 / AC1.3 / AC1.4 cases.
- `test/unit/operations/finding-to-check.test.ts` — new file, AC2.1 / AC2.2.
- `test/unit/operations/autofix-implementer-strategy.test.ts` — extend with AC2.3.
- `test/unit/operations/autofix-test-writer-strategy.test.ts` — extend with AC2.4.
- `test/integration/execution/rectification-routing.test.ts` — new file, AC2.5 / AC3.8 / AC3.9.
- `test/unit/execution/story-orchestrator-revalidation.test.ts` — new file, AC3.1 / AC3.2 / AC3.3 / AC3.4 / AC3.5 / AC3.6. Lives next to the other story-orchestrator unit tests; mirrors `src/execution/story-orchestrator.ts` per `.claude/rules/test-architecture.md`.
- `test/unit/findings/cycle-types.test.ts` — extend (or create) with AC3.7 covering the updated validate signature and the lite/full call-site shape.

**Note for the implementer:** verify exact paths against `.claude/rules/test-architecture.md` mirroring rules (test files mirror src/ structure). The paths above are best-effort; adjust if the convention differs.

### 4.2 Non-goals

- Reworking `selectExecutionGroup` to allow exclusive + co-run-sequential strategies to share an iteration. The verifier-as-SSOT carve-out is sufficient — once the 6 gate findings are excluded, the cycle sees only semantic findings, only `autofix-implementer` is active, and exclusivity is moot.
- Migrating `makeFullSuiteRectifyStrategy` away from `coRun: "exclusive"`. The semantics are still correct for the cases where it does fire (verifier failed → behavior fix is exclusive by intent).
- Adding any isolation re-check inside the rectification loop. Routing partitions source vs. test edits across `autofix-implementer` and `autofix-test-writer` — re-verification would be asking a question the routing layer has already answered. New strategies that need to edit files outside their declared target should be rejected at strategy-design time, not re-policed at runtime.
- Reintroducing the verifier into rectification re-runs under any condition.

---

## 5. Backout

Each patch reverts cleanly:

- Patch 1 — delete `shouldSkipPhaseForRectification`, revert `gatherRectificationFindings` to its two-argument signature, and remove the `state` argument from its single call site in `runRectification`. Restore the original two-line body.
- Patch 2 — restore `failedChecks: []` in both strategy files; delete `_finding-to-check.ts`.
- Patch 3 — drop the `strategiesRun` parameter in `FixCycle.validate`; restore the inline iteration in `runRectification.validate`.

No schema or persisted artifact shape changes — backout is code-only.
