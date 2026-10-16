# ADR-034: Workflow Execution Mode

**Status:** Accepted, 2026-10-16 (default since v0.88.0)
**Supersedes (as the default path):** the story pipeline of ADR-005 / ADR-023 for `nax run`; the pipeline stays in the code as `execution.mode: "pipeline"`, deprecated and frozen
**Builds on:** ADR-021 (Finding Type SSOT), ADR-024 (Non-Blocking Adversarial Fix), ADR-028 (Native Sessions and Tool Loop), ADR-033 (Scoped Fix Review)
**Related:** #2475-#2478 (A5 PR1-PR4), #2479, #2496, #2497, #2547, #2548, #2550, #2558 (default flip)
**Design:** [`docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md`](../superpowers/specs/2026-10-12-a5-workflow-mode-design.md)
**Implementation:** `packages/nax/src/workflow/`, `packages/nax/src/config/schemas-workflow.ts`, `packages/nax/src/config/workflow-mode.ts`

---

## Context

The story pipeline splits one story across many sessions: a test-writer, an implementer, a verifier,
then a semantic and an adversarial review, a non-blocking fix (NBF) with its worth-check, the
acceptance stage, and finally a multi-round finish review. Each session re-reads the same code.
Measured on real features in 2026-10:

- **Quality.** The layered reviewers did not converge. Each lens raised new HIGH findings that the
  lens before it had passed, and a fresh whole-branch review still found HIGH spec findings after
  per-story semantic + adversarial review and three finish rounds.
- **Tokens.** Most spend went to sessions re-reading the code and to the review/fix loops outside the
  implementer, not to the implementer itself.
- **Time.** Acceptance plus finish added 1.2-2.7 h on top of the stories.
- **Stalls.** Contradictions between spec, ACs and code stopped the run for a human.

The A1-A4 work (advisor, NBF triage, finish as a branch review) removed the stalls but kept the
session count. Patching the pipeline further was stopped in favour of a different shape.

## Decision

Add a **workflow execution mode** and make it the default for `nax run`. It is modelled on a
controller-driven subagent workflow: one fresh, full-power implementer per story, a bounded review
loop, and one whole-branch review.

### 1. Ownership split

- The **workflow engine owns sequencing**: a deterministic state machine per story
  (`story-loop.ts`) and per feature (`feature-machine.ts`). Both are pure orchestration over
  injected steps and persist their record after every step, so a crash resumes at the recorded step
  and finished stories are never re-dispatched.
- The **advisor owns judgment at branch points** (kinds `preflight`, `implementer-question`,
  `residual`, `finish-approval`). Every ruling goes to the run ledger and the PR body. The run never
  stops for a human; a ruling that needs confirmation is surfaced in the draft PR instead.
- **Gates stay deterministic.** Lint, typecheck and tests decide pass or fail. The advisor cannot
  turn a red gate green, and nax never merges a PR.

### 2. Per-story loop

1. **Preflight** (`workflow.preflight`, default on): before the first story, the advisor scans the
   PRD for stories sharing files or interfaces and for AC/spec contradictions, and rules on them.
2. **Implement**: one implementer session writes tests and code, runs them, commits and writes a
   report file. There is no separate test-writer or verifier. The implementer tier comes from the
   story's `routing.complexity` in `prd.json`, as before, so `nax plan` is unchanged.
3. **Gates**: the deterministic quality gates run on the story.
4. **Story review**: one review session per story returns both a spec verdict and a quality verdict
   over the story diff, brief and report. It replaces the semantic + adversarial pair. Minor
   findings go to the ledger as deferred items and do not enter the loop, which replaces NBF and its
   worth-check.
5. **Fix rounds** (up to `workflow.maxFixRounds`, default 5): rounds 1-3 send the findings into the
   warm implementer session; later rounds start a fresh session one tier up the escalation ladder.
   Each round ends with a scoped re-review of the fix diff only (ADR-033).
6. **Adjudicate**: whatever is still open after the last round is ruled on by the advisor. The story
   loop always returns an end state; it never fails or pauses a story.

Stories run one at a time. `--parallel` and story batching are clamped off in workflow mode, and a
parallel code path reached in workflow mode is a bug (`WORKFLOW_PARALLEL_UNREACHABLE`).

### 3. Per-feature workflow

`repo-gates` -> `branch-review` -> `branch-fix` -> `branch-rereview` -> `adjudicate` ->
`final-gates` -> `gate-repair` -> `publish`.

- One whole-branch review, run on the model in `workflow.models.branchReview`, with the deferred
  minor items. It checks cross-story contracts that per-story reviews cannot see.
- Up to `workflow.maxBranchFixRounds` (default 2) fix -> scoped re-review cycles; 0 runs no branch fix.
- The advisor adjudicates residual findings once. There is no second review wave.
- If a branch fix turns previously green gates red, up to `workflow.finalGateRepairRounds`
  (default 1) repair passes run before publishing.
- Past `execution.costLimit`, no further agent step runs: the machine goes to the final gates and
  publishes a draft.
- `workflow.publish` (`pr` default, `push`, `none`) decides what happens after the final gates. A
  PR opens as a **draft** whenever anything needs a human (red gates, unread CI, conflicts, flagged
  rulings); the draft lists them under "Before marking ready". `result.json` records a top-level
  verdict and `openItems[]`.

### 4. What workflow mode turns off

Applied by `applyWorkflowMode` on every merged config layer, so no project or package overlay can
re-enable them:

- the acceptance stage (`acceptance.enabled` forced to `false`);
- per-story worktree isolation (`execution.storyIsolation` forced to `shared`, with a warning),
  because the run tree lives in the repo at `.nax/features/<feature>/workflow/<runId>/` so the agents'
  file tools can read briefs, reports and review packages (#2479);
- and it forces the advisor on when an `advisor` block is present.

The separate test-writer and verifier sessions, the semantic + adversarial pair, NBF + worth-check,
and the finish multi-round loop are not used. `workflow.models.storyReview` falls back to
`review.semantic.model`; `branchReview` and `branchFix` fall back to `finish.reviewers.quality` and
`finish.reviewers.fix`. The `workflow` block is root-only.

### 5. Pipeline mode

`execution.mode: "pipeline"` still runs the old story pipeline and logs a deprecation warning. It is
frozen: pipeline-only issues are not fixed and will be closed. It will be removed in a future release.

## Evidence

Workflow mode shipped opt-in (behind a profile) on 2026-10-12 and was A/B tested against captured
pipeline runs of the same features, from the same seed commits, with the same per-story routing and
model map. The decision rule, agreed before the billed runs: workflow mode wins if a blind fresh
reviewer raises no more HIGH+ findings on its branch than on the control branch, **and** it is at
least 30 % lower on wall-clock or on tokens through the model.

| Feature | Result |
|---|---|
| A (TypeScript service) | PASS: -43 % time, -57 % tokens (pass 1); -32 % tokens on the re-run after #2479 |
| B (NestJS app) | PASS on pass 3, after #2484 / #2486 and a stronger branch-review model: -39 % time, -46 % tokens; blind findings 0/1/4/5 vs 0/0/4/6 (the one HIGH adjudicated MEDIUM, no production effect) |

Earlier passes on feature B failed on quality (a storage-width vs contract-limit mismatch the story
review missed twice); the fix was the cross-story contract check in story and branch review (#2486),
not a loosened rule. Follow-up hardening (#2496-#2558) landed before the default flipped in v0.88.0.

## Consequences

- One implementer session per story, with warm fix rounds, replaces roughly ten sessions per story.
  Fix cycles accumulate context by design; that is the point of the warm session.
- The review surface is smaller and bounded: one story review and one branch review, each with a
  scoped re-review. Findings are not chased indefinitely; the residual goes to the advisor and to the
  PR body. A draft PR is the expected outcome when anything is left for a human.
- Stories no longer run in parallel. Throughput comes from fewer sessions, not concurrency.
- Dropping the separate test-writer means the implementer writes its own tests. The story review and
  the deterministic gates are what check them.
- The pipeline code (stages, acceptance, NBF, finish loop) stays until pipeline mode is removed,
  which keeps an A/B control arm available but is dead weight on the default path.
- `--parallel`, worktree story isolation and the acceptance settings are silently or loudly ignored
  in workflow mode; users relying on them must set `execution.mode: "pipeline"` and accept the
  deprecation.
