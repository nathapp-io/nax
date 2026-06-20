# StoryOrchestrator Correctness Audit — 2026-06-20

> **Update (2026-06-20):** resolution progress —
> - **#5** (`routeTddFailure` exhaustiveness guard) + **#4** (`phaseCosts` restored on nbf rollback):
>   landed on `fix/story-orchestrator-should-fix` (merged, #1267).
> - **#1** (nbf snapshot throws into the verdict path) + **#2** (`full-suite-rectify` re-runs
>   `adversarial-review`): landed on `fix/story-orchestrator-nbf-snapshot-adversarial-staleness` (merged, #1268).
> - **#3** (staleness guard blind to keyless gate failures): landed on
>   `fix/staleness-guard-keyless-gate-failures` — keyless (timeout / execution-failure) gate failures
>   are now treated as regressions, closing the carve-out laundering path.
> - **#7** re-examined and intentionally left unchanged (the `undefined → pause` fallback is correct; see §7).
>
> **All must-fix items (#1, #2, #3) are now resolved.** **#8** resolved as documented (mechanical
> isolation check is advisory by design; verifier owns legitimacy — `fix/isolation-violation-producer`).
> Remaining open: only the LOW **#6** (sourceDiffCap added-only) and the documented-by-design **#9**.

> Scope: behavioral correctness of the per-story execution flow (`src/execution/story-orchestrator/`)
> and its collaborators — rectification, resume loops, the verifier-SSOT carve-out + staleness guard,
> the ADR-024 non-blocking fix, and failure categorization + tier escalation.
>
> Method: four independent audits, each reading the production code (not tests) and reasoning about
> edge cases, followed by direct source verification of the high-severity claims. This is a
> correctness review, **not** a test-coverage review.

## Verdict

The architecture is **sound and well-guarded** — the short-circuit RED→GREEN contract, loop bounds,
immutability, escalation budget/termination, and prior-failure threading are all correct. **No CRITICAL
defect.** The real issues cluster in two areas: **non-blocking-fix robustness** and the **staleness
guard's representational assumptions**. The highest-value fixes are #1, #2, and #3.

## Findings at a glance

| # | Severity | Type | Location | Status |
|---|----------|------|----------|--------|
| 1 | MEDIUM–HIGH | Confirmed bug | `non-blocking-fix.ts:158` | ✅ **Fixed** (`fix/story-orchestrator-nbf-snapshot-adversarial-staleness`) — snapshot capture wrapped; failure degrades to `ran:false`, never throws |
| 2 | MEDIUM | Confirmed bug | `story-orchestrator/types.ts:174-182` | ✅ **Fixed** (`fix/story-orchestrator-nbf-snapshot-adversarial-staleness`) — `adversarial-review` added to `full-suite-rectify` revalidation set |
| 3 | HIGH impact / conditional reach | Design weakness | `phase-eval.ts` (`gateRegressedAfterRectification`) | ✅ **Fixed** (`fix/staleness-guard-keyless-gate-failures`) — keyless (timeout/exec-fail) gate failures now treated as regressions |
| 4 | LOW–MEDIUM | Confirmed bug (metrics) | `non-blocking-fix.ts:195-217` | ✅ **Fixed** (`fix/story-orchestrator-should-fix`) — `phaseCosts` snapshotted at entry, restored on rollback |
| 5 | MEDIUM | Design gap | `pipeline/stages/execution-helpers.ts:64` | ✅ **Fixed** (`fix/story-orchestrator-should-fix`) — `routeTddFailure` now exhaustive (`satisfies never`) |
| 6 | LOW–MEDIUM | Design gap | `non-blocking-fix.ts:120-125` | **Open** — `sourceDiffCap` counts only *added* lines; a large *deleting* edit bypasses the cap |
| 7 | MEDIUM → LOW | Re-examined | `tdd-failure-category.ts:101` | ⏸️ **No change** — on inspection the `undefined → pause` fallback is correct; a richer category needs a design change (see below) |
| 8 | LOW | Design gap | `tdd-failure-category.ts:32` | ✅ **Resolved as documented** (`fix/isolation-violation-producer`) — mechanical isolation check is advisory by design; verifier owns legitimacy. Not a missing producer |
| 9 | LOW | Intentional asymmetry | `post-run.ts:245` | **Open** (by design) — TDD pauses vs non-TDD hard-fails for the same "review never ran" root cause |

Gating note: #1, #4, #6 only bite when the **non-blocking fix is enabled** (`review.adversarial.nonBlockingFix.enabled`, default `false`).

---

## Detailed findings

### 1. nbf `captureSnapshotRef` throws into the verdict path — Confirmed bug

`runNonBlockingFix` captures the rollback snapshot **before** its try/catch:

```ts
// non-blocking-fix.ts
const restoreRef = await _deps.captureSnapshotRef(args.workdir, args.storyId); // line 148 — OUTSIDE try
const maxAttempts = 1 + args.cfg.regressionAttempts;
let exhausted = false;
try {                                                                          // line 152
  const result = await args.runRectify(maxAttempts);
  ...
```

The module docstring (lines 131-134) promises the pass *"never throws into the caller's verdict path."*
But `captureSnapshotRef` runs `git rev-parse HEAD` and throws `NaxError(SNAPSHOT_REF_FAILED)` in a
non-git workdir or on a transient git failure. That throw propagates through
`_storyOrchestratorDeps.runNonBlockingFix` (`execution-plan.ts:226`) into `run()`, which has no
try/catch around the call — converting an **advisory best-effort pass into a hard story crash**.

Reproduced empirically: the e2e harness hit `SNAPSHOT_REF_FAILED` the first time nbf ran in a
non-git temp workdir (the e2e PR works around it by stubbing the git deps).

**Fix:** move the capture inside the try; on failure, log a warning and return
`{ ran: false, kept: false, restored: false }` (treat an unsnapshottable tree as "cannot run nbf",
never as a story failure).

> ✅ **Resolved** (`fix/story-orchestrator-nbf-snapshot-adversarial-staleness`). `captureSnapshotRef`
> is now wrapped in its own try/catch: a failure logs a warning and returns
> `{ ran: false, kept: false, restored: false }` — `runRectify` is never invoked (no rollback point),
> so the tree and `phaseOutputs`/`phaseCosts` are untouched. The "never throws into the caller's
> verdict path" contract now holds for non-git / git-flaky workdirs. Regression test:
> `non-blocking-fix.test.ts` — "snapshot capture fails → returns ran:false and does NOT throw".

### 2. `full-suite-rectify` edits tests but never re-runs adversarial-review — Confirmed bug

```ts
// story-orchestrator/types.ts — STRATEGY_TO_REVALIDATION_PHASES
"full-suite-rectify": ["lint-check", "typecheck-check", "full-suite-gate", "verifier", "verify-scoped", "semantic-review"],
//                      ^ no "adversarial-review"
```

`full-suite-rectify` is the strategy that **edits test code**. `adversarial-review` is the phase that
judges test quality/coverage. After this strategy rewrites tests, the post-rectification resume sees
`adversarial-review` already passing in `phaseOutputs` (`execution-plan.ts:123`) and **skips it**, so
the pre-rectification adversarial verdict is read as current against rewritten tests.

**Fix:** add `"adversarial-review"` to the `full-suite-rectify` revalidation set. (Alternative:
force-rerun reviews in the resume whenever rectification edited tests, instead of trusting a prior pass.)

> ✅ **Resolved** (`fix/story-orchestrator-nbf-snapshot-adversarial-staleness`). `adversarial-review`
> added to `STRATEGY_TO_REVALIDATION_PHASES["full-suite-rectify"]`, so editing tests now re-runs the
> review that judges them. **Ripple (intended):** three tests that encoded the old exclusion were
> updated — `story-orchestrator-revalidation.test.ts` (AC3.4 now asserts adversarial *included*),
> `story-orchestrator-carveout-staleness.test.ts` (the completeness-guard repro now uses
> `mechanical-lintfix`, the realistic strategy that still excludes a review), and the
> `resume.e2e.test.ts` scenario (a persistent-red-gate story under full-suite-rectify is now *fully*
> review-judged → the verifier-SSOT carve-out PASS path, repurposed as the #2 regression). This
> closes the US-002 "silent pass without adversarial judgment" gap at the source for full-suite-rectify.

### 3. Staleness guard is blind to keyless gate failures — Design weakness (high impact)

The verifier-SSOT carve-out exempts a still-red full-suite-gate when the verifier passed, *unless*
rectification introduced a **new** gate failure. "New" is computed by diffing failing-test identity keys:

```ts
// phase-eval.ts
keys.add(`${f.file ?? ""}::${f.rule ?? ""}`);  // only for source === "test-runner"

// execution-plan.ts
const gateRegressedDuringRect =
  gateName !== undefined &&
  [...gateFailureKeys(phaseOutputs[gateName])].some((k) => !preRectGateFailureKeys.has(k));
```

But gate failures legitimately change *representation* between runs:

- **Timeout** → `findings: []` → empty key set → `[].some(...)` is **always `false`**.
- **Execution-failure** (non-zero exit, no structured failures) → one synth finding with **no `file`/`rule`**
  (`findings/adapters/test-runner.ts:42-54`) → key `"::"`.

So a gate that regresses into a *keyless* form (timeout/exec-fail) produces no "new" key, the staleness
guard reads `false`, and with the verifier passed the carve-out exempts a **genuinely red full suite**
→ `success = true`. Two distinct execution-failures also collide to `"::"`.

**Reachability caveat (honest):** the gate-before-verifier canonical ordering + short-circuit +
nbf-restore semantics block most paths, so a complete *live* trigger was not proven without nbf
enabled. Classified as a real **latent fragility to harden**, not a proven live exploit. The blind
spot itself is verified.

**Fix:** compare gate **pass/fail status**, not just key identity. If the baseline gate was
green/passing and the final gate is failing in *any* representation, treat the verdict as stale
(revoke the exemption). Fold timeout / execution-failure / `failed>0-but-empty-findings` into the
regression signal explicitly rather than relying on extractable keys.

> ✅ **Resolved** (`fix/staleness-guard-keyless-gate-failures`). Extracted a pure
> `gateRegressedAfterRectification(finalGateOutput, baselineKeys, gateName, storyId?)` in
> `phase-eval.ts` and routed the carve-out's `gateRegressedDuringRect` through it. It returns false
> when the final gate is green; when failing, it flags a regression if EITHER a structured failure key
> is absent from the baseline (the original precise diff) **OR** the failure is keyless — a timeout
> (`findings: []` → empty key set) or an execution-failure (synth key `"::"`). A keyless failure yields
> no identity to prove it is the pre-existing failure the verifier blessed, so it conservatively counts
> as a regression rather than being laundered into a pass. The structured-subset carve-out (legit
> pre-existing failures) is preserved unchanged. Tests: five pure-function cases (green, subset, new
> key, timeout, execution-failure) plus an end-to-end `ExecutionPlan.run` case proving a timeout
> regression now fails the story instead of passing via the carve-out.
>
> **Scope note:** this closes the keyless-key blind spot. The deeper Finding 3 concern (baseline is
> captured at main-loop end, not at verifier-pass time) is unchanged and remains a latent design point;
> the conservative keyless handling de-risks it, but a full fix would re-anchor the baseline.

### 4. phaseCosts not restored on nbf rollback — Confirmed bug (metrics only)

`restoreToSnapshot` (`non-blocking-fix.ts:195-213`) reverts the git tree and `phaseOutputs` in place
but never touches `phaseCosts`. The nbf rectify pass accrues cost under the same op names
(`run-phase.ts` accumulates `phaseCosts[opName] += ...`), so a *rolled-back* pass still inflates
`totalCostUsd` and the returned `phaseCosts` — asymmetric with the restored outputs. Verdict is
unaffected; only metrics are wrong.

**Fix:** snapshot `phaseCosts` at nbf entry and restore it alongside `phaseOutputs` on rollback — or,
since the runtime discards nbf's `{ran,kept,restored}` return, surface that outcome and subtract the
wasted cost / emit an nbf-attribution metric.

> ✅ **Resolved** (`fix/story-orchestrator-should-fix`). `NonBlockingFixArgs` now carries `phaseCosts`;
> `runNonBlockingFix` snapshots it at entry (`{ ...args.phaseCosts }`) and `restoreToSnapshot` reverts
> it in place alongside `phaseOutputs`, so a discarded pass leaves the result's per-phase cost
> breakdown symmetric with its outputs. True total spend is unaffected — it lives in the cost
> middleware / `CostAggregator` (the SSOT); this only corrects the diagnostic per-phase split.
> Regression tests: `non-blocking-fix.test.ts` — "restored → phaseCosts rolled back…" and
> "kept → phaseCosts retains…".

### 5. `routeTddFailure` lacks an exhaustiveness guard — Design gap

`resolveMaxAttemptsOutcome` ends with a `satisfies never` exhaustiveness check; its sibling
`routeTddFailure` (`execution-helpers.ts:102-105`) does not, and its fall-through silently returns
`{ action: "pause" }`. A future `FailureCategory` added to the union compiles clean and silently routes
to human-pause on this terminal path while the other path is compiler-checked. Asymmetric safety.

**Fix:** add a `satisfies never` default branch to `routeTddFailure` mirroring `resolveMaxAttemptsOutcome`.

> ✅ **Resolved** (`fix/story-orchestrator-should-fix`). `routeTddFailure` was restructured into an
> exhaustive `switch` over `FailureCategory` with a `satisfies never` default, mirroring
> `resolveMaxAttemptsOutcome`. **Behavior is identical**: `undefined` and `dependency-prep` both still
> resolve to `pause` (now handled explicitly), every escalate-category is unchanged, and a runtime
> `"unknown"` string still falls through to `pause`. A new `FailureCategory` member now fails
> compilation until routed. Regression test added: `execution-stage.test.ts` — "pauses on
> dependency-prep…".

### 6. `sourceDiffCap` counts only added lines — Design gap

`createMeasureSourceDiff` (`non-blocking-fix.ts:120-125`) sums **added** lines and discards deletions.
A best-effort fix that *deletes* 500 unreviewed source lines and adds 3 passes the `maxLines` cap
trivially. The un-reviewed-edit safety rail is add-biased.

**Fix:** count `added + deleted` (or `max(added, deleted)`) against `maxLines`.

### 7. verifier-passed + red-gate + reviews-ran → `undefined` category — Re-examined, no change

In `deriveTddFailureCategory`, `verifierPassed` short-circuits the gate-derived branches
(`full-suite-gate-exhausted`, `tests-failing`). The original concern was that a verifier-passed story
which still failed would fall through to `undefined` (`tdd-failure-category.ts:101`) and route through
a degraded disposition.

> ⏸️ **Re-examined during the fix pass — no code change.** Tracing the reachable states shows the
> `undefined` fallback is **correct**, not a defect:
>
> - When the verifier passed (`verifierPassed = verifier.success && !gateRegressedDuringRect`), the
>   full-suite-gate is **exempted** from success aggregation (`execution-plan.ts:320`). So a red gate
>   *alone* yields `success = true` — no category is needed.
> - Therefore reaching `deriveTddFailureCategory` with `verifierPassed === true` requires `success` to
>   be false for a **non-gate** reason: an unfixed `lint`/`typecheck` finding, or a failing
>   semantic/adversarial review. Suppressing the *gate* categories in that case is correct — the gate
>   is not the cause and was deliberately exempted.
> - There is **no TDD category** that fits "a quality check / review couldn't be greened." `undefined`
>   then routes via `routeTddFailure(undefined)` → `pause` (human review), which is a defensible
>   terminal disposition for an uncategorizable quality failure. (Note the earlier audit's
>   "escalate-then-fail" description was imprecise: the per-attempt path pauses.)
>
> Assigning a *richer* category here would mean inventing a new `FailureCategory` (e.g.
> `quality-gate-exhausted`) and deciding its pause/escalate semantics across `routeTddFailure` and
> `resolveMaxAttemptsOutcome` — a **design change**, not a robustness fix, and out of scope for this
> pass. Downgraded **MEDIUM → LOW** and left as documented behavior. If the asymmetry with #9 is
> later deemed undesirable, the right move is a dedicated quality-failure category, decided jointly
> with #9.

### 8. `isolation-violation` handling appears dead for the verifier path — Design gap

`categorizeVerdict` only ever emits `verifier-rejected` / `tests-failing`, never `isolation-violation`,
yet `decideStageAction` (`post-run.ts:71`, `shouldRollbackTddFailure`) and `routeTddFailure` both
special-case `isolation-violation`. If no producer stamps it on the verifier path, a verifier-detected
isolation breach is miscategorized as `verifier-rejected` (which still pauses on exhaustion, limiting
blast radius).

**Fix:** confirm the producer. If isolation violations are only stamped by the test-writer/implementer
isolation gates (not the verifier), document that; otherwise wire `categorizeVerdict` to emit it.

> ✅ **Resolved as documented** (`fix/isolation-violation-producer`). Investigation confirmed
> `"isolation-violation"` has **no producer** anywhere in `src/` — but this is **by design, not a bug
> to wire**. The *mechanical* isolation check (`verifyTestWriterIsolation` /
> `verifyImplementerIsolation`) detects which files changed but **cannot judge legitimacy** (a stub in
> `src/` may be required); only the verifier can. So `run-phase.ts` logs a mechanical violation as
> **advisory** — it never flips phase success or stamps the category. Legitimacy is owned by the
> verifier, which emits `verifier-rejected` for illegitimate test edits (`tdd/verdict.ts`). Wiring the
> mechanical check to fail runs would punish violations the verifier might deem legitimate (and would
> add escalation churn after long dormancy), so we deliberately do **not**. The consumer machinery
> (`deriveTddFailureCategory` passthrough, `routeTddFailure` → escalate + `retryAsLite`, tier → pause,
> `shouldRollbackTddFailure`) is **not dead** — it stays wired for a verifier- or plugin-driven producer
> that *can* assess legitimacy; `deriveTddFailureCategory` already passes through
> `verifierOutput.failureCategory`. Documented at the two key sites (`run-phase.ts` advisory log,
> `types.ts` `FailureCategory` definition) so it is not re-flagged as a missing producer. No runtime
> behavior change.
>
> **Follow-up — can the verifier produce it?** Investigated whether `categorizeVerdict` could emit
> `isolation-violation` instead of folding cases into `verifier-rejected`. It **structurally cannot**:
> the `VerifierVerdict` (`tdd/verdict.ts`) reviews the *implementer*, not the test-writer, and has no
> field describing test-writer-wrote-source. Its only isolation-adjacent signal, `testModifications`
> (the implementer editing tests), correctly maps to `verifier-rejected` — routing it to
> `isolation-violation` would be wrong, because that category escalates with `retryAsLite=true`, which
> *relaxes* isolation on retry (the opposite of enforcing "don't edit tests"). A genuine producer would
> require **new verifier scope** — a verdict field where the verifier judges the test-writer's isolation
> legitimacy — which is a feature well beyond this LOW item. Conclusion: the category is producer-less by
> design *and structural necessity*, not oversight. Left as documented.

### 9. TDD vs non-TDD review-incomplete disposition asymmetry — Intentional, documented

`applyPostRunInspection` only derives a `failureCategory` (and thus the `review-incomplete` → `pause`)
when `isTdd`. A non-TDD story whose configured review never ran hard-**fails** instead of pausing
(`post-run.ts:240-253`). Same root cause ("review skipped"), different terminal disposition. Documented
and intentional, but a real semantic asymmetry.

**Fix (optional):** route non-TDD `missingRequiredReviewPhases` through the same `review-incomplete`
disposition so the pause/fail decision doesn't depend on strategy.

---

## Verified sound (no action)

- Short-circuit RED→GREEN contract — reviews never judge a broken gate inside a rectification sweep.
- All three resume loops are bounded: `resumeRectifyUsed` is one-shot per story; `runFixCycle` is
  bounded by `maxAttemptsTotal` + per-strategy `maxAttempts`. No unbounded loop.
- No cost double-counting on legitimate re-runs (each `runPhase` opens a fresh cost scope).
- Escalation mechanics: `story.routing` is **not** mutated in place — the PRD is rebuilt immutably via
  `userStories.map(...)`; `calculateMaxIterations` is a correct total-budget ceiling; `escalateTier`
  returns `null` at the last rung (no infinite escalation).
- `unresolvedDetail` / `priorFailures` threading: carried into the next tier intact, capped at 3, no drop.
- Carve-out vs `missingRequiredReviewPhases` precedence: the `&&` correctly forbids laundering a story
  that skipped configured reviews.

---

## Recommended fix plan

**Must-fix (correctness, concrete, high confidence):**

1. ✅ **#1 — nbf snapshot throw** — **DONE** (`fix/story-orchestrator-nbf-snapshot-adversarial-staleness`).
   `captureSnapshotRef` wrapped; failure degrades to `ran:false`, never throws.
2. ✅ **#2 — adversarial-review staleness** — **DONE** (same branch). `adversarial-review` added to the
   `full-suite-rectify` revalidation set; three dependent tests updated.
3. ✅ **#3 — staleness guard status comparison** — **DONE** (`fix/staleness-guard-keyless-gate-failures`).
   `gateRegressedAfterRectification` now treats keyless (timeout/exec-fail) gate failures as regressions;
   pure-function + end-to-end tests added.

**Should-fix (robustness / disposition):**

4. ✅ **#5 — `routeTddFailure` exhaustiveness guard** — **DONE** (`fix/story-orchestrator-should-fix`).
   Behavior-preserving refactor to an exhaustive `switch` + `satisfies never`.
5. ⏸️ **#7 — gate category under verifier-passed** — **re-examined, no change.** The `undefined → pause`
   fallback is correct; a richer category is a design change (new `FailureCategory`), out of scope. See §7.
6. ✅ **#4 — restore `phaseCosts` on nbf rollback** — **DONE** (`fix/story-orchestrator-should-fix`).
   Snapshot at entry + in-place restore on rollback; cost SSOT (`CostAggregator`) unaffected.

**Nice-to-have — still OPEN:**

7. **#6 — count deletions in `sourceDiffCap`.**
8. **#8 — confirm/wire `isolation-violation` producer.**
9. **#9 — unify non-TDD review-incomplete disposition** (if the asymmetry is undesired; decide jointly with #7).

**Remaining work:** all must-fix items are resolved. Open items are LOW nice-to-haves — **#6** (count
deletions in `sourceDiffCap`), **#8** (confirm/wire the `isolation-violation` producer) — plus the
documented-by-design **#9**. None are blocking.

> All findings are in **production** code and pre-date the e2e coverage PR (#1266); that PR's tests are
> correct and independent of these fixes.
