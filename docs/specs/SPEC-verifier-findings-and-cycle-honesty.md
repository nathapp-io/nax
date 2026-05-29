# SPEC: Verifier Findings + Rectification Cycle Exit Honesty

> **Code references pinned to SHA `52634c0b`.** Line numbers and named symbols below are valid at that revision. Re-anchor if rebasing onto a later main.

## Summary

Two coordinated changes to eliminate redundant verifier dispatches during rectification:

- **A (verifier findings):** Have the verifier op emit structured `Finding[]` for **categorized rejection reasons** (failing tests; illegitimate test edits), so rectification strategies can actually act on a verifier rejection instead of treating it as an opaque `success: false`.
- **C (cycle exit honesty):** Stop `runFixCycle` from classifying a short-circuited validate sweep as `"resolved"`. Surface a distinct `"validate-short-circuit"` exit reason and a `liteScopeIncomplete` flag, and adjust the post-rectification-resume guard so today's tier-2 lite-scope backfill keeps working.

Both changes ship in a single PR — A alone is correct only if C is in place (without C, the lite-validate short-circuit would still hide A's findings); C alone leaves the tier-1 wasted-dispatch case unresolved.

## Motivation

Real run on US-002 (feature `screener-ui-async-jobs-test`, log `2026-05-28T15-17-04.jsonl`) shows the same verifier session opened and closed **four times** across two tiers (`balanced` → `powerful`). With a single escalation the expected count is two. The two extra dispatches come from two compounding bugs:

### Tier 1 — verifier rejections are invisible to rectification

```
16:19:08  Phase passed: full-suite-gate (status: passed-on-timeout, findingsCount: 0)
16:33:11  verifier failed   ← close #1
16:33:12  Short-circuiting on phase failure (verifier)
          → runRectification entered, gatherRectificationFindings = 0
            (gate has 0 findings + success=true → [];
             verifier output has no `findings` / `normalizedFindings` field → [])
          → runRectification early-exits at story-orchestrator.ts:849
16:33:13  verifier session reopens immediately (post-rectification-resume)
16:38:50  verifier failed again on byte-identical code   ← close #2
16:38:50  Phase failed in post-rectification resume → second rectification (also 0 findings)
16:38:50  Terminal phase failure → Escalate to "powerful"
```

`VerifierOutput` (`src/operations/verify.ts:25-37`) carries no findings field. `extractPhaseFindings` (`story-orchestrator.ts:393-410`) reads only `normalizedFindings` / `findings`, so it returns `[]` for verifier rejections. `runRectification` short-cuts at `:849` with empty input → resume re-runs verifier on byte-identical code.

### Tier 2 — false "resolved" exit hides a real verifier failure

```
17:19:50  full-suite-gate failed, findingsCount: 72
17:22:05  rectification iter 1 — fixed 71/72
17:33:12  rectification iter 2 — still 1 finding (universe_cap regression)
17:34:46  rectification validate scope: lite mode    (full-suite-gate skipped per :890-892)
17:36:51  verifier failed in lite-validate          ← close #3
          → validate callback breaks at :901 (no findings extracted from verifier)
          → liteFindingsAfter.length === 0
          → cycle.ts:352 classifies as "resolved"   ← C bug
17:36:51  "Rectification resolved all findings"      (FALSE — verifier just failed)
17:37:19  Resume block runs full-suite-gate (lite had skipped it) → fails (1 finding)
17:37:19  Resume invokes second rectification
17:37–39  Second rectification fixes universe_cap in 3 implementer iters
17:41:12  Second rectification's lite-validate runs verifier → passes   ← close #4
```

Close #4 is legitimate (real fix in between). Close #3 is the duplicate. The resume block's tier-2 recovery exists today only because the cycle declared "resolved" by accident — future ops that fail validate with empty extractable findings re-hit the same bug.

## Non-Goals

- **Not fixing `passed-on-timeout` gate behaviour.** Separate gate-reporting bug.
- **Not redesigning the rectification cycle.** No changes to strategy selection, `appliesTo` semantics, or the `FixCycle` lifecycle beyond the one exit-reason fix.
- **Not changing the verifier prompt schema, parse-retry, or in-session retry.** PR #1138 already covers those.
- **Not removing the post-rectification-resume block.** It does real work; C only ensures it receives an honest signal.
- **Not promoting failed acceptance criteria from advisory to blocking.** `categorizeVerdict` (`src/tdd/verdict.ts:96-130`) and the verdict prompt (`src/prompts/sections/verdict.ts:40`) explicitly treat failed ACs as advisory in the TDD verifier verdict — semantic review owns AC-level correctness. This spec **respects** that decision: findings are only emitted when `categorization.success === false`.

## Relevant Code

- `src/operations/verify.ts` — `VerifierOutput`, `parseVerdictFromStdout`, `verifierOp`.
- `src/tdd/verdict.ts` — `VerifierVerdict` (`:17-71`), `categorizeVerdict` (`:96-130`), `isValidVerdict`, `coerceVerdict`.
- `src/findings/types.ts` — `Finding` interface (`:89-180`), `FindingSource` union (`:27-38`), `FindingSeverity` (`:51`).
- `src/findings/cycle-types.ts` — `FixCycle.validate` contract (`:184`), `FixCycleExitReason` (`:57-64`), `FixCycleResult` (`:66-78`).
- `src/findings/cycle.ts` — `runFixCycle`, terminal lite-validate branch (`:298-365`), per-iteration full validate (`:387-389`).
- `src/execution/story-orchestrator.ts` — `extractPhaseFindings` (`:393-410`), `gatherRectificationFindings` (`:429-440`), `EXHAUSTED_EXIT_REASONS` (`:52-58`), `RectificationResult` (`:828-831`), `runRectification` + validate callback (`:833-957`), resume guard (`:1042`), resume block (`:1052-1108`).
- `src/operations/_finding-to-check.ts` — `SOURCE_TO_CHECK` mapping (`:11-16`), `findingsToFailedChecks` (`:26-45`).
- `src/operations/autofix-implementer-strategy.ts` — `IMPLEMENTER_SOURCES` (`:11`).
- `src/operations/autofix-test-writer-strategy.ts` — `appliesTo` reads `fixTarget === "test"` (`:18`) — already covers verifier test-target findings, **no change needed**.
- `src/review/types.ts` — `ReviewCheckName` union (`:10`).
- `src/prompts/builders/rectifier-builder.ts` — `RectifierPromptBuilder.failingTestContext` (`:857`).
- Other production `FixCycle.validate` callers (not changed by this spec):
  - `src/execution/lifecycle/acceptance-loop.ts:297`
  - `src/execution/lifecycle/run-regression.ts:345`

## Design

### Part A — Verifier emits findings tied to categorized rejection reasons

#### A1. Extend `VerifierOutput`

```typescript
// src/operations/verify.ts
export interface VerifierOutput {
  readonly success: boolean;
  readonly filesChanged: readonly string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
  readonly output: string;
  readonly isolation?: IsolationCheck;
  readonly failureCategory?: FailureCategory;
  readonly reviewReason?: string;
  /** Structured findings emitted only when categorizeVerdict returned success=false. */
  readonly normalizedFindings: readonly Finding[];
}
```

`normalizedFindings` is **always** present (never `undefined`) — `[]` on success, populated only on categorized rejection. This avoids the `extractPhaseFindings` ambiguity between "no findings" and "field missing".

#### A2. Build findings from the categorized verdict, not from raw verdict fields

In `parseVerdictFromStdout`, after `categorizeVerdict`, derive findings **only when `categorization.success === false`**. The category of finding maps directly from `categorization.failureCategory`:

```typescript
function buildVerifierFindings(
  verdict: VerifierVerdict,
  categorization: VerdictCategorization,
): Finding[] {
  if (categorization.success) return [];

  switch (categorization.failureCategory) {
    case "verifier-rejected": {
      // Illegitimate test modifications — verdict.testModifications.* is the source of truth.
      const files = verdict.testModifications.files;
      return [{
        source: "tdd-verifier",
        severity: "error",
        category: "illegitimate-test-edits",
        fixTarget: "test",
        message: files.length > 0
          ? `Implementer edited test files illegitimately: ${files.join(", ")}`
          : "Implementer made illegitimate test modifications",
        meta: {
          reasoning: verdict.testModifications.reasoning,
          files,
        },
      }];
    }
    case "tests-failing": {
      // One rollup finding per verdict (the verifier does not enumerate test names).
      return [{
        source: "tdd-verifier",
        severity: "error",
        category: "tests-failed",
        fixTarget: "source",
        message: `${verdict.tests.failCount} story-scoped test(s) failed (verifier)`,
        meta: {
          passCount: verdict.tests.passCount,
          failCount: verdict.tests.failCount,
          reasoning: verdict.reasoning,
        },
      }];
    }
    default:
      // Defensive: no other failureCategory exists today. Return [] so we never
      // emit findings the rest of the system isn't prepared for.
      return [];
  }
}
```

**Field choices (per `src/findings/types.ts`):**
- `source: "tdd-verifier"` — reuses the **already-declared** `FindingSource` value (`src/findings/types.ts:37`). No new union member.
- `severity: "error"` — required by `Finding` interface; "error" matches the existing `blockingThreshold` semantics.
- `category` — free-form per source convention; this spec defines `"tests-failed"` and `"illegitimate-test-edits"` for `tdd-verifier`.
- `fixTarget` — `"source"` for `tests-failed` (impl needs to change), `"test"` for `illegitimate-test-edits` (test code needs to be reverted/corrected).
- `meta` — read-only diagnostic carrier per the `Finding.meta` convention (`src/findings/types.ts:163-180`).

**No `reason` or `storyId` fields** — neither exists on `Finding`. Reason text goes in `meta.reasoning`; storyId is implicit in `FixCycleContext` and never per-finding.

**No `ac-failed` category.** Failed acceptance criteria alone do not produce findings — `categorizeVerdict` treats AC-only rejections as advisory (`src/tdd/verdict.ts:91`, `verdict.ts:129`). Emitting findings here would invert that design.

#### A3. Map `"tdd-verifier"` into `SOURCE_TO_CHECK` so `findingsToFailedChecks` doesn't drop them

`SOURCE_TO_CHECK` (`src/operations/_finding-to-check.ts:11-16`) gates which finding sources reach the rectifier prompt. Without an entry, `findingsToFailedChecks` silently drops the finding at line 30. Add:

```typescript
const SOURCE_TO_CHECK: Record<string, ReviewCheckName> = {
  "semantic-review": "semantic",
  "adversarial-review": "adversarial",
  lint: "lint",
  typecheck: "typecheck",
  "tdd-verifier": "test",  // NEW — reuses existing ReviewCheckName "test"
};
```

`ReviewCheckName` (`src/review/types.ts:10`) already includes `"test"`. Reusing it avoids touching the review type system. The prompt builder receives a `ReviewCheckResult` with `check: "test"` populated by verifier findings — semantically appropriate ("the test suite is unhappy").

#### A4. Widen `IMPLEMENTER_SOURCES`

`src/operations/autofix-implementer-strategy.ts:11`:

```typescript
const IMPLEMENTER_SOURCES = new Set(["lint", "typecheck", "semantic-review", "tdd-verifier"]);
```

Verifier findings tagged `fixTarget: "source"` (category `tests-failed`) flow to `autofix-implementer` via this widening. Verifier findings tagged `fixTarget: "test"` (category `illegitimate-test-edits`) already flow to `autofix-test-writer` — its `appliesTo` predicate at `src/operations/autofix-test-writer-strategy.ts:18` reads `f.fixTarget === "test"` and routes them without modification.

#### A5. Prompt builder support

Verifier findings have `meta` payload but no `file` / `rule` fields the existing `RectifierPromptBuilder.failingTestContext` (`:857`) reads. Add a static method `RectifierPromptBuilder.verifierContext(findings: Finding[]): string` that renders verifier findings using `meta.reasoning` + `message`. Export from the `src/prompts` barrel (mandatory per `.claude/rules/forbidden-patterns.md` Prompt Builder Convention). The autofix-implementer rectifier prompt assembler calls `verifierContext` when any finding in its batch has `source === "tdd-verifier"`.

### Part C — Cycle exit honesty + resume guard

#### C1. Backwards-compatible `validate` callback return type

Two of the three production `FixCycle.validate` implementations (`acceptance-loop.ts:297`, `run-regression.ts:345`) do not need to change. Use a union return type so they keep working:

```typescript
// src/findings/cycle-types.ts
export interface ValidateResult<F extends Finding> {
  readonly findings: readonly F[];
  /** True if validate broke out of its phase loop because a phase failed and produced no findings. */
  readonly shortCircuited?: boolean;
}

export interface FixCycle<F extends Finding> {
  // ...
  validate: (
    ctx: FixCycleContext,
    opts: { mode: "full" | "lite"; strategiesRun?: readonly string[] },
  ) => Promise<F[] | ValidateResult<F>>;
}
```

Add a normalizer used at every `await cycle.validate(...)` call site:

```typescript
// src/findings/cycle.ts (top of file, near _cycleDeps)
function normalizeValidateResult<F extends Finding>(
  r: F[] | ValidateResult<F>,
): ValidateResult<F> {
  return Array.isArray(r) ? { findings: r, shortCircuited: false } : r;
}
```

#### C2. Update the rectification validate callback to report short-circuit

In `runRectification`'s validate (`src/execution/story-orchestrator.ts:876-910`), return a `ValidateResult`:

```typescript
validate: async (_validateCtx, opts) => {
  // ... existing setup ...
  const findings: Finding[] = [];
  let shortCircuited = false;
  for (const phase of phases) {
    if (lite && phase.kind === "full-suite-gate") continue;
    await runPhase(ctx, phase.slot, phaseCosts, phaseOutputs);
    if (shouldSkipPhaseForRectification(phase, state, phaseOutputs)) continue;
    const output = phaseOutputs[phase.slot.op.name];
    findings.push(...extractPhaseFindings(output));
    if (!phasePassed(phase.slot.op.name, output, ctx.storyId)) {
      getSafeLogger()?.warn("story-orchestrator", "Short-circuiting revalidation on phase failure", {
        storyId: ctx.storyId,
        phase: phase.slot.op.name,
      });
      shortCircuited = true;
      break;
    }
  }
  const out = rectification.postValidate
    ? await rectification.postValidate(findings, _validateCtx)
    : findings;
  return { findings: out, shortCircuited };
},
```

#### C3. `runFixCycle` honours the short-circuit flag at the terminal branch

In `src/findings/cycle.ts:298-365`, replace the raw await with the normalizer and gate the `"resolved"` exit on `shortCircuited === false`:

```typescript
const liteRaw = await cycle.validate(ctx, { mode: "lite", strategiesRun: group.map(s => s.name) });
const liteResult = normalizeValidateResult(liteRaw);
const liteFindingsAfter = [...liteResult.findings];
cycle.findings = liteFindingsAfter;

// "resolved" requires BOTH empty findings AND a clean (non-short-circuited) sweep.
if (liteFindingsAfter.length === 0 && !liteResult.shortCircuited) {
  // existing "resolved" return path
}

if (liteResult.shortCircuited) {
  logger?.info("findings.cycle", "cycle exited — validate short-circuited", {
    storyId,
    packageDir,
    cycleName,
    reason: "validate-short-circuit",
    liteFindingsAfterCount: liteFindingsAfter.length,
  });
  return {
    iterations: cycle.iterations,
    finalFindings: liteFindingsAfter,
    exitReason: "validate-short-circuit",
    costUsd: totalCostUsd,
  };
}

// existing "strategy attempt cap reached" return path
```

The per-iteration full validate site (`cycle.ts:389`) is also normalized — non-terminal short-circuits update `cycle.findings` the same way they do today and continue to the next iteration; the flag is consumed only at terminal exit.

#### C4. Add `"validate-short-circuit"` to `FixCycleExitReason`

```typescript
// src/findings/cycle-types.ts:57
export type FixCycleExitReason =
  | "resolved"
  | "no-strategy"
  | "max-attempts-total"
  | "max-attempts-per-strategy"
  | "validator-error"
  | "bail-when"
  | "agent-gave-up"
  | "validate-short-circuit";  // NEW
```

#### C5. Extend `RectificationResult` and `runRectification`'s exit logic

```typescript
// src/execution/story-orchestrator.ts:828
interface RectificationResult {
  rectificationExhausted?: boolean;
  unfixedFindings?: readonly Finding[];
  /** Validate short-circuited with an empty findings list — resume must still run scope-backfill. */
  liteScopeIncomplete?: boolean;
}
```

Add `"validate-short-circuit"` to `EXHAUSTED_EXIT_REASONS` (`:52-58`) so it counts as exhausted **when findings are non-empty** (post-A, this is the common case). When findings are empty, set `liteScopeIncomplete`:

```typescript
// src/execution/story-orchestrator.ts:953
if (EXHAUSTED_EXIT_REASONS.has(cycleResult.exitReason) && cycleResult.finalFindings.length > 0) {
  return { rectificationExhausted: true, unfixedFindings: cycleResult.finalFindings };
}
if (cycleResult.exitReason === "validate-short-circuit") {
  // Empty findings — surface the lite-scope-backfill flag so resume can still run.
  return { liteScopeIncomplete: true };
}
return {};
```

#### C6. Resume guard distinguishes "give up" from "lite scope incomplete"

```typescript
// src/execution/story-orchestrator.ts:1042
const canEnterResume =
  this.state.rectification &&
  (!rectResult.rectificationExhausted || rectResult.liteScopeIncomplete);
if (canEnterResume) {
  // existing resume block unchanged
}
```

Once A is in play, verifier short-circuits in lite-validate carry non-empty findings → `rectificationExhausted = true` → resume **skipped** (correct: the cycle already judged the work exhausted). `liteScopeIncomplete` is the narrow escape hatch for "validate broke before reaching all phases AND the failing phase had no findings" — should be rare after A.

### Interaction summary

| Scenario | Today | After A + C |
|---|---|---|
| **Tier 1** (gate silent, verifier fails on failing tests) | gathered findings = 0 → rectification no-op → resume re-runs verifier on unchanged code → escalate (2 verifier closes) | verifier emits `tests-failed` finding → `autofix-implementer` iterates → either fixes (no escalation) or exhausts with findings → resume skipped → escalate (**1 verifier close**) |
| **Tier 2** (gate finds bugs, lite-validate verifier fails) | cycle exits "resolved" falsely → resume re-runs gate → triggers second rectification → fix → close #4 passes | cycle exits `"validate-short-circuit"`; verifier findings non-empty → `rectificationExhausted = true` → resume **skipped** → escalate / story-failed (one less verifier close per tier, at the cost of losing the lucky tier-2 recovery — see Risks) |
| **Future op fails validate with no findings** | false-resolved exit hides the failure | `liteScopeIncomplete` flag fires → resume runs scope-backfill phases honestly |

## Stories

### US-001 — Verifier emits findings tied to categorized rejection

**Scope:** `src/operations/verify.ts`, `src/operations/_finding-to-check.ts`, `src/operations/autofix-implementer-strategy.ts`.

[verbatim] [unit] AC1: Given a `VerifierVerdict` where `categorizeVerdict(verdict, ...).success === false` and `categorizeVerdict(verdict, ...).failureCategory === "tests-failing"`, when `parseVerdictFromStdout` returns its `VerifierOutput`, then `output.normalizedFindings` is a non-empty `Finding[]` and each entry has `source === "tdd-verifier"`, `severity === "error"`, `category === "tests-failed"`, `fixTarget === "source"`, and a non-empty `message`.

[verbatim] [unit] AC2: Given a `VerifierVerdict` where `categorizeVerdict(verdict, ...).success === true` (including verdicts rejected for advisory `acceptanceCriteria` / `quality` reasons only), when `parseVerdictFromStdout` returns its `VerifierOutput`, then `output.normalizedFindings.length === 0`.

[verbatim] [unit] AC3: Given a `VerifierVerdict` where `categorizeVerdict(verdict, ...).failureCategory === "verifier-rejected"` (illegitimate test modifications), when `parseVerdictFromStdout` returns its `VerifierOutput`, then `output.normalizedFindings` contains exactly one entry with `source === "tdd-verifier"`, `severity === "error"`, `category === "illegitimate-test-edits"`, and `fixTarget === "test"`.

[verbatim] [file] AC4: `src/operations/autofix-implementer-strategy.ts` contains exactly one line matching the regex `^const IMPLEMENTER_SOURCES = new Set\(\["lint", "typecheck", "semantic-review", "tdd-verifier"\]\);$`.

[verbatim] [file] AC5: `src/operations/_finding-to-check.ts` contains exactly one line matching the regex `^\s*"tdd-verifier": "test",\s*$` inside the `SOURCE_TO_CHECK` object literal.

[verbatim] [unit] AC6: Given `phaseOutputs["verifier"]` set to a `VerifierOutput` whose `normalizedFindings` is `[F1, F2]`, when `extractPhaseFindings(phaseOutputs["verifier"])` is called, then it returns an array containing `F1` and `F2`.

[verbatim] [file] AC7: `src/prompts/index.ts` exports the symbol `RectifierPromptBuilder`, and `src/prompts/builders/rectifier-builder.ts` contains exactly one `static verifierContext(` method definition on the `RectifierPromptBuilder` class.

[verbatim] [file] AC8: `src/prompts/sections/verdict.ts` is byte-identical to its state at SHA `52634c0b` (this PR does not modify the verifier prompt schema; PR #1138 owns that surface).

### US-002 — Cycle exit honesty

**Scope:** `src/findings/cycle-types.ts`, `src/findings/cycle.ts`, `src/execution/story-orchestrator.ts` (validate callback only).

[verbatim] [file] AC9: `src/findings/cycle-types.ts` contains exactly one line matching the regex `^\s*\|\s*"validate-short-circuit"\s*$` inside the `FixCycleExitReason` union.

[verbatim] [file] AC10: `src/findings/cycle-types.ts` contains a `ValidateResult` interface declaration with exactly two members named `findings` (typed `readonly F[]`) and `shortCircuited` (typed `readonly boolean` and optional via `?:`).

[verbatim] [unit] AC11: Given a `FixCycle.validate` callback that returns `{ findings: [], shortCircuited: true }` from the terminal lite-validate, when `runFixCycle` exits, then the returned `FixCycleResult.exitReason === "validate-short-circuit"` (NOT `"resolved"`) and `finalFindings.length === 0`.

[verbatim] [unit] AC12: Given a `FixCycle` whose strategies are all at their per-strategy attempt cap AND whose terminal lite-validate callback returns `{ findings: [], shortCircuited: false }`, when `runFixCycle` exits, then the returned `FixCycleResult.exitReason === "resolved"` (the terminal-branch path, not the loop-top early exit at `cycle.ts:158-160`).

[verbatim] [unit] AC13: Given a `FixCycle.validate` callback that returns a bare `Finding[]` (legacy shape) from the terminal lite-validate, when `runFixCycle` exits, then the returned `FixCycleResult.exitReason === "resolved"` if the array is empty, mirroring pre-change behaviour (backwards compatibility with `acceptance-loop.ts:297` and `run-regression.ts:345`).

### US-003 — Resume guard + integration

**Scope:** `src/execution/story-orchestrator.ts` (`EXHAUSTED_EXIT_REASONS`, `RectificationResult`, runRectification exit logic, resume guard).

[verbatim] [file] AC14: `src/execution/story-orchestrator.ts` contains exactly one line matching the regex `^\s*"validate-short-circuit",\s*$` inside the `EXHAUSTED_EXIT_REASONS` set literal.

[verbatim] [file] AC15: `src/execution/story-orchestrator.ts` contains the field declaration `liteScopeIncomplete\?: boolean;` inside the `RectificationResult` interface.

[verbatim] [unit] AC16: Given `runRectification` consuming a `FixCycleResult` with `exitReason === "validate-short-circuit"` and `finalFindings.length === 0`, when it returns, then the returned `RectificationResult` has `liteScopeIncomplete === true` and `rectificationExhausted` is `undefined`.

[verbatim] [unit] AC17: Given `runRectification` consuming a `FixCycleResult` with `exitReason === "validate-short-circuit"` and `finalFindings.length > 0`, when it returns, then the returned `RectificationResult` has `rectificationExhausted === true`, `unfixedFindings === cycleResult.finalFindings`, and `liteScopeIncomplete` is `undefined`.

[verbatim] [unit] AC18: Given `ExecutionPlan.run` with a `rectResult` of `{ rectificationExhausted: true }` (no `liteScopeIncomplete`), when control reaches the resume guard, then the post-rectification-resume block is NOT entered (no further `runPhase` calls beyond `runRectification`).

[verbatim] [unit] AC19: Given `ExecutionPlan.run` with a `rectResult` of `{ liteScopeIncomplete: true }`, when control reaches the resume guard, then the post-rectification-resume block IS entered.

[verbatim] [integration] AC20: Given a mocked story run where verifier returns `VerifierOutput { success: false, normalizedFindings: [F_tests_failed] }` and `autofix-implementer` resolves the finding on its first attempt, when `ExecutionPlan.run` completes, then (a) the verifier op was dispatched exactly **once** before story success, AND (b) the rectifier prompt assembled for the autofix-implementer dispatch contains the verifier-context section produced by `RectifierPromptBuilder.verifierContext` (asserting the new builder method is actually invoked end-to-end, not merely defined).

[verbatim] [integration] AC21: Given a mocked story run replicating the tier-2 lite-scope-incomplete path (verifier short-circuits validate with `normalizedFindings: []`, full-suite-gate is in the canonical phase list but absent from `phaseOutputs`), when `ExecutionPlan.run` completes, then `runRectification` returns `liteScopeIncomplete: true` and the resume block dispatches the full-suite-gate phase.

## Test Plan

### Unit tests (one file per story)

- `test/unit/operations/verify-op-findings.test.ts` (new) — AC1, AC2, AC3, AC6.
- `test/unit/operations/finding-to-check.test.ts` (extend) — AC5 routing assertion via `findingsToFailedChecks`.
- `test/unit/findings/cycle-short-circuit.test.ts` (new) — AC11, AC12, AC13.
- `test/unit/execution/run-rectification-exit.test.ts` (new) — AC16, AC17.
- `test/unit/execution/post-rectification-resume.test.ts` (extend) — AC18, AC19.

### Integration tests

- `test/integration/execution/verifier-findings-flow.test.ts` (new) — drives `ExecutionPlan.run` with mocked phase ops:
  - **AC20 scenario:** verifier rejects with `tests-failed` finding → autofix-implementer succeeds → exactly one verifier dispatch AND the rectifier prompt contains the `verifierContext` section.
  - **AC21 scenario:** verifier short-circuits lite-validate with empty findings → resume runs full-suite-gate.

### File-shape assertions

AC4, AC5, AC7, AC8, AC9, AC10, AC14, AC15 are mechanical file/content assertions and can run as a `bun test test/unit/spec-conformance/verifier-findings-shapes.test.ts` using `Bun.file().text()` + regex.

### Regression replay

Re-run the `screener-ui-async-jobs-test` US-002 scenario (or a stripped fixture) and confirm the verifier-close count drops from 4 to 2 (one per tier).

## Verification

- `bun run typecheck`
- `bun run lint`
- `timeout 60 bun test test/unit/operations/ test/unit/findings/ test/unit/execution/ --timeout=10000`
- `timeout 120 bun test test/integration/execution/verifier-findings-flow.test.ts --timeout=30000`
- `bun run test` (full suite, final gate)

All new `logger.*` call sites added by this change preserve `storyId` as the first key of the data object per `.claude/rules/project-conventions.md`.

## Rollout

Single PR. No feature flag — behaviour change is internal to the rectification cycle and verifier op. Existing tests asserting `exitReason === "resolved"` on short-circuit scenarios are updated in the same PR (AC13 explicitly covers the legacy `F[]` return-shape path so external `FixCycle` consumers are not broken).

## Risks

- **Lost tier-2 lucky recovery.** Today's `screener-ui-async-jobs-test` US-002 succeeded on tier 2 because the cycle's false "resolved" exit accidentally triggered the resume block, which discovered and rectified the `universe_cap` regression. After this change, that path requires `liteScopeIncomplete = true`, which is only set when findings are empty. With A live, verifier short-circuits carry findings, so `rectificationExhausted` becomes true and the resume is skipped — losing the recovery. **Mitigation:** the same regression would now drive `autofix-implementer` via the verifier's `tests-failed` finding. Validate the regression replay shows tier 2 still passes via the new path, not the old one. If it doesn't, treat as a blocker before merging.
- **Strategy mis-routing.** `tests-failed` findings are rendered through `findingsToFailedChecks` → `ReviewCheckName "test"` → `RectifierPromptBuilder.verifierContext`. If the rectifier prompt can't act on a verifier-level test-suite signal (no specific test names; only counts and reasoning text), `autofix-implementer` may burn its `maxAttemptsPerStrategy` without progress. **Mitigation:** capped by existing `maxAttemptsPerStrategy`; the prompt builder should be tested against the actual verifier output shape from the US-002 audit.
- **Plugin-supplied `FixCycle.validate` regressions.** External consumers returning bare `F[]` (legacy shape) must continue to work via `normalizeValidateResult`. AC13 pins this; review the plugin SDK exports to confirm no consumer relies on the return type being literal `F[]`.
- **`coerceVerdict` interaction.** Finding extraction runs against the verdict produced by `isValidVerdict(raw) ? raw : coerceVerdict(raw)` (`src/operations/verify.ts:53`). Coerced verdicts may have synthesised defaults; the extractor must never throw on missing optional fields. AC1–AC3 should include cases driven by `coerceVerdict` output specifically.
