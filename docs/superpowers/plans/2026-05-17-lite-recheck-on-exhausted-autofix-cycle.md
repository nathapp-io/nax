# Lite Recheck on Exhausted Autofix Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #1030 — when the autofix V2 cycle exhausts strategy attempts, run a "lite" validate (lint + typecheck + tests only, no LLM reviewers) so that a silently-successful final fix is detected as `resolved` instead of being escalated needlessly, and so the escalation digest reflects the true post-fix state.

**Architecture:** `FixCycle.validate` gains a second argument `opts: { mode: "full" | "lite" }`. The autofix-cycle's `validate` closure forwards `mode` to `recheckReview(ctx, { lite })`. In lite mode, `recheckReview` (a) augments `ctx.retrySkipChecks` with `"adversarial"`/`"semantic"` so the review runner skips them, (b) sets `ctx.skipLLMReviewers = true` so the dialogue early-return branches in `reviewStage.execute` (which bypass the runner entirely and would otherwise still issue LLM calls) fall through to the orchestrator path, and (c) bypasses the `failOpen` check (vacuous without LLM reviewers). The `allExhausted` branch in `runFixCycle` is replaced: instead of returning early with stale findings, it runs `cycle.validate(ctx, { mode: "lite" })` and classifies the outcome — `resolved` short-circuits to `exit:"resolved"`, anything else exits `max-attempts-per-strategy` with fresh `findingsAfter`. The acceptance-loop cycle ignores `mode` (its validate is mechanical-only already).

**File-size discipline:** `src/pipeline/stages/autofix-cycle.ts` is currently at the 600-line hard limit declared in `.claude/rules/project-conventions.md`. The plan is structured so the changes to that file are line-neutral (Task 3 keeps a single-line signature; Task 10 collapses the lite-forwarding into a single-line comment + inline opts). Do not let it grow past 600 — if you find yourself adding net lines, compress an existing comment instead.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Biome.

**Background reading before starting:**
- Issue spec: `gh issue view 1030`
- Cycle types: `src/findings/cycle-types.ts`
- Cycle runner: `src/findings/cycle.ts` (the `allExhausted` block at lines 297–326)
- Autofix V2 cycle: `src/pipeline/stages/autofix-cycle.ts` (the `validate` closure at lines 530–565)
- Recheck helper: `src/pipeline/stages/autofix.ts` (lines 273–286)
- Review runner that consumes `ctx.retrySkipChecks`: `src/review/runner.ts:326`
- Tests we'll edit: `test/unit/findings/cycle.test.ts` (lines 308–357)
- Project rules: `.claude/rules/project-conventions.md`, `.claude/rules/testing-commands.md`, `.claude/rules/forbidden-patterns.md`

**Conventions reminder:**
- Bun-native APIs only. No Node `fs`/`child_process`/`setTimeout`-for-delay.
- All logger calls inside pipeline stages must include `storyId` as the **first** key in the data object.
- Test commands: never bare `bun test …`. Use `timeout 30 bun test <path> --timeout=5000` (hook blocks bare `bun test`). Full suite is `bun run test`.
- Conventional commits, atomic, one logical change per commit. Never include `[run-release]`.

---

## File Structure

| File | Responsibility | Action |
|:---|:---|:---|
| `src/findings/cycle-types.ts` | Type definitions for `FixCycle`, `FixCycleContext`, etc. | Modify — widen `validate` signature |
| `src/findings/cycle.ts` | `runFixCycle` orchestration | Modify — replace `allExhausted` early-return with lite-validate-then-classify; update single `cycle.validate(ctx)` call to pass `{ mode: "full" }` |
| `src/pipeline/stages/autofix.ts` | `recheckReview` helper used by autofix V1 + V2 | Modify — add optional `{ lite?: boolean }` arg; when lite, augment `ctx.retrySkipChecks` with `adversarial`/`semantic`, set `ctx.skipLLMReviewers = true`, and skip the failOpen-on-retry check |
| `src/pipeline/types.ts` | Pipeline context type | Modify — add `skipLLMReviewers?: boolean` field |
| `src/pipeline/stages/review.ts` | Review stage early-return paths | Modify — gate the two dialogue branches on `!ctx.skipLLMReviewers` so lite mode falls through to the orchestrator path |
| `src/pipeline/stages/autofix-cycle.ts` | Autofix V2 cycle wiring | Modify — `validate` closure accepts `opts.mode` and forwards `lite` to `recheckReview` (line-neutral) |
| `src/execution/lifecycle/acceptance-loop.ts` | Acceptance-test cycle wiring | Modify — `validate` closure accepts the new opts arg (ignored — acceptance is mechanical-only) |
| `test/unit/findings/cycle.test.ts` | Unit tests for `runFixCycle` | Modify — replace the "skip validate on final allowed attempt" describe block with "lite validate on final allowed attempt" coverage |
| `test/unit/pipeline/stages/autofix.test.ts` *(create if absent — see Task 7 prelude)* | Unit test for `recheckReview` lite mode | Create or extend |
| `test/unit/pipeline/stages/review.test.ts` *(create or extend — see Task 9 prelude)* | Unit test for dialogue gate | Create or extend |

No new public APIs leak — only internal types change. No new config keys.

---

## Task 1: Widen `FixCycle.validate` signature with a `mode` opts arg

**Files:**
- Modify: `src/findings/cycle-types.ts:179`

The `validate` field is the only callback through which the cycle communicates with its surrounding pipeline. We need a way to tell the autofix closure "this is the terminal lite call." Simplest stable shape: pass an opts object with `mode: "full" | "lite"`. Existing call sites pass `{ mode: "full" }`.

- [ ] **Step 1: Read the existing type to confirm starting state**

Open `src/findings/cycle-types.ts` and confirm line 179 reads:

```ts
validate: (ctx: FixCycleContext) => Promise<F[]>;
```

- [ ] **Step 2: Replace the validate signature with the opts variant**

Replace lines 174–179 (the JSDoc and the `validate` field) with:

```ts
  /**
   * Single validator for the cycle. Runs once per iteration, after all co-run
   * strategies complete. On throw, retried config.validatorRetries times before
   * exiting with "validator-error".
   *
   * `opts.mode` indicates the call site:
   *   - "full": normal per-iteration validate (default for non-terminal calls)
   *   - "lite": the terminal call made after the last fix when all strategies
   *     have hit their attempt cap. Implementers SHOULD skip expensive LLM
   *     reviewers in lite mode — only mechanical checks (lint, typecheck,
   *     tests) are needed to detect a silent-pass on the final fix. See
   *     issue #1030.
   */
  validate: (ctx: FixCycleContext, opts: { mode: "full" | "lite" }) => Promise<F[]>;
```

- [ ] **Step 3: Verify type check fails downstream (intentional — we'll fix in subsequent tasks)**

Run: `bun run typecheck 2>&1 | head -40`

Expected: errors about `cycle.validate(ctx)` being called with too few arguments in `src/findings/cycle.ts:333`, and the `validate: async (_ctx) => { … }` definitions in `src/pipeline/stages/autofix-cycle.ts:530` and `src/execution/lifecycle/acceptance-loop.ts:297` being assignable but missing the `opts` parameter (TypeScript may or may not flag this depending on strictness — the call-site error is the load-bearing one).

Do not fix yet. The failing typecheck proves the change took effect.

- [ ] **Step 4: Do not commit yet**

We commit at the end of Task 4 once the type change propagates cleanly through all consumers.

---

## Task 2: Update `runFixCycle` call site to pass `{ mode: "full" }`

**Files:**
- Modify: `src/findings/cycle.ts:333`

This is the trivial type-fix half of the propagation. The real semantic change (lite call on `allExhausted`) is Task 5.

- [ ] **Step 1: Read the current call site**

Open `src/findings/cycle.ts`. Lines 331–334 currently read:

```ts
    for (;;) {
      try {
        findingsAfter = await cycle.validate(ctx);
        break;
```

- [ ] **Step 2: Pass the `{ mode: "full" }` opts arg**

Replace `await cycle.validate(ctx);` on line 333 with:

```ts
        findingsAfter = await cycle.validate(ctx, { mode: "full" });
```

- [ ] **Step 3: Do not commit yet** — typecheck will still fail until Tasks 3–4 finish.

---

## Task 3: Make the autofix-cycle `validate` closure accept opts (no behavior change yet)

**Files:**
- Modify: `src/pipeline/stages/autofix-cycle.ts:530`

We update the function signature only. Plumbing `mode` into `recheckReview` is Task 6.

- [ ] **Step 1: Read the current closure**

Open `src/pipeline/stages/autofix-cycle.ts`. Around lines 530–565 the closure reads:

```ts
    async validate(_cycleCtx: FixCycleContext): Promise<Finding[]> {
      // Update beforeRef after all strategies in this iteration have committed.
      iterationBeforeRef = (await _autofixCycleGuardDeps.captureGitRef(ctx.workdir)) ?? iterationBeforeRef;
      // recheckReview mutates ctx.reviewResult; subsequent buildInput reads fresh state
      await _autofixDeps.recheckReview(ctx);
      …
```

- [ ] **Step 2: Add the opts parameter (unused for now — Task 6 wires it in)**

Replace the function signature line with:

```ts
    async validate(_cycleCtx: FixCycleContext, _opts: { mode: "full" | "lite" }): Promise<Finding[]> {
```

The underscore prefix on `_opts` documents that this task is signature-only; Task 6 removes the underscore.

---

## Task 4: Make the acceptance-loop `validate` closure accept opts (and commit the type-only changes)

**Files:**
- Modify: `src/execution/lifecycle/acceptance-loop.ts:297`

Acceptance test validation is mechanical-only (runs the test command). Lite mode is meaningless here — we accept and ignore the arg.

- [ ] **Step 1: Update the closure signature**

Open `src/execution/lifecycle/acceptance-loop.ts`. Line 297 currently reads:

```ts
    validate: async (_ctx) => {
```

Replace with:

```ts
    // Acceptance loop validate is mechanical-only (acceptance tests). opts.mode
    // is accepted for signature compatibility with FixCycle.validate and ignored
    // — there are no LLM reviewers to skip in lite mode here.
    validate: async (_ctx, _opts: { mode: "full" | "lite" }) => {
```

- [ ] **Step 2: Run typecheck — should now pass**

Run: `bun run typecheck`

Expected: no errors related to `validate` / `FixCycle`. (Other unrelated errors mean you broke something else — fix before continuing.)

- [ ] **Step 3: Run the full cycle test suite — should still pass (no behavior change yet)**

Run: `timeout 60 bun test test/unit/findings/cycle.test.ts --timeout=10000`

Expected: all tests pass (we haven't changed behavior; existing tests pass `validate(ctx)` directly with no opts arg — that's still allowed because the existing call sites in tests construct `FixCycle<Finding>` and supply their own `validate` callback whose signature is structurally compatible since `opts` will just be passed and ignored). If tests fail because the test fixtures define a `validate` that only takes one arg and tooling complains, see Task 7 — but TypeScript's bivariance on function args should accept the narrower test definitions.

- [ ] **Step 4: Commit the type-only widening**

```bash
git add src/findings/cycle-types.ts src/findings/cycle.ts src/pipeline/stages/autofix-cycle.ts src/execution/lifecycle/acceptance-loop.ts
git commit -m "refactor(findings): add mode opts to FixCycle.validate signature

Preparation for #1030: lite-mode terminal validate on exhausted autofix
cycles. This commit changes only the signature — all existing call sites
pass { mode: \"full\" } and behavior is unchanged. The lite branch is
introduced in a follow-up commit."
```

---

## Task 5: Failing test — `allExhausted` runs lite validate and exits resolved when it passes

**Files:**
- Modify: `test/unit/findings/cycle.test.ts:308-357`

Before changing `runFixCycle` behavior, write the test that captures the new contract. TDD red phase.

- [ ] **Step 1: Replace the existing describe block**

Open `test/unit/findings/cycle.test.ts`. Lines 306–357 contain the old describe block `runFixCycle — skip validate on final allowed attempt` with 3 tests. Replace the entire block (from line 306 through the closing `});` on line 357) with:

```ts
// ─── runFixCycle — lite validate on final allowed attempt (#1030) ───────────

describe("runFixCycle — lite validate on final allowed attempt", () => {
  test("calls validate with mode:'lite' when the only strategy hits its cap after a fix", async () => {
    let receivedMode: "full" | "lite" | undefined;
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const cycle = makeCycle([lintA], [strategy], async (_ctx, opts) => {
      receivedMode = opts.mode;
      return [lintA]; // still failing
    });
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callOp: callOpMock as unknown as CallOpFn,
    });

    expect(receivedMode).toBe("lite");
    expect(result.exitReason).toBe("max-attempts-per-strategy");
    expect(callOpMock).toHaveBeenCalledTimes(1);
  });

  test("exits resolved when the lite validate after the final fix returns no findings", async () => {
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const cycle = makeCycle([lintA], [strategy], async (_ctx, _opts) => {
      // The terminal fix actually resolved everything — lite validate sees a clean tree.
      return [];
    });
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callOp: callOpMock as unknown as CallOpFn,
    });

    expect(result.exitReason).toBe("resolved");
    expect(result.finalFindings).toEqual([]);
  });

  test("escalation digest uses post-fix findings, not the pre-fix snapshot", async () => {
    // Pre-fix snapshot had lintA + lintB; the terminal fix resolved lintA and
    // left lintB. With the old skip-validate path, finalFindings would have been
    // [lintA, lintB] (stale). With lite validate, it is [lintB] (fresh).
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const cycle = makeCycle([lintA, lintB], [strategy], async (_ctx, _opts) => [lintB]);
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callOp: callOpMock as unknown as CallOpFn,
    });

    expect(result.exitReason).toBe("max-attempts-per-strategy");
    expect(result.finalFindings).toEqual([lintB]);
  });

  test("still runs validate when strategy has remaining attempts after a fix", async () => {
    let receivedMode: "full" | "lite" | undefined;
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 3 });
    const cycle = makeCycle([lintA], [strategy], async (_ctx, opts) => {
      receivedMode = opts.mode;
      return []; // resolved
    });
    const callOpMock = makeCallOpMock();

    await runFixCycle(cycle, makeCtx(), "test-cycle", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callOp: callOpMock as unknown as CallOpFn,
    });

    expect(receivedMode).toBe("full");
  });

  test("calls validate with mode:'lite' when all co-run strategies hit their caps simultaneously", async () => {
    let receivedMode: "full" | "lite" | undefined;
    const strategyA = makeStrategy({ name: "fix-a", maxAttempts: 1, coRun: "co-run-sequential" });
    const strategyB = makeStrategy({ name: "fix-b", maxAttempts: 1, coRun: "co-run-sequential" });
    const cycle = makeCycle([lintA], [strategyA, strategyB], async (_ctx, opts) => {
      receivedMode = opts.mode;
      return [lintA];
    });
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callOp: callOpMock as unknown as CallOpFn,
    });

    expect(receivedMode).toBe("lite");
    expect(result.exitReason).toBe("max-attempts-per-strategy");
  });
});
```

- [ ] **Step 2: Widen `makeCycle`'s validateFn parameter type (mandatory)**

The new tests above pass two-arg lambdas through `makeCycle`. The helper's current signature (`(ctx: FixCycleContext) => Promise<Finding[]>` at line 65) is narrower than the field type and will refuse the two-arg callback at the helper boundary. Widen it now (no existing one-arg call sites need to change — bivariance covers them in the reverse direction).

Change line 65 from:

```ts
  validateFn: (ctx: FixCycleContext) => Promise<Finding[]>,
```

to:

```ts
  validateFn: (ctx: FixCycleContext, opts: { mode: "full" | "lite" }) => Promise<Finding[]>,
```

Do not touch the existing `async () => …` / `async (_ctx) => …` validators in other tests — TypeScript allows fewer-args functions to satisfy more-args field types.

- [ ] **Step 3: Run the new tests — they MUST fail**

Run: `timeout 30 bun test test/unit/findings/cycle.test.ts -t "lite validate on final allowed attempt" --timeout=5000`

Expected failures:
- "calls validate with mode:'lite' when the only strategy hits its cap" — fails because `receivedMode` stays `undefined` (current code returns early without calling validate).
- "exits resolved when the lite validate after the final fix returns no findings" — fails because current code returns `exitReason: "max-attempts-per-strategy"`.
- "escalation digest uses post-fix findings" — fails because `finalFindings` is `[lintA, lintB]` (stale) instead of `[lintB]`.
- "still runs validate when strategy has remaining attempts after a fix" — should pass already (this is the unchanged behavior — covers the non-terminal path).
- "calls validate with mode:'lite' when all co-run strategies hit their caps" — fails for the same reason as the first.

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`

Expected: no errors. If you see errors about `makeCycle` validators not matching, perform Step 2 widening.

- [ ] **Step 5: Do not commit yet** — implementation comes in Task 6.

---

## Task 6: Replace the `allExhausted` early-return with lite-validate-then-classify

**Files:**
- Modify: `src/findings/cycle.ts:297-326`

This is the load-bearing behavior change for #1030.

- [ ] **Step 1: Re-read the existing block**

Open `src/findings/cycle.ts`. Lines 297–326 currently read:

```ts
    // ── Skip validate if all active strategies are now at their cap ───────────
    // Counting provisional attempts (including this iteration's fixesApplied).
    const provisionalIterations = [...cycle.iterations, { fixesApplied } as Iteration<F>];
    const allExhausted = group.every((s) => countStrategyAttempts(provisionalIterations, s.name) >= s.maxAttempts);
    if (allExhausted) {
      const finishedAt = now();
      cycle.iterations.push({
        iterationNum: cycle.iterations.length + 1,
        findingsBefore,
        fixesApplied,
        findingsAfter: cycle.findings,
        outcome: "unchanged",
        startedAt,
        finishedAt,
      });
      logger?.info("findings.cycle", "cycle exited — strategy attempt cap reached (skipped final validate)", {
        storyId,
        packageDir,
        cycleName,
        reason: "max-attempts-per-strategy",
        exhaustedStrategy: group[0]?.name,
      });
      return {
        iterations: cycle.iterations,
        finalFindings: cycle.findings,
        exitReason: "max-attempts-per-strategy",
        exhaustedStrategy: group[0]?.name,
        costUsd: totalCostUsd,
      };
    }
```

- [ ] **Step 2: Replace with lite-validate-then-classify**

Replace the entire block (lines 297–326) with:

```ts
    // ── Lite validate when all active strategies are now at their cap (#1030) ─
    // Counting provisional attempts (including this iteration's fixesApplied).
    const provisionalIterations = [...cycle.iterations, { fixesApplied } as Iteration<F>];
    const allExhausted = group.every((s) => countStrategyAttempts(provisionalIterations, s.name) >= s.maxAttempts);
    if (allExhausted) {
      // Run validate in "lite" mode so the implementer of `cycle.validate` can
      // skip expensive LLM reviewers (adversarial / semantic). We only need to
      // know if the final fix resolved everything mechanically — adversarial
      // findings discovered now cannot be fixed in this cycle anyway. See #1030.
      let liteFindingsAfter: F[];
      try {
        liteFindingsAfter = await cycle.validate(ctx, { mode: "lite" });
      } catch (err) {
        // Lite validate threw — fall back to the legacy skip-validate behavior:
        // exit max-attempts-per-strategy with stale findings rather than blocking
        // the cycle on a validator error. Surface the error in logs so it is
        // diagnosable but do NOT consume a validatorRetries budget here; this
        // call is purely advisory.
        logger?.warn("findings.cycle", "lite validate threw — escalating with stale findings", {
          storyId,
          packageDir,
          cycleName,
          error: errorMessage(err),
        });
        const finishedAt = now();
        cycle.iterations.push({
          iterationNum: cycle.iterations.length + 1,
          findingsBefore,
          fixesApplied,
          findingsAfter: cycle.findings,
          outcome: "unchanged",
          startedAt,
          finishedAt,
        });
        return {
          iterations: cycle.iterations,
          finalFindings: cycle.findings,
          exitReason: "max-attempts-per-strategy",
          exhaustedStrategy: group[0]?.name,
          costUsd: totalCostUsd,
        };
      }

      const outcome = classifyOutcome(findingsBefore, liteFindingsAfter);
      const finishedAt = now();
      cycle.iterations.push({
        iterationNum: cycle.iterations.length + 1,
        findingsBefore,
        fixesApplied,
        findingsAfter: liteFindingsAfter,
        outcome,
        startedAt,
        finishedAt,
      });
      cycle.findings = liteFindingsAfter;

      if (outcome === "resolved") {
        logger?.info("findings.cycle", "cycle exited — final lite validate detected silent pass", {
          storyId,
          packageDir,
          cycleName,
          reason: "resolved",
        });
        return {
          iterations: cycle.iterations,
          finalFindings: [],
          exitReason: "resolved",
          costUsd: totalCostUsd,
        };
      }

      logger?.info("findings.cycle", "cycle exited — strategy attempt cap reached (lite validate)", {
        storyId,
        packageDir,
        cycleName,
        reason: "max-attempts-per-strategy",
        exhaustedStrategy: group[0]?.name,
        liteFindingsAfter: liteFindingsAfter.length,
      });
      return {
        iterations: cycle.iterations,
        finalFindings: liteFindingsAfter,
        exitReason: "max-attempts-per-strategy",
        exhaustedStrategy: group[0]?.name,
        costUsd: totalCostUsd,
      };
    }
```

- [ ] **Step 3: Run the cycle tests — they MUST pass**

Run: `timeout 30 bun test test/unit/findings/cycle.test.ts --timeout=5000`

Expected: all tests pass, including the 5 new ones from Task 5 and the agent-gave-up tests (which must still take priority — verify the `unresolvedFa` check at lines 268–295 is **above** the new block; do not reorder).

If the "agent-gave-up takes priority over cap-exhausted" test (around line 397) fails, you broke ordering — the `unresolvedFa` branch must execute before `allExhausted`.

- [ ] **Step 4: Commit the cycle.ts behavior change**

```bash
git add src/findings/cycle.ts test/unit/findings/cycle.test.ts
git commit -m "fix(findings): run lite validate on exhausted cycle to detect silent pass

When the autofix cycle hits the max-attempts-per-strategy cap, the
previous behavior skipped the final validate and returned stale
findingsBefore. If the last fix actually resolved everything, the story
escalated needlessly (#1030).

This change runs cycle.validate with { mode: \"lite\" } on the terminal
iteration. Implementers of validate skip expensive LLM reviewers in lite
mode — only mechanical checks (lint / typecheck / tests) are needed to
detect a silent pass. Resolved outcomes short-circuit to exitReason
\"resolved\"; other outcomes still escalate but with fresh findingsAfter
so the escalation digest reflects the actual post-fix state.

If lite validate throws, we fall back to the legacy stale-findings exit
rather than propagating a validator error from an advisory call."
```

---

## Task 7: Failing test — `recheckReview` lite mode skips adversarial + semantic checks

**Files:**
- Create or modify: `test/unit/pipeline/stages/autofix.test.ts`

The autofix-cycle's `validate` closure forwards `mode` to `recheckReview`. We need `recheckReview` to actually skip LLM reviewers in lite mode. Verify there is no existing test file first:

- [ ] **Step 1: Check for an existing test file**

Run: `ls test/unit/pipeline/stages/autofix.test.ts 2>&1`

If the file exists, append the new describe block. If it does not exist, create it (Step 2 below assumes creation; adapt if appending).

- [ ] **Step 2: Write the failing test**

Create `test/unit/pipeline/stages/autofix.test.ts` (or append to existing file) with:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _autofixDeps } from "../../../../src/pipeline/stages/autofix";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { makeMockAgentManager, makeNaxConfig, makeStory } from "../../../helpers";

describe("recheckReview — lite mode (#1030)", () => {
  let origExecute: unknown;

  beforeEach(() => {
    // No-op — we mock per-test via dynamic import below.
  });

  afterEach(() => {
    if (origExecute !== undefined) {
      // restore handled inline per-test
    }
  });

  test("lite mode adds 'adversarial' and 'semantic' to ctx.retrySkipChecks for the duration of the call", async () => {
    const seenSkipSets: ReadonlyArray<readonly string[]>[] = [];
    // Stub reviewStage.execute via the dynamic import path inside recheckReview.
    // We cannot use mock.module() (banned). Instead intercept by injecting a
    // stub on ctx that the real reviewStage.execute consults — the simplest
    // route is to mock _autofixDeps.recheckReview's collaborator, but since
    // recheckReview imports reviewStage dynamically, we test via a side-effect:
    // pass a ctx whose `reviewResult.checks` we control before and after.
    //
    // For this test we use the documented contract: lite=true MUST set
    // ctx.retrySkipChecks to include "adversarial" and "semantic" before
    // delegating, and restore the original set after.
    const ctx = makeRecheckCtx({
      retrySkipChecks: new Set<string>(["typecheck"]), // pre-existing entry
    });
    // Intercept by monkey-patching the dynamic import target: we expose a
    // testable variant via _autofixDeps.recheckReview itself when lite is
    // passed. Capture the set the review stage would see.
    const capturedSet = await runRecheckReviewLiteCapturing(ctx, seenSkipSets);

    // After the call, the original set must be restored exactly:
    expect(Array.from(ctx.retrySkipChecks ?? [])).toEqual(["typecheck"]);
    // And during the call, "adversarial" + "semantic" must have been added on top.
    expect(capturedSet.has("adversarial")).toBe(true);
    expect(capturedSet.has("semantic")).toBe(true);
    expect(capturedSet.has("typecheck")).toBe(true);
  });

  test("lite mode bypasses the failOpen-on-retry check (LLM checks did not run)", async () => {
    const ctx = makeRecheckCtx({
      autofixAttempt: 2, // would normally trigger fail-closed on failOpen
    });
    // Arrange reviewStage.execute to set ctx.reviewResult with no failOpen
    // checks (lite skipped them) and success=true.
    const passed = await runRecheckReviewLite(ctx, {
      checks: [{ check: "lint", success: true, failOpen: false }],
      success: true,
    });

    expect(passed).toBe(true);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function makeRecheckCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const config = makeNaxConfig();
  return {
    config,
    workdir: "/tmp/test",
    story: makeStory(),
    agentManager: makeMockAgentManager(),
    autofixAttempt: 0,
    retrySkipChecks: new Set<string>(),
    reviewResult: undefined,
    ...overrides,
  } as unknown as PipelineContext;
}

// Stand-in invocation helpers. Implementation in Task 8 must export a way
// for these tests to observe the skip set seen by reviewStage. Recommended:
// Task 8 refactors recheckReview so the dynamic-import shape is replaced with
// a `_autofixDeps.runReviewStage(ctx)` indirection that this test can stub.
async function runRecheckReviewLiteCapturing(
  ctx: PipelineContext,
  capture: ReadonlyArray<readonly string[]>[],
): Promise<Set<string>> {
  const seen = new Set<string>();
  const original = _autofixDeps.runReviewStage;
  _autofixDeps.runReviewStage = async (innerCtx: PipelineContext) => {
    for (const c of innerCtx.retrySkipChecks ?? []) seen.add(c);
    innerCtx.reviewResult = { success: true, checks: [], totalDurationMs: 0 };
  };
  try {
    await _autofixDeps.recheckReview(ctx, { lite: true });
  } finally {
    _autofixDeps.runReviewStage = original;
  }
  capture.push([...seen]);
  return seen;
}

async function runRecheckReviewLite(
  ctx: PipelineContext,
  reviewResult: { checks: { check: string; success: boolean; failOpen: boolean }[]; success: boolean },
): Promise<boolean> {
  const original = _autofixDeps.runReviewStage;
  _autofixDeps.runReviewStage = async (innerCtx: PipelineContext) => {
    innerCtx.reviewResult = {
      success: reviewResult.success,
      checks: reviewResult.checks as PipelineContext["reviewResult"] extends infer R
        ? R extends { checks?: infer C }
          ? C
          : never
        : never,
      totalDurationMs: 0,
    } as PipelineContext["reviewResult"];
  };
  try {
    return await _autofixDeps.recheckReview(ctx, { lite: true });
  } finally {
    _autofixDeps.runReviewStage = original;
  }
}
```

Note for the implementer: the tests reference `_autofixDeps.runReviewStage` which does not exist yet. Task 8 introduces it as part of the refactor (so the dynamic import is replaced with an injectable dep — necessary because `mock.module()` is banned and the current dynamic import is not stubbable from tests).

- [ ] **Step 3: Run the new tests — they MUST fail**

Run: `timeout 30 bun test test/unit/pipeline/stages/autofix.test.ts --timeout=5000`

Expected failures: `_autofixDeps.runReviewStage` is undefined; `recheckReview` does not accept a second `{ lite }` argument. Both are addressed in Task 8.

- [ ] **Step 4: Do not commit yet** — implementation in Task 8.

---

## Task 8: Add lite mode to `recheckReview` and an injectable `runReviewStage` dep

**Files:**
- Modify: `src/pipeline/stages/autofix.ts:273-286, 416-420`

- [ ] **Step 1: Re-read the current `recheckReview`**

Open `src/pipeline/stages/autofix.ts`. Lines 273–286:

```ts
async function recheckReview(ctx: PipelineContext): Promise<boolean> {
  // Import reviewStage lazily to avoid circular deps
  const { reviewStage } = await import("./review");
  if (!reviewStage.enabled(ctx)) return true;
  // reviewStage.execute updates ctx.reviewResult in place.
  // We cannot use result.action here because review returns "continue" for BOTH
  // pass and built-in-check-failure (to hand off to autofix). Check success directly.
  await reviewStage.execute(ctx);
  // A fail-open result (LLM could not parse its response) is not a genuine pass in a
  // recheck context — we already know the review was failing before this call.
  const hasFailOpen = (ctx.reviewResult?.checks ?? []).some((c) => c.failOpen);
  if (hasFailOpen) return false;
  return ctx.reviewResult?.success === true;
}
```

- [ ] **Step 2: Extract the dynamic import into `_autofixDeps.runReviewStage`**

Above the `recheckReview` declaration (after line 271 separator), add:

```ts
async function runReviewStageImpl(ctx: PipelineContext): Promise<void> {
  // Lazy import avoids circular deps between autofix → review → autofix.
  const { reviewStage } = await import("./review");
  if (!reviewStage.enabled(ctx)) return;
  await reviewStage.execute(ctx);
}
```

- [ ] **Step 3: Rewrite `recheckReview` to accept `{ lite?: boolean }` and route through the dep**

Replace lines 273–286 with:

```ts
async function recheckReview(
  ctx: PipelineContext,
  opts: { lite?: boolean } = {},
): Promise<boolean> {
  // Lite mode (#1030): we are running the terminal validate after all autofix
  // strategies have hit their caps. Skip the LLM reviewers (adversarial +
  // semantic) because any findings they surface cannot be fixed in this cycle,
  // and the cost dominates. Mechanical checks (lint / typecheck / tests) still
  // run and answer the only question that matters here: did the last fix
  // resolve things, or do we need to escalate.
  //
  // We need TWO skip mechanisms because reviewStage has two LLM entry points:
  //   1. ctx.retrySkipChecks — consumed by src/review/runner.ts:326 for the
  //      orchestrator path (covers config.checks loop).
  //   2. ctx.skipLLMReviewers — consumed by src/pipeline/stages/review.ts at
  //      the dialogue early-return branches, which would otherwise bypass the
  //      runner entirely and issue an LLM semantic call.
  const lite = opts.lite === true;

  const originalSkips = ctx.retrySkipChecks;
  const originalSkipLLM = ctx.skipLLMReviewers;
  if (lite) {
    ctx.retrySkipChecks = new Set([...(originalSkips ?? []), "adversarial", "semantic"]);
    ctx.skipLLMReviewers = true;
  }

  try {
    await _autofixDeps.runReviewStage(ctx);
  } finally {
    if (lite) {
      ctx.retrySkipChecks = originalSkips;
      ctx.skipLLMReviewers = originalSkipLLM;
    }
  }

  // reviewStage.execute updates ctx.reviewResult in place.
  // We cannot use result.action here because review returns "continue" for BOTH
  // pass and built-in-check-failure (to hand off to autofix). Check success directly.
  //
  // In lite mode, fail-open on LLM checks is vacuous (we skipped them), so the
  // fail-closed-on-retry guard is bypassed — only mechanical pass/fail matters.
  if (!lite) {
    const hasFailOpen = (ctx.reviewResult?.checks ?? []).some((c) => c.failOpen);
    if (hasFailOpen) return false;
  }
  return ctx.reviewResult?.success === true;
}
```

Note: `ctx.skipLLMReviewers` does not exist on `PipelineContext` yet — Step 3b adds it. Apply Step 3b before running typecheck.

- [ ] **Step 3b: Add `skipLLMReviewers` to `PipelineContext`**

Open `src/pipeline/types.ts`. Find the `retrySkipChecks?: Set<string>;` field (around line 258) and immediately after the closing block-comment + field, insert:

```ts
  /**
   * Set to true by recheckReview when running in lite mode (#1030) on the
   * terminal validate of an exhausted autofix cycle. Consumed by
   * reviewStage.execute to skip the dialogue early-return branches that would
   * otherwise issue LLM semantic calls bypassing ctx.retrySkipChecks.
   */
  skipLLMReviewers?: boolean;
```

Keep the field optional. Default-false semantics: any code path that doesn't set it behaves exactly as today.

- [ ] **Step 4: Add `runReviewStage` to the exported `_autofixDeps`**

Find `_autofixDeps` near line 416. It currently reads:

```ts
export const _autofixDeps = {
  runQualityCommand,
  recheckReview,
  runAgentRectification,
```

Update to include the new dep:

```ts
export const _autofixDeps = {
  runQualityCommand,
  recheckReview,
  runReviewStage: runReviewStageImpl,
  runAgentRectification,
```

- [ ] **Step 5: Run the autofix unit tests — MUST pass**

Run: `timeout 30 bun test test/unit/pipeline/stages/autofix.test.ts --timeout=5000`

Expected: pass.

- [ ] **Step 6: Run the full cycle + autofix-cycle test directories — MUST pass**

Run: `timeout 60 bun test test/unit/findings/ test/unit/pipeline/stages/ --timeout=10000`

Expected: all pass. `autofix-unresolved.test.ts` stubs `_autofixDeps.recheckReview = async () => false;` (no-arg) and uses `const saved = { ..._autofixDeps }` + `Object.assign(_autofixDeps, saved)` for restore. That spread is captured at test runtime *after* the source change is in place, so the new `runReviewStage` field is preserved across restore and the no-arg stub still satisfies the widened `(ctx, opts?) => Promise<boolean>` signature (TypeScript permits fewer-args functions). No edits to that test file required.

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/pipeline/stages/autofix.ts src/pipeline/types.ts test/unit/pipeline/stages/autofix.test.ts
git commit -m "feat(autofix): add lite mode to recheckReview that skips LLM reviewers

Lite mode is invoked by the autofix V2 cycle on its terminal iteration
(after all strategies have hit their attempt cap). It augments
ctx.retrySkipChecks with 'adversarial' and 'semantic' so the review
runner skips them, sets ctx.skipLLMReviewers so reviewStage's dialogue
early-return paths also skip the LLM call (gated in a follow-up commit),
and bypasses the fail-closed-on-retry guard (which only matters for LLM
checks).

Refactors the dynamic import of reviewStage into an injectable
_autofixDeps.runReviewStage so the lite-mode behavior is testable without
mock.module(). Part of the fix for #1030."
```

---

## Task 9: Gate `reviewStage.execute` dialogue branches on `ctx.skipLLMReviewers`

**Files:**
- Modify: `src/pipeline/stages/review.ts:34-132`
- Create: `test/unit/pipeline/stages/review.test.ts` *(or append to existing — check first)*

`recheckReview` now sets `ctx.skipLLMReviewers = true` in lite mode, but `reviewStage.execute` has two early-return branches (lines 34–71 and 73–132 in `src/pipeline/stages/review.ts`) that call `ctx.reviewerSession.reReview()` / `.review()` directly — pure LLM dispatches that bypass the runner and never look at `ctx.retrySkipChecks`. We need them to fall through to the orchestrator (which respects `retrySkipChecks`) when `skipLLMReviewers` is set. Without this gate, lite mode is silently incomplete whenever `config.review.dialogue.enabled` is true.

- [ ] **Step 1: Check for an existing review test file**

Run: `ls test/unit/pipeline/stages/review.test.ts 2>&1`

If present, append the describe block below. If absent, create the file.

- [ ] **Step 2: Write the failing tests**

Create `test/unit/pipeline/stages/review.test.ts` (or append) with:

```ts
import { describe, expect, test } from "bun:test";
import { reviewStage } from "../../../../src/pipeline/stages/review";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { makeMockAgentManager, makeNaxConfig, makeStory } from "../../../helpers";

describe("reviewStage.execute — skipLLMReviewers gate (#1030)", () => {
  test("when skipLLMReviewers is true, the dialogue reReview branch is skipped", async () => {
    let reReviewCalled = false;
    const ctx = makeReviewCtx({
      skipLLMReviewers: true,
      reviewerSession: {
        // biome-ignore lint/suspicious/noExplicitAny: minimal session stub
        reReview: async (..._args: any[]) => {
          reReviewCalled = true;
          return { checkResult: { success: true, findings: [] }, cost: 0 };
        },
      } as unknown as PipelineContext["reviewerSession"],
      config: makeNaxConfig({ review: { enabled: true, dialogue: { enabled: true } } }),
    });

    await reviewStage.execute(ctx);

    expect(reReviewCalled).toBe(false);
  });

  test("when skipLLMReviewers is true, the initial dialogue review branch is skipped", async () => {
    let reviewCalled = false;
    const config = makeNaxConfig({
      review: {
        enabled: true,
        dialogue: { enabled: true },
        semantic: { model: "balanced", diffMode: "ref", resetRefOnRerun: false, rules: [], timeoutMs: 600_000 },
      },
    });
    const ctx = makeReviewCtx({
      skipLLMReviewers: true,
      reviewerSession: undefined,
      config,
    });
    // Intercept the session created lazily by reviewStage:
    const origCreate = (await import("../../../../src/pipeline/stages/review"))._reviewDeps.createReviewerSession;
    (await import("../../../../src/pipeline/stages/review"))._reviewDeps.createReviewerSession = () =>
      ({
        // biome-ignore lint/suspicious/noExplicitAny: minimal session stub
        review: async (..._args: any[]) => {
          reviewCalled = true;
          return { checkResult: { success: true, findings: [] }, cost: 0 };
        },
      }) as unknown as ReturnType<typeof origCreate>;

    try {
      await reviewStage.execute(ctx);
    } finally {
      (await import("../../../../src/pipeline/stages/review"))._reviewDeps.createReviewerSession = origCreate;
    }

    expect(reviewCalled).toBe(false);
  });

  test("when skipLLMReviewers is unset (or false), dialogue paths are unchanged", async () => {
    let reReviewCalled = false;
    const ctx = makeReviewCtx({
      // skipLLMReviewers intentionally omitted
      reviewerSession: {
        // biome-ignore lint/suspicious/noExplicitAny: minimal session stub
        reReview: async (..._args: any[]) => {
          reReviewCalled = true;
          return { checkResult: { success: true, findings: [] }, cost: 0 };
        },
      } as unknown as PipelineContext["reviewerSession"],
      config: makeNaxConfig({ review: { enabled: true, dialogue: { enabled: true } } }),
    });

    await reviewStage.execute(ctx);

    expect(reReviewCalled).toBe(true);
  });
});

function makeReviewCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const config = overrides.config ?? makeNaxConfig();
  return {
    config,
    workdir: "/tmp/test",
    story: makeStory(),
    prd: { feature: "test-feature", userStories: [makeStory()] },
    agentManager: makeMockAgentManager(),
    sessionManager: {} as PipelineContext["sessionManager"],
    storyGitRef: "HEAD",
    ...overrides,
  } as unknown as PipelineContext;
}
```

- [ ] **Step 3: Run the new tests — they MUST fail**

Run: `timeout 30 bun test test/unit/pipeline/stages/review.test.ts -t "skipLLMReviewers gate" --timeout=5000`

Expected failures: the two "is skipped" tests fail because the current code in `reviewStage.execute` doesn't check `ctx.skipLLMReviewers` — both dialogue branches execute and the spies record `true`. The "unchanged" test should already pass (sanity baseline).

- [ ] **Step 4: Add the gate to `reviewStage.execute`**

Open `src/pipeline/stages/review.ts`. Two edits, both narrowing the existing `if (dialogueEnabled && …)` conditions:

Around line 35, change:

```ts
    if (dialogueEnabled && !reviewDebateEnabled && ctx.reviewerSession) {
```

to:

```ts
    // #1030: lite recheckReview sets ctx.skipLLMReviewers — fall through to the
    // orchestrator (which honors ctx.retrySkipChecks) instead of issuing an LLM call.
    if (dialogueEnabled && !reviewDebateEnabled && ctx.reviewerSession && !ctx.skipLLMReviewers) {
```

Around line 74, change:

```ts
    if (dialogueEnabled && !ctx.reviewerSession && ctx.agentManager && ctx.sessionManager) {
```

to:

```ts
    if (dialogueEnabled && !ctx.reviewerSession && ctx.agentManager && ctx.sessionManager && !ctx.skipLLMReviewers) {
```

No other changes in `review.ts`. The fall-through path (`reviewFromContext` → runner) already honors `ctx.retrySkipChecks`, which Task 8 augments with `"adversarial"`/`"semantic"`.

- [ ] **Step 5: Run the new tests — MUST pass**

Run: `timeout 30 bun test test/unit/pipeline/stages/review.test.ts --timeout=5000`

Expected: pass.

- [ ] **Step 6: Run full test:bail**

Run: `bun run test:bail`

Expected: all pass. The gate is a narrowing condition that only activates when `skipLLMReviewers` is set — no other code path touches that field today, so existing dialogue-mode tests must remain green.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/stages/review.ts test/unit/pipeline/stages/review.test.ts
git commit -m "fix(review): gate dialogue early-return branches on ctx.skipLLMReviewers

Without this gate, the lite recheckReview path (#1030) only suppresses
LLM reviewers reached through the orchestrator + runner — the dialogue
early-return branches at the top of reviewStage.execute still issue an
LLM semantic call, defeating the cost claim of lite mode when
config.review.dialogue.enabled is true.

The gate is a single-condition narrowing on each of the two existing
dialogue branches. When skipLLMReviewers is unset (the default), behavior
is unchanged."
```

---

## Task 10: Wire `mode` from the autofix-cycle validate closure into `recheckReview`

**Files:**
- Modify: `src/pipeline/stages/autofix-cycle.ts:530-534`

- [ ] **Step 1: Re-read the closure**

Open `src/pipeline/stages/autofix-cycle.ts`. The signature is now:

```ts
    async validate(_cycleCtx: FixCycleContext, _opts: { mode: "full" | "lite" }): Promise<Finding[]> {
      // Update beforeRef after all strategies in this iteration have committed.
      iterationBeforeRef = (await _autofixCycleGuardDeps.captureGitRef(ctx.workdir)) ?? iterationBeforeRef;
      // recheckReview mutates ctx.reviewResult; subsequent buildInput reads fresh state
      await _autofixDeps.recheckReview(ctx);
```

- [ ] **Step 2: Remove the underscore on opts and forward `lite` to `recheckReview` (line-neutral)**

`src/pipeline/stages/autofix-cycle.ts` is at the 600-line hard limit. This edit must not add any net lines. The change is exactly two characters of signature edit (`_opts` → `opts`) plus rewriting the existing `recheckReview(ctx)` line into a one-line forward.

Replace the signature line:

```ts
    async validate(_cycleCtx: FixCycleContext, _opts: { mode: "full" | "lite" }): Promise<Finding[]> {
```

with:

```ts
    async validate(_cycleCtx: FixCycleContext, opts: { mode: "full" | "lite" }): Promise<Finding[]> {
```

Replace the existing comment + call (these two lines together):

```ts
      // recheckReview mutates ctx.reviewResult; subsequent buildInput reads fresh state
      await _autofixDeps.recheckReview(ctx);
```

with (still two lines):

```ts
      // recheckReview mutates ctx.reviewResult; lite mode (#1030) skips LLM reviewers on terminal validate
      await _autofixDeps.recheckReview(ctx, { lite: opts.mode === "lite" });
```

Net line change: 0. The rest of the closure (lines 535+) is unchanged: collecting findings, partitioning mock-structure declarations, etc.

- [ ] **Step 2b: Verify the file is still ≤ 600 lines**

Run: `wc -l src/pipeline/stages/autofix-cycle.ts`

Expected: 600 (unchanged). If higher, you added a line — compress an existing comment or the new comment until you're back at 600.

- [ ] **Step 3: Run the full autofix-cycle + cycle + autofix tests**

Run: `timeout 60 bun test test/unit/findings/ test/unit/pipeline/stages/ --timeout=10000`

Expected: pass.

- [ ] **Step 4: Run the full test suite to catch any cross-module regressions**

Run: `bun run test:bail`

Expected: all pass. If something unrelated breaks, do not paper over it — root-cause it.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/stages/autofix-cycle.ts
git commit -m "feat(autofix-cycle): forward validate mode to recheckReview for lite recheck

Wires the FixCycle.validate opts.mode through to recheckReview, so the
terminal lite call (issue #1030) skips adversarial + semantic reviewers
both via the runner (retrySkipChecks) and via the dialogue early-return
gate (skipLLMReviewers). This is the final piece that activates the
silent-pass detection: when runFixCycle hits the per-strategy cap, it
calls validate with { mode: \"lite\" } and the closure here translates
that into recheckReview(ctx, { lite: true })."
```

---

## Task 11: Verify end-to-end behavior with a focused integration assertion

**Files:**
- Modify: `test/unit/findings/cycle.test.ts` (add one final assertion to the new describe block)

Defense in depth: confirm the new behavior preserves the iteration count and that `findingsAfter` on the recorded iteration reflects the lite result (not stale `findingsBefore`). This catches the bookkeeping detail in Task 6's replacement code.

- [ ] **Step 1: Add one more test inside the "lite validate on final allowed attempt" describe block**

After the existing 5 tests, before the closing `});` of the describe block, add:

```ts
  test("records the terminal iteration with findingsAfter from the lite validate", async () => {
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const cycle = makeCycle([lintA, lintB], [strategy], async (_ctx, _opts) => [lintB]);
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callOp: callOpMock as unknown as CallOpFn,
    });

    expect(result.iterations).toHaveLength(1);
    const last = result.iterations[0];
    expect(last.findingsBefore).toEqual([lintA, lintB]);
    expect(last.findingsAfter).toEqual([lintB]); // not stale
    expect(last.outcome).toBe("partial");
  });
```

- [ ] **Step 2: Run the test**

Run: `timeout 30 bun test test/unit/findings/cycle.test.ts -t "records the terminal iteration" --timeout=5000`

Expected: pass.

- [ ] **Step 3: Final full-suite gate**

Run: `bun run test`

Expected: all pass.

- [ ] **Step 4: Lint**

Run: `bun run lint`

Expected: clean (or auto-fixable). If issues are reported, run `bun run lint:fix` and inspect the diff before committing.

- [ ] **Step 5: Commit**

```bash
git add test/unit/findings/cycle.test.ts
git commit -m "test(findings): assert terminal iteration records fresh findingsAfter (#1030)

Defense-in-depth check that the bookkeeping in the new lite-validate
branch persists the post-fix findings on the recorded iteration, not
the stale pre-fix snapshot."
```

---

## Done. Sanity checklist before opening PR

- [ ] All commits use conventional-commit prefixes (`feat`, `fix`, `refactor`, `test`).
- [ ] No commit message contains `[run-release]`.
- [ ] `bun run typecheck` passes.
- [ ] `bun run lint` passes.
- [ ] `bun run test` passes.
- [ ] `wc -l src/pipeline/stages/autofix-cycle.ts` reports ≤ 600 (the 600-line hard limit was respected, not breached).
- [ ] The `agent-gave-up takes priority over cap-exhausted` test still passes — confirms ordering invariant in `cycle.ts` was preserved.
- [ ] Both lite-mode skip paths covered by tests: (a) runner path via `ctx.retrySkipChecks`, (b) dialogue path via `ctx.skipLLMReviewers`.
- [ ] No changes to `src/agents/`, `src/operations/`, `src/runtime/` (issue is contained to the findings + autofix + review subsystem).
- [ ] No new config keys, no schema changes, no migration shims.
- [ ] PR description references issue #1030 and links the run log mentioned in the issue (`2026-05-14T02-46-16.jsonl`).

PR title suggestion: `fix(autofix): run lite validate on exhausted cycle to detect silent pass (#1030)`
