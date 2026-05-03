# Issue #808 Fix Plan — Autofix no-op detection and stale-failure carry-forward

**Date:** 2026-05-03
**Status:** Pre-implementation — settles scope before PR work begins
**Scope:** Two narrow fixes in `src/pipeline/stages/autofix-agent.ts` to stop the no-op verify path from (a) firing when the agent actually edited files but didn't commit, and (b) re-emitting the cycle-start failure set when fresh failures are available
**Issue:** [#808](https://github.com/nathapp-io/nax/issues/808) (umbrella for autofix no-op classification)
**Related issues:** [#812](https://github.com/nathapp-io/nax/pull/812) (recheck-before-no-op — merged), [#736](https://github.com/nathapp-io/nax/issues/736) (adversarial goalpost-moving — distinct, compounds once findings reach the agent)
**ADR coordination:** [ADR-021](../adr/ADR-021-findings-and-fix-strategy-ssot.md) wire-format migration, [ADR-022](../adr/ADR-022-fix-strategy-and-cycle.md) `runFixCycle` migration — see §5

---

## 1. Problem statement

The autofix loop in `runAgentRectification` ([src/pipeline/stages/autofix-agent.ts](../../src/pipeline/stages/autofix-agent.ts)) makes two mistakes that compound during real dogfood runs.

### 1.1 Mistake A — `noOp` detected against pre-auto-commit ref

[autofix-agent.ts:446-449](../../src/pipeline/stages/autofix-agent.ts#L446-L449):

```typescript
const refAfterAttempt = await _autofixDeps.captureGitRef(ctx.workdir);
const sourceFilesChanged =
  autofixBeforeRef === undefined || refAfterAttempt === undefined || autofixBeforeRef !== refAfterAttempt;
const noOp = !sourceFilesChanged;
```

This runs **immediately after** the implementer agent returns, but **before** `verify()` calls `recheckReview(ctx)`. `recheckReview` invokes the review stage, which calls `autoCommitIfDirty` ([src/review/runner.ts:262](../../src/review/runner.ts#L262)). Therefore: if the agent edits files but doesn't run `git commit` itself, `captureGitRef` sees an unchanged HEAD and reports `noOp = true` — even though the work landed and the review-stage auto-commit will pick it up moments later.

### 1.2 Mistake B — no-op branches discard freshly observed failures

[autofix-agent.ts:519](../../src/pipeline/stages/autofix-agent.ts#L519) and [:537](../../src/pipeline/stages/autofix-agent.ts#L537):

```typescript
if (result.consecutiveNoOps > MAX_CONSECUTIVE_NOOP_REPROMPTS) {
  …
  return { passed: false, newFailure: initialFailure };   // ← stale
}
if (result.noOp) {
  …
  return { passed: false, newFailure: initialFailure };   // ← stale
}
```

`initialFailure` is captured at the start of the cycle. By the time these lines execute, `recheckReview` has already run and updated `ctx.reviewResult` — possibly to a completely different failure set (e.g. build went `fail → pass`, adversarial went `pass → fail`). Re-emitting the cycle-start failure feeds the implementer the wrong prompt on the next attempt.

The two mistakes cooperate: A sets `noOp = true` falsely, B then routes through the no-op branch and discards the truth.

### 1.3 Observed in production

Run: `logs/memory-phase4-graph-code-intelligence/runs/2026-05-02T16-32-35.jsonl`, US-001, cycle 1 (17:46–18:04).

| Time | Event | Implementer prompt body |
|:---|:---|:---|
| 17:46:07 | Build fails. `initialFailure = [build error]`. | n/a |
| 17:46:44 | Attempt 1 returns. Agent edited Prisma schema, **no commit**. `noOp = true`. `recheckReview` auto-commits → build passes, adversarial fails (5 errors). Verify takes no-op branch → returns `initialFailure`. | (attempt 1 was the original prompt — build error) |
| 17:51:15 | Attempt 2 prompt sent. Body: `noOpReprompt(initialFailure.checks)` — **only the original build error**. Agent replies *"Build passes now, let me verify"*. No-op again. | Build error only |
| 18:00:52 | Attempt 3 prompt sent. Same body. Agent does Turbo-cache-bust trick (576 s wasted). | Build error only |
| 18:04:31 | Cycle 1 ends after 3 wasted attempts. Partial-progress retry → cycle 2. | n/a |
| 18:35:47 | Cycle 2 / attempt 4 finally has the 5 adversarial findings. | Adversarial findings |

Three attempts and ~14 minutes spent re-fixing an already-fixed build error while real findings sat in `ctx.reviewResult`.

### 1.4 Case table (extends the table in #808)

| # | Cause | HEAD | Staged | Untracked | Modified-not-staged | Today's behaviour |
|:---|:---|:---:|:---:|:---:|:---:|:---|
| 1 | Bare install (e.g. `bun install`) | unchanged | none | maybe `node_modules/` | none | wrong reprompt |
| 2 | Staged but not committed | unchanged | yes | none | none | generic reprompt |
| 3 | Transient diagnostic (cache cleared on re-run) | unchanged | none | none | none | wrong reprompt — fixed by [#812](https://github.com/nathapp-io/nax/pull/812) |
| 4 | Prior commit already covers fix | unchanged | none | none | none | wrong reprompt — fixed by [#812](https://github.com/nathapp-io/nax/pull/812) |
| **5** | **Agent edited without committing; review's `autoCommitIfDirty` settles it during `recheckReview` → state advances; recheck surfaces a different failure** | **unchanged at `noOp` time** | **none** | **none** | **yes** | **`noOp=true` fires; verify discards fresh failures, re-sends `initialFailure`** |

#812's recheck-before-no-op fix did not cover case 5 because `recheck` *does* run and *does* return failing — the bug is in what `verify()` does next.

---

## 2. Root cause

Two independent defects layered on top of each other:

| Defect | Location | Why it's wrong |
|:---|:---|:---|
| Stale `noOp` signal | `autofix-agent.ts:446-449` (capture) and `:524` (read) | The signal is computed against a git ref captured before the review stage's auto-commit runs. For the common case "agent edits, doesn't commit", it's a false positive. |
| Stale `newFailure` carry-forward | `autofix-agent.ts:519`, `:537` | The whole point of `verify()` running `recheckReview` is to read fresh state — the no-op branch then throws that fresh state away and re-emits the cycle-start failure set. |

Either fix alone helps; both fix the observed case. They live in the same function and must land together to pass review.

---

## 3. Proposed fix

Two surgical edits in `src/pipeline/stages/autofix-agent.ts`. No new types, no contract changes, no flag.

### 3.1 Defect 1 — broaden `noOp` detection signal

Replace the HEAD-only check with a "did the agent leave any work in the tree?" check. The review stage's auto-commit will pick up uncommitted edits, so the right question is "did anything change at all", not "did the agent commit".

```typescript
// src/utils/git.ts — new helper
export async function hasWorkingTreeChange(
  workdir: string,
  baseRef: string | undefined,
): Promise<boolean> {
  if (baseRef === undefined) return false;
  const headProc = _gitDeps.spawn(["git", "rev-parse", "HEAD"], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
  const head = (await new Response(headProc.stdout).text()).trim();
  await headProc.exited;
  if (head && head !== baseRef) return true;

  // HEAD unchanged — check porcelain for staged, untracked, or modified-not-staged.
  const statusProc = _gitDeps.spawn(["git", "status", "--porcelain"], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
  const status = (await new Response(statusProc.stdout).text()).trim();
  await statusProc.exited;
  return status.length > 0;
}
```

`autofix-agent.ts:446-449` becomes:

```typescript
const sourceFilesChanged = await _autofixDeps.hasWorkingTreeChange(ctx.workdir, autofixBeforeRef);
const noOp = !sourceFilesChanged;
```

`_autofixDeps` extends to inject the helper for unit tests.

**Note on case 1 (bare install):** `node_modules/` is `.gitignore`d in every project we orchestrate, so `git status --porcelain` does not list it. Bare-install runs that don't touch a manifest will still register as `noOp = true` — which is correct; the agent did no commit-able work. The reprompt vocabulary (already updated in #809/#812) correctly tells the agent to add the dependency to a manifest, not just install.

### 3.2 Defect 2 — propagate freshly observed failures, not `initialFailure`

Add a small helper inside the verify closure and use it at both no-op return sites:

```typescript
// At top of verify(), after recheckReview decision:
const collectFresh = (): AutofixFailure => {
  const updated = collectFailedChecks(ctx);
  if (updated.length === 0) return initialFailure;   // safety net — rare
  return { checks: updated, checkSignature: getCheckSignature(updated) };
};

// Line 517-520 (no-op limit reached):
return { passed: false, newFailure: collectFresh() };

// Line 535-538 (no-op reprompt path):
return { passed: false, newFailure: collectFresh() };
```

The fallback to `initialFailure` when `updated.length === 0` covers the genuinely rare case where `recheckReview` returns failing but `collectFailedChecks` finds nothing (only happens with the adversarial fail-open path, already specially handled by `failOpenAborted` further down).

### 3.3 Diff size estimate

| File | Lines added | Lines removed |
|:---|---:|---:|
| `src/utils/git.ts` | ~20 | 0 |
| `src/pipeline/stages/autofix-agent.ts` | ~15 | ~6 |
| `test/unit/pipeline/stages/autofix-agent.test.ts` | ~120 | 0 |
| `test/unit/utils/git.test.ts` | ~40 | 0 |

Total ~195 LOC, single-PR scope.

---

## 4. Tests

All tests use the existing `_autofixDeps` injection pattern. No `mock.module()` (banned by `forbidden-patterns.md`).

### 4.1 New unit tests in `test/unit/utils/git.test.ts`

| Test | Setup | Expect |
|:---|:---|:---|
| `hasWorkingTreeChange returns true when HEAD advances` | seed temp git repo, base ref, commit | `true` |
| `hasWorkingTreeChange returns true when porcelain non-empty (modified)` | seed repo, base ref, edit tracked file (no stage) | `true` |
| `hasWorkingTreeChange returns true when porcelain non-empty (staged)` | seed repo, base ref, edit + `git add` | `true` |
| `hasWorkingTreeChange returns true when porcelain non-empty (untracked)` | seed repo, base ref, write a new file | `true` |
| `hasWorkingTreeChange returns false on clean tree, HEAD unchanged` | seed repo, base ref, no edits | `false` |
| `hasWorkingTreeChange returns false when baseRef undefined` | n/a | `false` (preserves existing fail-open behaviour from `captureGitRef`) |

Use `test/helpers/temp.ts` for repo scaffolding. Do not invoke real `git` binary — inject `_gitDeps.spawn` with a fake that returns canned `Bun.spawn`-shaped results.

### 4.2 New unit tests in `test/unit/pipeline/stages/autofix-agent.test.ts`

| Test name | Scenario | Assertion |
|:---|:---|:---|
| `verify keeps fresh failures when recheck flips build:fail → adversarial:fail` | initialFailure = `[build]`; agent edits without commit; mock `hasWorkingTreeChange` to return `true`; `recheckReview` flips `ctx.reviewResult` to adversarial-failing | second-attempt `buildPrompt` is called with `failure.checks` containing adversarial, **not** the build error |
| `verify keeps fresh failures on no-op branch when recheck still fails for a different reason` | force `noOp=true`; recheck flips build:fail → adversarial:fail | same as above |
| `verify falls back to initialFailure when recheck returns failing but collectFailedChecks empty (fail-open)` | force adversarial fail-open path | `failOpenAborted` triggers, no stale prompt sent |
| `noOp=false when agent leaves untracked file` | inject `hasWorkingTreeChange` returning `true` for untracked-only state | `result.noOp` is `false`; non-noOp branch runs |
| `noOp=true when working tree fully clean and HEAD unchanged` | inject `hasWorkingTreeChange` returning `false` | `result.noOp` is `true`; no-op branch runs |

### 4.3 Integration regression test

`test/integration/autofix/issue-808-stale-failure-carryforward.test.ts` — replays the dogfood scenario at the pipeline level using the existing in-process review/autofix harness. Asserts that across 2 attempts, the second prompt's body contains the post-recheck failure set. Skip if the harness can't simulate auto-commit; the unit tests cover correctness.

---

## 5. Coordination with ADR-021 / ADR-022

Both ADRs touch the same code path. This fix must land **before** the V2 cycle path takes over and must not block ADR-021/022 phases.

### 5.1 Where the bug lives in the migration timeline

| Path | Status | Vulnerable? |
|:---|:---|:---|
| Legacy `runAgentRectification` (today) | Lives until ADR-022 phase 8 cleanup | **Yes** — both defects |
| ADR-022 phase 7 V2 (`runFixCycle`-driven, behind `quality.autofix.cycleV2` flag) | Default off, two-release shadow soak after phase 7 ships | **No** by design — see §5.2 |
| ADR-022 phase 8 cleanup | Deletes legacy path, renames V2 to canonical | n/a |

**Estimated lifetime of legacy path after this fix lands:**
- ADR-022 phase 7 PR — 1 release
- Phase 7 shadow soak — 2 releases
- Phase 8 cleanup — 1 release
- Total: 3–4 releases of dogfood and external users running the legacy path.

The fix is worth the small patch.

### 5.2 Why V2 (`runFixCycle`) is structurally immune

ADR-022 [§9 Phase 7](./2026-05-02-adr-022-implementation-plan.md#9-phase-7--autofix-migration) replaces the failure-carry-forward shape entirely:

```typescript
// V2 path — paraphrased from ADR-022 phase 7
const cycle: FixCycle<Finding> = {
  name: "autofix",
  findings,
  iterations: ctx.autofixPriorIterations ?? [],
  validate: async (cycleCtx) => {
    const review = await _autofixDeps.recheckReview(ctx);
    return review.findings ?? [];   // ← always fresh
  },
  …
};
const result = await runFixCycle(cycle, fixCallCtx(ctx));
```

The validator returns `Finding[]` directly. There is no `initialFailure` analogue to discard, no separate `noOp` heuristic — `classifyOutcome` derives `IterationOutcome` ∈ `{resolved, partial, regressed, unchanged, regressed-different-source}` from the validator's pre/post diff. By the time `validate()` runs, `recheckReview` has already auto-committed; the validator's view of state is post-settled.

So both defects vanish in V2 — but only because the architecture changes. The fix here covers the legacy path until phase 8 deletes it.

### 5.3 Contract test that locks in the invariant for both paths

Add `test/contract/autofix/fresh-failure-propagation.contract.test.ts`. Runs the same scenario against:

1. Today's legacy `runAgentRectification` (after this fix lands)
2. The future V2 `runAgentRectificationV2` (after ADR-022 phase 7 lands; test is `.skip`'d until then)

Asserts the same invariant for both: when `recheckReview` flips the failure set, the next strategy invocation receives the post-recheck findings.

This is the long-term insurance. When ADR-022 phase 8 deletes the legacy branch, only the V2 assertion remains and the contract test stays green. Drop the legacy branch from the contract test in the same PR as phase 8 cleanup.

### 5.4 Sequencing with ADR-021 producer migrations

ADR-021 phases 2–7 migrate each producer (lint, typecheck, adversarial, semantic, …) to emit `Finding[]`. None of them touch `autofix-agent.ts` directly — they update producer adapters in `src/review/`, `src/quality/`, `src/findings/adapters/`. This fix is independent and can land in any order relative to ADR-021 phases 2–7.

ADR-022 phases 1–6 also do not touch `autofix-agent.ts`. This fix can land in parallel with any of them.

**Constraint:** ADR-022 phase 7 must rebase over this fix. Phase 7 modifies `runAgentRectification` to be a wrapper that constructs strategies and invokes `runFixCycle`. If this fix lands first, the no-op-branch lines we touch are deleted as part of phase 7 — so the conflict is mechanical (delete vs delete) rather than semantic. Phase 7 author should be aware of the invariant from §5.3 when authoring V2.

### 5.5 Decision: fix legacy now, contract test for both

| Option | Verdict |
|:---|:---|
| Fix legacy only | Picked. Real users on next 3–4 releases benefit. Fix is small enough that it doesn't slow phase 7. |
| Skip legacy, fix only V2 | Rejected. 3–4 releases of dogfood pain for what is a 2-line fix. |
| Fix legacy + add contract test for both paths | **Picked.** Invariant locked in for the V2 era too. |

---

## 6. Validation gate

Per project standards (`.claude/rules/project-conventions.md`):

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` (Biome) passes
- [ ] Pre-commit hooks pass (process-cwd, adapter-wrap, dispatch-context)
- [ ] All new logger calls have `storyId` as first key
- [ ] No `process.cwd()` outside CLI entry points
- [ ] No internal-path imports — barrel only
- [ ] No `mock.module()`; only `_autofixDeps` / `_gitDeps` injection
- [ ] All test files ≤800 lines (split if approaching)
- [ ] PR refs `#808`
- [ ] Contract test in §5.3 runs (legacy assertion only until phase 7 lands)

Manual smoke:

- [ ] Re-run the koda dogfood feature `memory-phase4-graph-code-intelligence` on the fix branch
- [ ] Confirm the cycle-1 attempt-2 prompt audit contains adversarial findings, not the original build error
- [ ] Confirm cycle terminates in ≤2 iterations (down from 5+)

---

## 7. Rollout

Single PR, no flag. Both defects land together; splitting them creates an awkward intermediate state where Defect 1 is fixed but Defect 2 still discards the fresh failures the better detection now correctly produces.

**PR title:** `fix(autofix): broaden no-op detection and stop discarding fresh failures (#808)`

**PR description template:**

```
Fixes two layered defects in runAgentRectification observed in koda
dogfood (US-001 cycle 1 — 3 attempts wasted, ~14 min):

1. noOp detection used HEAD-only ref comparison, captured BEFORE the
   review stage's auto-commit. Agent edits without commit triggered
   false-positive noOp.

2. No-op branches in verify() returned `initialFailure` instead of
   the failure set just collected by recheckReview, so the next prompt
   re-asked the implementer to fix already-fixed problems.

Both defects layer: the false-positive noOp routed through a branch
that discards the truth.

Replaces the HEAD-only ref check with `git status --porcelain` +
HEAD comparison via new `hasWorkingTreeChange` helper. Threads
freshly-collected `updatedFailed` through both no-op return sites.

Adds unit tests for both defects + contract test that locks the
invariant in for the future ADR-022 phase 7 cycle path.

Refs: #808
Coordination: docs/specs/2026-05-03-issue-808-autofix-noop-fix-plan.md
```

---

## 8. Rollback

Single `git revert` of the fix PR. Restores legacy behaviour. The contract test in §5.3 will fail after revert — disable it in the revert commit until a re-fix lands.

---

## 9. Out of scope

- **#736 (adversarial goalpost-moving):** distinct issue, compounds this one once findings reach the agent, but the proximate cause of the wasted cycle-1 attempts is this bug, not #736. Tracked separately.
- **Reprompt vocabulary improvements:** already handled by #809 and #812.
- **`runFixCycle` migration itself:** ADR-022 phase 7. This fix is the bridge; phase 7 is the bridge's other side.
- **Per-producer `Finding[]` migration:** ADR-021 phases 2–7. Independent.
