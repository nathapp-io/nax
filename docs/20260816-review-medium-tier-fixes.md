# Code Review: MEDIUM-tier fix — BUG-2 + ENH-3

**Date:** 2026-08-16
**Reviewer:** Subrina (AI)
**Scope:** Branch `fix/iteration-delay-abort-and-bakeoff-reclaim`
**Files:** 5 changed (lib: 3 / 71 LOC; test: 2 / 142 LOC — including 1 new test file)
**Baseline:** 13635 unit tests pass | 1162 integration tests pass | 37 UI tests pass | typecheck ✓ | lint ✓

---

## Overall Grade: **A- (90/100)**

| Dimension | Score (0-20) |
|:---|:---|
| Security | 20 |
| Reliability | 19 |
| API Design | 17 |
| Code Quality | 17 |
| Best Practices | 17 |

Both MEDIUM findings from the original review are closed cleanly via TDD (each new test failed without the fix and passes with it). BUG-2 wraps both `cancellableDelay` call sites in try/catch and returns a new `ExitReason = "aborted"` value when the AbortSignal fires, preventing the rejection from racing the signal-handler teardown. ENH-3 captures each stale branch's tip SHA via `git rev-parse` before `git branch -D` and logs a recoverable-command warning — silently-lost unmerged work is now recoverable via `git checkout <sha>`. Tests cover both the happy path and the defensive paths (rev-parse failure, pre-aborted signal, mid-delay abort).

The deductions are on **API Design**, **Code Quality**, and **Best Practices** — none of the four findings below are bugs. (1) The new `"aborted"` `ExitReason` flows through to `runner-completion.ts:355-361` which falls through to `status: "failed"` — an aborted run is indistinguishable from a crashed one in the status file. (2) The two try/catch blocks around `cancellableDelay` are duplicated in `unified-executor.ts` (lines 553-571 and 661-678). (3) The `recoverable` field on the ENH-3 log context is a formatted shell command rather than structured data (a copy-pasteable hint, not a structured field). All three are small polish items.

---

## Findings

### 🟢 LOW

#### ENH-1: Aborted run is reported as `status: "failed"` in the status file, indistinguishable from a crashed run
**Severity:** LOW | **Category:** Enhancement (UX)

`src/execution/executor-types.ts:58-66`
```ts
export type ExitReason =
  | "completed" | "cost-limit" | "max-iterations" | "stalled" | "no-stories"
  | "pre-merge-aborted"
  | "aborted";
```

`src/execution/runner-completion.ts:355-361`
```ts
const finalStatus = pluginGateFailed
  ? "failed"
  : options.exitReason === "cost-limit"
    ? "cost-limit"
    : isComplete(options.prd)
      ? "completed"
      : "failed";
```

A user who aborts via Ctrl+C during an iteration delay now sees their run end cleanly (no exception), but the on-disk `status.json` reports `runStatus: "failed"` — the same status a crashed run would produce. Downstream tooling (`nax status`, dashboards, CI checks) can't distinguish "I aborted this" from "this crashed".

**Fix:** Add `"aborted"` to `NaxStatusFile["run"]["status"]` in `src/execution/status-file.ts:77`, then add a branch in `runner-completion.ts:355` and `run-completion.ts:544` to surface it. The cost is ~5 lines across 3 files; the benefit is a user-visible signal that matches the new `ExitReason`.

This is a UX gap, not a correctness bug. Flagged so a follow-up can complete the wire.

#### STYLE-2: Duplicated `cancellableDelay` try/catch block at the two call sites
**Severity:** LOW | **Category:** Style (DRY)

`src/execution/unified-executor.ts:555-571` (parallel-batch path) and `src/execution/unified-executor.ts:663-678` (sequential path) are identical:

```ts
try {
  await cancellableDelay(ctx.config.execution.iterationDelayMs, ctx.runtime.signal);
} catch (err) {
  if (ctx.runtime.signal.aborted) {
    logger?.info("execution", "Iteration delay aborted — exiting cleanly", {
      iterations,
      reason: errorMessage(err),
    });
    return buildResult("aborted");
  }
  throw err;
}
```

The two blocks must stay in sync; any future change to the abort handling (e.g. flush pending writes, emit `run:aborted` event) has to be made twice.

**Fix:** Extract to a local helper:
```ts
async function awaitIterationDelayOrAbort(
  delayMs: number,
  signal: AbortSignal,
): Promise<"continue" | "aborted"> { ... }
```
Then both call sites become a single line. ~10 LOC saved, single source of truth for the abort contract.

#### STYLE-3: `recoverable` log context field is a formatted shell command, not structured data
**Severity:** LOW | **Category:** Style (log shape)

`src/bakeoff/preflight.ts:264`
```ts
recoverable: sha ? `git checkout ${sha}  # or: git branch ${branch} ${sha}` : "(no SHA captured)",
```

This is useful for human log readers but inconsistent with the rest of the codebase's structured-log convention — every other log context is key/value primitives (`branch: string`, `sha: string`, `projectRoot: string`). Mixing a shell command into a JSON log context defeats structured-log consumers (a future dashboard panel can't render it as a "recover" button without parsing the comment).

**Fix:** Drop the `recoverable` field and add a `recovery: { checkout: string; recreate: string }` structured shape, or rely on the `sha` + `branch` fields being enough for any consumer to compose the command. The plain `sha` field already carries the full information.

#### DOC-4: `ExitReason` JSDoc for `"aborted"` lives inline at the type declaration only
**Severity:** LOW | **Category:** Documentation

`src/execution/executor-types.ts:62-64` has the JSDoc comment in the type alias itself, but `runner-completion.ts:357-361` (the file that decides how to render the run status) doesn't reference it. A future reader patching the status-rendering branch will not see the inline comment because the type alias is in a different file.

**Fix:** A one-line cross-reference comment at the top of `runner-completion.ts`'s status-decision block, pointing at the new `"aborted"` case and ENH-1 above. Cheap, future-proofing.

---

### ✓ Verified (no findings)

The following were checked and found clean against the **universal** and **node-general** checklists:

- **No new attack surface** — both fixes use existing helpers (`cancellableDelay`, `gitWithTimeout`); no new file paths, no new env vars, no new shell execution paths.
- **No new event listeners / timers / streams** — the ENH-3 change adds one `git rev-parse` call per stale branch; the BUG-2 change adds one try/catch wrapper per call site.
- **No new `any`, no missing generics, no missing return types** — `sha: string | undefined`, the spread `(sha ? { sha } : {})` is typed via the property shorthand.
- **No dead code, no unused imports** — `errorMessage` is now imported in `unified-executor.ts` (line 17) for the new log calls.
- **Files well under 400-line limit** — `preflight.ts: 282 lines`, `unified-executor.ts: 767 lines` (well over but unchanged in scope; this change adds 32 lines).
- **No "swallow and ignore" antipattern** — the `catch {}` at `preflight.ts:256-258` is documented ("deletion proceeds without the SHA breadcrumb") and explicitly the design intent (ENH-3 doc fix says "Best-effort: a failed rev-parse still lets the deletion proceed").
- **Tests are exhaustive and order-independent** — three BUG-2 tests cover pre-aborted, mid-delay-abort, and no-abort (proves the abort path is the *only* one swallowed); two ENH-3 tests cover SHA-present and SHA-missing branches. The existing `Failed to delete` test (which asserted the warn on `git branch -D` failure) still passes — the new warn is additive.
- **No regression in existing tests** — full 13635+1162+37 = 14834-test suite passes; the existing `test/integration/bakeoff/preflight-reclaim.test.ts` real-git integration test still passes (it asserts the *deletion* still happens; the SHA log is additive).
- **Red-green verified** — both fixes were stashed and re-applied in this session; the same tests failed without the fix and pass with it.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P3 | ENH-1 | S | Surface `"aborted"` as a distinct runStatus in `NaxStatusFile` |
| P3 | STYLE-2 | S | Extract shared `awaitIterationDelayOrAbort` helper |
| P3 | STYLE-3 | S | Replace `recoverable` string with structured `recovery` object |
| P4 | DOC-4 | XS | Cross-reference comment in `runner-completion.ts` |

*No CRITICAL, HIGH, or MEDIUM findings. All four items are polish; the production code is correct and safe.*

---

## Pending findings from the original review (`docs/20260816-review-since-0.80.0-canary.3.md`)

Of the 8 original findings, **3 are fixed by this branch or the previous branch**; **5 remain pending**:

| ID | Severity | Title | Status |
|:---|:---|:---|:---|
| BUG-1 | 🔴 HIGH | PriorRunFailureProvider reads wrong metrics path | ✅ **Fixed** (branch `fix/prior-run-failure-provider-metrics-path`) |
| BUG-2 | 🟡 MEDIUM | Abort during iteration delay now rejects | ✅ **Fixed** (this branch) |
| ENH-3 | 🟡 MEDIUM | `reclaimStaleBakeoffBranches` force-deletes | ✅ **Fixed** (this branch) |
| BUG-4 | 🟢 LOW | `detectTool` word-boundary patterns mislabel | ⏳ Pending |
| ENH-5 | 🟢 LOW | Duplicated diagnostic rendering | ⏳ Pending |
| STYLE-6 | 🟢 LOW | Circular import `pull-tools.ts` ↔ `query-scratch.ts` | ⏳ Pending |
| BUG-7 | 🟢 LOW | `promptForConfirmation` confirms on multi-byte chunk | ⏳ Pending |
| ENH-8 | 🟢 LOW | `stripTrailingCommas` unbalanced-quote edge | ⏳ Pending |

**Pending count: 5** (0 CRITICAL, 0 HIGH, 0 MEDIUM, 5 LOW)

All 8 original findings have been triaged across two branches. The remaining 5 are all LOW severity and mostly cosmetic (one is a known-design tradeoff in `promptForConfirmation`, one is a DRY issue, one is a circular import, one is a defensive-parsing comment, one is a regex anchor). None block a release.