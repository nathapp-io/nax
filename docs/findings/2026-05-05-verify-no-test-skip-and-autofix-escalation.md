# Patch Plan — Bug 2 (US-007 stuck-loop, sub-bugs 2A / 2C / 2D)

> Single PR delivering three coordinated fixes that together break the cascade observed on US-007 (a docs-only story that hit a 5-cycle no-op autofix loop and failed at max-retries). Sub-bug 2B (test artifacts leaking into the source tree from `logging.test.ts`) has already been resolved in a separate change.

**Linked**: [2026-05-05-context-curator-v0-dogfood-findings.md](./2026-05-05-context-curator-v0-dogfood-findings.md) → Bug 2

---

## Why one PR

Each sub-bug, fixed alone, would have prevented US-007's failure — but each leaves the system fragile to a similar cascade in adjacent scenarios (e.g. config-only stories, rename-only stories, any future review pre-check that surfaces zero findings). Shipping them together makes the orchestration robust against the *class* of "review failed with no actionable signal" rather than just this one observed path.

The three fixes also have natural seams:
- **2A** is a single 4-line skip in verify; it's the prevention.
- **2C** is signal hygiene at the review boundary; it's the surfacing.
- **2D** is loop detection at the autofix boundary; it's the safety net.

---

## Scope

### In

- `src/pipeline/stages/verify.ts` — skip when `routing.testStrategy === "no-test"`
- `src/review/runner.ts` — surface `git-clean` as a named failed check; expand built-in test-artifact ignore patterns
- `src/pipeline/stages/autofix.ts` — escalate when review fails with no actionable signal
- Tests: see [Test plan](#test-plan)

### Out (separate PRs / already done)

- 2B (test hygiene in `logging.test.ts`) — already shipped
- Smart-runner over-eager scoping for markdown-only diffs — separate refinement; 2A removes the trigger so this becomes lower priority
- Auto-cleaning of test-artifact files via `.gitignore` audit — separate, infrastructural

---

## Change set

### 1. `src/pipeline/stages/verify.ts` — honour `testStrategy: "no-test"` (Bug 2A)

The verify stage currently checks three skip conditions: `fullSuiteGatePassed`, `quality.requireTests`, and `rawTestCommand`. None of them consult routing. A docs-only story enters verify, smart-runner picks up unrelated test files, and any pre-existing failure gets attributed to the wrong story.

Two changes — a stage-level `enabled` predicate (so the pipeline log shows `Stage "verify" skipped` cleanly) and a defensive guard inside `execute` (so direct callers of the stage are also protected).

```diff
 export const verifyStage: PipelineStage = {
   name: "verify",
-  enabled: (ctx: PipelineContext) => !ctx.fullSuiteGatePassed,
-  skipReason: () => "not needed (full-suite gate already passed)",
+  enabled: (ctx: PipelineContext) =>
+    !ctx.fullSuiteGatePassed && ctx.routing.testStrategy !== "no-test",
+  skipReason: (ctx: PipelineContext) =>
+    ctx.fullSuiteGatePassed
+      ? "not needed (full-suite gate already passed)"
+      : 'not needed (routing.testStrategy="no-test")',

   async execute(ctx: PipelineContext): Promise<StageResult> {
     const logger = getLogger();

+    // Defensive: if a caller bypassed the `enabled` predicate, still skip when the
+    // routing decision says no tests. Verify cannot meaningfully validate a docs- or
+    // config-only diff, and unrelated failures get mis-attributed to this story.
+    if (ctx.routing.testStrategy === "no-test") {
+      logger.info("verify", "Skipping verification (testStrategy=no-test)", {
+        storyId: ctx.story.id,
+        noTestJustification: ctx.routing.noTestJustification ?? null,
+      });
+      return { action: "continue" };
+    }
+
     // Skip verification if tests are not required
     if (!ctx.config.quality.requireTests) {
       logger.debug("verify", "Skipping verification (quality.requireTests = false)", { storyId: ctx.story.id });
       return { action: "continue" };
     }
```

This single change short-circuits the entire US-007 cascade. The autofix stage already special-cases `testStrategy === "no-test"` ([`autofix.ts:146`](../../src/pipeline/stages/autofix.ts)) — verify now does the same, so the routing decision is honoured consistently across the three stages that consume it (prompt, verify, autofix).

### 2. `src/review/runner.ts` — name the `git-clean` mechanical check (Bug 2C)

The "uncommitted changes" pre-check today returns:
```ts
return {
  success: false,
  checks: [],                                    // ← empty: no signal to autofix
  totalDurationMs: ...,
  failureReason: `Working tree has uncommitted changes:\n  - ...`,
};
```

The downstream autofix stage extracts `failedCheckNames` from `checks` ([`autofix.ts:63`](../../src/pipeline/stages/autofix.ts)) — which is empty. The review log line says `Review failed (built-in checks)` but lists zero failed checks. This is the missing signal that makes Bug 2D's loop possible.

Surface the check by name, and expand the built-in test-artifact ignore patterns to drop common test-output kinds (`.jsonl` files under `test/**/`, `coverage/`):

```diff
 const NAX_RUNTIME_PATTERNS = [
   /nax\.lock$/,
   /nax\/metrics\.json$/,
   // … existing patterns …
   /\.nax-acceptance[^/]*$/,
+  // Test-output artifacts — these are leaked transient files, not user changes.
+  // 2B already migrated logging.test.ts to a temp dir; this guards against
+  // future tests with similar leak patterns and against partial cleanup races.
+  /\/test\/.*\.jsonl$/,
+  /\/coverage\//,
+  /\.lcov$/,
 ];
 const afterRuntimeFilter = allUncommittedFiles.filter(
   (f) => !NAX_RUNTIME_PATTERNS.some((pattern) => pattern.test(f)),
 );
 const uncommittedFiles = naxIgnoreIndex ? naxIgnoreIndex.filter(afterRuntimeFilter, workdir) : afterRuntimeFilter;
 if (uncommittedFiles.length > 0) {
   const fileList = uncommittedFiles.join(", ");
   logger?.warn("review", `Uncommitted changes detected before review: ${fileList}`);
   return {
     success: false,
-    checks: [],
+    checks: [{
+      check: "git-clean",
+      success: false,
+      command: "git status --porcelain",
+      exitCode: 1,
+      output: uncommittedFiles.map((f) => `?? ${f}`).join("\n"),
+      durationMs: 0,
+      // No `findings` — autofix stage will see this as a non-LLM mechanical failure
+      // with a named check, and will escalate cleanly per the 2D guard.
+    }],
     totalDurationMs: Date.now() - startTime,
     failureReason: `Working tree has uncommitted changes:\n${uncommittedFiles.map((f) => `  - ${f}`).join("\n")}\n\nStage and commit these files before running review.`,
   };
 }
```

Type note: `"git-clean"` needs to be added to `ReviewCheckName` in [`src/review/types.ts`](../../src/review/types.ts). Search-and-add only; no other consumer needs to know the new name beyond the autofix escalation guard below.

### 3. `src/pipeline/stages/autofix.ts` — escalate on unsignaled review failure (Bug 2D)

After 2C names the failing check, autofix can detect the case it cannot fix and escalate cleanly instead of running a no-op cycle that reports `succeeded: true`.

Insert near the top of `execute`, after the existing failed-check-name aggregation:

```diff
   async execute(ctx: PipelineContext): Promise<StageResult> {
     const logger = getLogger();
     const { reviewResult } = ctx;

     if (!reviewResult || reviewResult.success) {
       return { action: "continue" };
     }

     // … existing lintFix/formatFix command resolution …

     // Identify which checks failed
     const failedCheckNames = new Set((reviewResult.checks ?? []).filter((c) => !c.success).map((c) => c.check));
-    const hasLintFailure = failedCheckNames.has("lint");
+    const hasLintFailure = failedCheckNames.has("lint");
+
+    // 2D guard: detect "review failed with no actionable signal".
+    //
+    // If review reported failure but produced neither a named failing check nor any
+    // findings, autofix has nothing to do — running anyway produces a no-op cycle
+    // that reports `succeeded:true` and re-enters review, looping until max-retries.
+    //
+    // Mechanical pre-checks (e.g. git-clean from 2C) name themselves but produce no
+    // findings; those are listed below as "non-fixable by agent rectification".
+    const NON_FIXABLE_BY_RECTIFICATION = new Set(["git-clean"]);
+    const totalFindingCount = (reviewResult.checks ?? []).reduce(
+      (n, c) => n + (c.findings?.length ?? 0),
+      0,
+    );
+    const allFailuresNonFixable =
+      failedCheckNames.size > 0 &&
+      [...failedCheckNames].every((c) => NON_FIXABLE_BY_RECTIFICATION.has(c));
+    if (failedCheckNames.size === 0 || (allFailuresNonFixable && totalFindingCount === 0)) {
+      logger.error("autofix", "Cannot autofix: review failed with no actionable signal", {
+        storyId: ctx.story.id,
+        failedChecks: [...failedCheckNames],
+        failureReason: reviewResult.failureReason,
+      });
+      return {
+        action: "escalate",
+        reason: `Review failed without actionable signal: ${reviewResult.failureReason ?? "(no reason given)"}`,
+      };
+    }

     logger.info("autofix", "Starting autofix", {
       storyId: ctx.story.id,
       failedChecks: [...failedCheckNames],
       workdir: ctx.workdir,
     });
```

This bounds the loop. Behaviour matrix after the guard:

| Input | Path | Outcome |
|:---|:---|:---|
| `failedChecks: []`, no findings | guard fires | escalate with original `failureReason` |
| `failedChecks: ["git-clean"]`, no findings | guard fires (non-fixable + zero findings) | escalate cleanly |
| `failedChecks: ["semantic"]`, 3 findings | guard skipped | proceed to agent rectification |
| `failedChecks: ["lint"]`, no findings | guard skipped (lint is fixable mechanically) | proceed to lintFix |

The non-fixable set is intentionally small — only checks that the agent cannot meaningfully address from the prompt context. `lint`, `semantic`, `adversarial`, `build`, `test` all stay fixable.

---

## Test plan

### Unit — verify stage skip on `testStrategy: "no-test"` (2A)

`test/unit/pipeline/stages/verify.test.ts` *(extend)*:
```ts
describe("verifyStage — testStrategy gating", () => {
  test("enabled returns false when routing.testStrategy === 'no-test'", () => {
    const ctx = makePipelineCtx({ routing: { testStrategy: "no-test", complexity: "simple", ... } });
    expect(verifyStage.enabled?.(ctx)).toBe(false);
    expect(verifyStage.skipReason?.(ctx)).toContain('testStrategy="no-test"');
  });

  test("enabled returns true for test-after when full-suite gate not yet passed", () => {
    const ctx = makePipelineCtx({ routing: { testStrategy: "test-after", ... }, fullSuiteGatePassed: false });
    expect(verifyStage.enabled?.(ctx)).toBe(true);
  });

  test("execute returns continue with skip log when testStrategy is no-test", async () => {
    const logSpy = spyOn(logger, "info");
    const ctx = makePipelineCtx({ routing: { testStrategy: "no-test", noTestJustification: "docs only", ... } });
    const result = await verifyStage.execute!(ctx);
    expect(result).toEqual({ action: "continue" });
    expect(logSpy).toHaveBeenCalledWith(
      "verify",
      "Skipping verification (testStrategy=no-test)",
      expect.objectContaining({ storyId: ctx.story.id, noTestJustification: "docs only" }),
    );
  });
});
```

### Unit — review pre-check surfaces `git-clean` (2C)

`test/unit/review/runner.test.ts` *(extend)*:
```ts
test("uncommitted changes return a named git-clean failed check, not empty checks", async () => {
  // mock isWorktreeClean / git status to report dirty
  const result = await runReview({ /* ... */ });
  expect(result.success).toBe(false);
  expect(result.checks).toHaveLength(1);
  expect(result.checks[0]).toMatchObject({
    check: "git-clean",
    success: false,
    command: "git status --porcelain",
    exitCode: 1,
  });
  expect(result.checks[0].output).toContain("?? src/foo.ts");
  expect(result.checks[0].findings).toBeUndefined();
});

test("test-output artifacts under test/**/*.jsonl are filtered from uncommitted check", async () => {
  // mock git status to include test artifacts
  const result = await runReview({ /* ... uncommittedFiles: ["test/unit/runtime/middleware/test-logging-sub-X.jsonl", "src/real.ts"] */ });
  // src/real.ts still triggers; the .jsonl is filtered
  expect(result.checks[0].output).toContain("src/real.ts");
  expect(result.checks[0].output).not.toContain("test-logging-sub");
});
```

### Unit — autofix escalation on unsignaled failure (2D)

`test/unit/pipeline/stages/autofix.test.ts` *(extend)*:
```ts
describe("autofixStage — unsignaled-failure guard", () => {
  test("escalates when reviewResult.checks is empty", async () => {
    const ctx = makePipelineCtx({
      reviewResult: { success: false, failureReason: "mechanical failure", checks: [] },
    });
    const result = await autofixStage.execute!(ctx);
    expect(result.action).toBe("escalate");
    expect(result.reason).toContain("Review failed without actionable signal");
  });

  test("escalates when only failed check is git-clean with no findings", async () => {
    const ctx = makePipelineCtx({
      reviewResult: {
        success: false,
        failureReason: "Working tree has uncommitted changes",
        checks: [{ check: "git-clean", success: false, command: "git status --porcelain", exitCode: 1, output: "?? a.ts", durationMs: 0 }],
      },
    });
    const result = await autofixStage.execute!(ctx);
    expect(result.action).toBe("escalate");
  });

  test("proceeds when semantic check has findings", async () => {
    const ctx = makePipelineCtx({
      reviewResult: {
        success: false,
        checks: [{ check: "semantic", success: false, findings: [{ severity: "error", file: "a.ts", line: 1, message: "x", ruleId: "y" }], /* ... */ }],
      },
    });
    // mock _autofixDeps.runAgentRectification to assert it's called
    const result = await autofixStage.execute!(ctx);
    expect(result.action).not.toBe("escalate");  // proceeds to agent rectification
  });

  test("proceeds when lint failed (mechanically fixable, no findings expected)", async () => {
    // lint failure with empty findings is normal — lintFix command is the fix
    const ctx = makePipelineCtx({
      reviewResult: { success: false, checks: [{ check: "lint", success: false, /* ... */ }] },
      config: makeNaxConfig({ quality: { commands: { lintFix: "biome check --write" } } }),
    });
    const result = await autofixStage.execute!(ctx);
    expect(result.action).not.toBe("escalate");
  });
});
```

### Integration — US-007 cascade regression

`test/integration/pipeline/docs-only-story.test.ts` *(new)*:
```ts
test("docs-only story (testStrategy=no-test) skips verify and review pre-check passes", async () => {
  // Set up a fake feature with one story marked testStrategy=no-test
  // Run the pipeline up through review
  // Assert:
  //   - verifyStage logged "Skipping verification (testStrategy=no-test)"
  //   - smart-runner was NOT invoked
  //   - review stage proceeded normally (assuming worktree clean)
  //   - story status: passed
});

test("review with empty failedChecks escalates cleanly via autofix guard", async () => {
  // Inject a fake reviewResult with success:false, checks:[]
  // Run autofixStage
  // Assert: action: "escalate", no agent rectification spawned, no loop
});
```

### Tests to update

- Any test asserting `result.checks` is `[]` after an uncommitted-changes failure must be updated to expect a single `git-clean` check entry.
- Any test using a docs-only story fixture that previously expected `verifyStage` to run should be updated to expect a skip.

---

## Migration / rollout

### Backwards compatibility

- **Public stage API unchanged.** `verifyStage.enabled` / `skipReason` / `execute` signatures stay the same.
- **`ReviewCheckName` adds `"git-clean"`** — additive enum change. Type-checks any switch/match on the union; project convention uses exhaustive `assertNever` in helpers like `priorityForCheck`, so all such sites must add a `"git-clean"` arm. (See `src/prompts/builders/rectifier-builder.ts:90`.)
- **No config schema changes.**
- **No plugin contract changes.**

### Telemetry / observability

The new escalation log line in autofix is the primary observability:
```
autofix.error: "Cannot autofix: review failed with no actionable signal"
  failedChecks, failureReason
```

Operators searching for stuck-loop patterns now see this single line instead of N×3 repetitions of `"Gating LLM checks due to mechanical failure"` + `"Review failed (built-in checks)"` + `"Starting V2 fix cycle initialFindingsCount:0"`.

A useful follow-up metric: count `autofix.escalate` events grouped by `failureReason` keywords. If `"Working tree has uncommitted changes"` shows up routinely, that's a signal to expand the test-artifact ignore patterns further.

### Risk assessment

| Change | Risk | Mitigation |
|---|---|---|
| Skip verify on `no-test` | A story mislabelled `no-test` could ship code without test gating | Routing classifier already requires `noTestJustification` for `no-test`; escalation path catches obvious mislabels by failing review later. Worst case is the author runs full-suite once before merge. |
| Add `git-clean` to ReviewCheckName | Exhaustive switches in unrelated code break compilation | Caught at typecheck. Audit `priorityForCheck`, `categoryForCheck`, etc. before merge. |
| Filter `test/**/*.jsonl` from uncommitted check | A real test source file ending in `.jsonl` (e.g. fixtures someone forgot to add) could be silently ignored | The pattern only matches paths *under* `test/`, not the test source files themselves. Test fixtures committed to `test/` directories are normally the kind users *want* unstaged-detected anyway. If a user has a contrary need, `.naxignore` already provides escape hatch. |
| Autofix escalation guard | A check with no findings but legitimately fixable could be escalated | The non-fixable set is closed (`{"git-clean"}`); other checks proceed. New mechanical pre-checks must opt into the set explicitly. |

### Rollback

All three changes are independent and revertable:
- 2A is a 4-line change in one file
- 2C touches one function in `runner.ts` plus one enum line
- 2D is a single guard block in autofix `execute`

If any one needs to be reverted post-merge, the others continue to provide partial protection.

---

## Acceptance checklist

- [ ] `bun run typecheck` clean (catches missed `git-clean` arms in switches)
- [ ] `bun run lint` clean
- [ ] `bun run test` clean (full suite)
- [ ] New unit tests for verify-stage `no-test` skip (enabled/skipReason/execute)
- [ ] New unit tests for `git-clean` named check + test-artifact filtering
- [ ] New unit tests for autofix unsignaled-failure escalation (4 cases)
- [ ] New integration test for docs-only story end-to-end pipeline
- [ ] Updated tests that asserted `checks: []` for git-dirty case
- [ ] Manual verification: re-run a docs-only story (e.g. a one-line README change) and confirm `verify` shows as skipped with the new reason in logs
- [ ] Manual verification: simulate a dirty worktree and confirm the autofix log emits a single escalation, not a 5× retry loop

---

## Commit plan

Suggested split into atomic commits within the PR:

1. `fix(pipeline/verify): skip verification when routing.testStrategy is no-test`
2. `feat(review/types): add git-clean to ReviewCheckName union`
3. `fix(review/runner): surface uncommitted-changes as named git-clean check + filter test artifacts`
4. `fix(pipeline/autofix): escalate on review failure with no actionable signal`
5. `test(pipeline): regression coverage for US-007 cascade (docs-only + unsignaled review failure)`

PR title: `fix(orchestration): break US-007 stuck-loop — verify skip + named git-clean check + autofix escalation guard`

---

## Follow-ups (separate PRs)

- **F1** — Smart-runner over-eager scoping for markdown-only diffs. With 2A in place, docs-only stories no longer trigger this, but config-only/rename-only stories still might. Worth a `diffOnlyMatchesNonCode → skip` heuristic.
- **F2** — Review pre-check should also detect "auto-commit just touched these files in the last N seconds" and re-check before flagging — eliminates a small race window where the auto-commit flushes and review's git-status reads disagree.
- **F3** — Loop-detection generalisation: `pipeline/retry-state.ts` could track "review→autofix→review with identical signature" across iterations and break early. The 2D guard solves the specific empty-signal case but a state-hash detector would catch other "fix attempt produces same failure" loops.
- **F4** — Bug 4 fix (separate plan in [2026-05-05-review-truncation-false-positive-fix.md](./2026-05-05-review-truncation-false-positive-fix.md)) is independent and can ship in either order.
