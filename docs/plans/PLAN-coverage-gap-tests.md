# PLAN — Author Real Tests for Phase 8 Coverage Gaps

**Author:** William
**Date:** 2026-06-02
**Status:** Ready to execute — hand-off to Sonnet
**Base branch:** `phase-8-test-trim` (Phase 8 deletions applied; the empty stubs are already gone)
**Predecessor:** `PLAN-test-suite-trim.phase-8-results.md` → "A2 Coverage-Gap List"

---

## Why this plan (and why NOT nax acceptance-fix)

Phase 8 deleted 29 AC-labeled stubs whose bodies were `expect(true).toBe(true)` —
green tests that asserted nothing while their names promised real behavior. The
behavior **already exists in `src/`**; only the tests are missing.

nax's acceptance-fix loop is the wrong tool here: it drives test → implementation,
and would try to *mutate `src/`* to satisfy new tests. We don't want src changes — we
want tests written against the **already-correct** existing behavior. So this is
straight test authoring against a frozen `src/`, handed to Sonnet.

### THE GOLDEN CONSTRAINT — `src/` IS FROZEN

- **Do NOT modify any file under `src/`.** Not one line.
- If a test you write FAILS against current `src/`, you have found one of two things:
  1. a genuine bug in `src/`, or
  2. a wrong assumption in your test.
- In either case: **STOP. Do not fix `src/`. Do not bend the test to pass.** Revert
  the test, record the AC + the failure + your hypothesis in the results doc under
  "Surfaced behavior discrepancies", and move to the next AC. A human decides.
- A test that only passes because you weakened it to a tautology is exactly the
  disease Phase 8 cured. Do not reintroduce it.

---

## Grounding (already verified — symbols exist in `src/`)

| Symbol / target | Location | Used by ACs |
|:---|:---|:---|
| `executeUnified` | `src/execution/unified-executor.ts:47` | exec AC-18/19/20/21/22/32, results AC-1..5 |
| `runParallelBatch` | `src/execution/parallel-batch.ts` | exec AC-19/20/21 |
| `runIteration` | `src/execution/iteration-runner.ts` | exec AC-20/21 |
| `handlePipelineFailure` | `src/execution/pipeline-result-handler.ts` | exec AC-23 |
| `handleTierEscalation` | `src/execution/escalation/tier-escalation.ts` | exec AC-23 |
| `rectifyConflictedStory` | `src/execution/merge-conflict-rectify.ts` | rectification AC-7 |
| `RectificationResult`, `RectifyConflictedStoryOptions` | `src/execution/merge-conflict-rectify.ts` | rectification AC-8 |
| `parallel-executor*.ts` (absent) | — confirmed absent | exec AC-26, rect AC-9/10 |

**Before writing each behavioral test, re-grep the exact current signature** of the
function under test (params, return type, options-object shape). Do NOT trust the
stub's test name for the API — it predates the current code. Assert against what the
function actually returns today.

---

## Work tiers (do in order; commit per AC-cluster)

### Tier 0 — DROP these (not real test targets)

| AC | Reason to drop |
|:---|:---|
| exec AC-33 (`runner-parallel-metrics invokes executeUnified directly and tests pass`) | Meta-assertion about another test file, not a behavior. If `runner-parallel-metrics.test.ts` exists and passes, that IS the coverage — nothing to add. |
| exec AC-34 (`full suite exits 0 with no failures`) | Tautological — the suite gate already asserts this globally. |

Log both as "dropped — not a behavioral target" in results. Do not write them.

### Tier 1 — Structural / type-export assertions (trivial, do first, ~5 ACs)

Fast, low-risk, high-confidence. Place in a single focused unit test file
(e.g. `test/unit/execution/parallel-batch-structure.test.ts`).

| AC | Assertion |
|:---|:---|
| exec AC-26 | `src/execution/parallel-executor.ts` does not exist (use `Bun.file(...).exists()` → false) AND no `src/**` file imports `parallel-executor`. |
| rect AC-9 | No `src/**` file imports from `parallel-executor-rectify`. |
| rect AC-10 | No `src/**` file imports from `parallel-executor-rectification-pass`. |
| rect AC-8a | `RectificationResult` is exported from `merge-conflict-rectify` (type-level: a typed `const x: RectificationResult = {...}` compiles, or import + runtime shape check). |
| rect AC-8b | `RectifyConflictedStoryOptions` is exported (same approach). |

For the "no importer" checks: use `Bun.Glob` over `src/**/*.ts` with an explicit `cwd`
(per monorepo-awareness.md rule 6) and assert no match contains the import string.
Type-export checks: a compile-time `import type` + a `satisfies`/typed-literal is the
cleanest "it's exported with this shape" assertion.

### Tier 2 — Behavioral: executor dispatch + events + results (the real value, ~16 ACs)

These need `executeUnified` exercised with **injected `_deps`** (the project DI
pattern — NEVER `mock.module`). Read `unified-executor.ts` to find its `_deps` seam
and what it injects (`runParallelBatch`, `runIteration`, event emitter, cost source).
Suggested files (split if any exceeds ~400 lines):

`test/unit/execution/unified-executor-dispatch.test.ts`:
| AC | Behavior to assert |
|:---|:---|
| exec AC-19 | `parallelCount > 0` AND batch size > 1 → `runParallelBatch` called; single-story batch → not called. |
| exec AC-20 | batch size 1 even with `parallelCount > 0` → `runIteration` called. |
| exec AC-21 | `parallelCount` undefined/0/unset → always `runIteration`. |
| exec AC-18 | `executeUnified` return value matches the shape former `executeSequential` produced (assert the result type's keys — verify against current return type). |

`test/unit/execution/unified-executor-events.test.ts`:
| AC | Behavior |
|:---|:---|
| exec AC-22 / AC-32 | `story:started` fires once per batch story with the correct `storyId`, before batch execution. (AC-22 and AC-32 overlap — write ONE test, note the merge.) |

`test/unit/execution/unified-executor-failure.test.ts`:
| AC | Behavior |
|:---|:---|
| exec AC-23 | failed story routed through `handlePipelineFailure`; an `escalate` action reaches `handleTierEscalation`. (Inject spies for both.) |
| exec AC-24 | cost-limit check runs after batch; execution exits when `totalCost` exceeds the configured limit. |

`test/unit/execution/unified-executor-results.test.ts` (parallel-batch-results ACs):
| AC | Behavior |
|:---|:---|
| results AC-1 | completed stories: result shows passed pipeline + merged to base branch. |
| results AC-2 | failed stories: result includes `pipelineResult` for downstream handling. |
| results AC-3 | merge conflicts: result tracks whether rectification succeeded. |
| results AC-4 | per-story `cost` matches the corresponding worker result. |
| results AC-5 | `totalCost` sums all branches (completed + failed + conflicts). |
| exec AC-29 | per-story `cost === storyCosts.get(story.id)` — NOT divided equally across the batch. |
| exec AC-30 | `durationMs` is per-story elapsed; two stories in one batch may differ. |
| exec AC-31 | rectification result has `source='rectification'` and `rectificationCost` reflects only the rectification phase. |

`test/unit/execution/merge-conflict-rectify.test.ts` (extend if exists, else create):
| AC | Behavior |
|:---|:---|
| rect AC-7 | an error thrown by `rectifyConflictedStory`'s inner work is caught and logged (assert via injected logger spy), not propagated. |

### Tier 3 — strategy-vs-op parity (VERIFY-FIRST; may be obsolete, ~8 ACs)

The deleted file compared an old "strategy" verify path against the new "op" path
(`verifyScopedOp` / `fullSuiteGateOp`). After the ADR strategy→op migration, the
**strategy side may no longer exist** — in which case a parity test has nothing to
compare and is obsolete.

**Procedure:**
1. Grep for a surviving non-op "strategy" implementation of scoped + full-suite verify.
2. **If the strategy path is gone:** mark all 8 parity ACs "obsolete — strategy path
   removed in op migration; parity no longer meaningful." Do NOT write them. This is a
   valid, expected outcome — log it and stop Tier 3.
3. **If both paths still exist:** write parity tests asserting both produce equal
   `{ passCount, isFullSuite, scopeTestFallback }` (scoped) / equal pass/skip/timeout
   outcomes (full-suite) for the 8 listed scenarios. Place in
   `test/integration/verification/strategy-vs-op-parity.test.ts` (recreate the file).

---

## Testing rules (mandatory — from `.claude/rules/`)

- **DI only:** mock via injected `_deps`, never `mock.module()` (leaks globally in Bun).
- **Bun-native:** `Bun.file()`, `Bun.write()`, `Bun.spawn()`; no Node `fs`/`child_process`.
- **Run via timeout wrapper:** `timeout 30 bun test <file> --timeout=5000`. NEVER bare
  `bun test` (PreToolUse hook blocks it).
- **Placement:** unit → `test/unit/execution/...` mirroring `src/`. Only Tier 3 parity
  (if written) goes in `test/integration/`.
- **File size:** ≤ 600 lines (hard ≤ 800). Split a Tier-2 file if it grows past ~400.
- **No standalone `*-bugNNN` files;** add to the focused files named above.
- **Descriptive test names** — keep the AC id in the name so traceability survives
  (e.g. `test("AC-19: dispatches to runParallelBatch when parallelCount > 1", ...)`).
- **Each test must assert real behavior** — a test with only `expect(true).toBe(true)`
  or no assertion fails review automatically.

---

## Per-cluster procedure

1. Re-grep the current signature/return type of the function under test.
2. Write the test(s) for the cluster with real `_deps` spies and real assertions.
3. `bun run typecheck && timeout 30 bun test <file> --timeout=5000`.
4. Green → commit: `test(execution): cover <cluster> (AC-NN..NN)`.
5. Red → is it a test bug or a src bug?
   - Test bug → fix the test (NOT src), re-run.
   - Looks like a src bug → revert test, log under "Surfaced discrepancies", move on.
6. For each test file touched, also run `bun x biome check <file>` (biome lint does NOT
   cover `test/`, so unused imports won't otherwise be caught).

---

## Verification (phase boundary)

```
bun run typecheck
bun run lint
bun run test:bail        # full suite green
```

Count check: tests should rise from 8,074 toward ~8,074 + (number of ACs implemented).

---

## Deliverable

`docs/plans/PLAN-coverage-gap-tests.results.md`:
- ACs implemented (with new test file + test name), per tier.
- ACs dropped (Tier 0) and obsolete (Tier 3 if strategy path gone) — with reason.
- **"Surfaced discrepancies"** — any AC whose honest test failed against `src/`, with
  the failure and your hypothesis. THIS IS THE HIGH-VALUE OUTPUT if it happens: it
  means a real behavior was never actually verified and may be broken.
- Before/after test count; lint + suite status.

---

## Hand-off note for Sonnet

- Branch from `phase-8-test-trim`: `git checkout phase-8-test-trim && git checkout -b phase-9-gap-tests`.
- `src/` is frozen — repeat that to yourself before every commit.
- Tiers in order: Tier 0 (drop) → Tier 1 (trivial) → Tier 2 (the real work) → Tier 3
  (verify-first, likely obsolete).
- Re-grep every API before asserting it; the stub names are stale hints, not contracts.
- When a test won't pass honestly, the answer is to LOG it, never to weaken it or touch `src/`.
- Do NOT open a PR. Leave the branch + commits + results doc for human review.
