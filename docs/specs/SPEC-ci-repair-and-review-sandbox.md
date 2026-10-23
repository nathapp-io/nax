# SPEC: CI repair with its own role and evidence, and a built bot review worktree

Closes: #2642, #2641

## Summary

Workflow CI repair and bot fix's repair sessions get their own session role, `wf-repair`, and their own op,
`workflowRepairOp`. That separates their tokens and cost from the branch fix. Workflow final-gate repair moves to the
same role. A failed GitHub Actions check now carries the step that failed and the steps CI skipped after it. The CI
repair gets its own prompt, which:

- names those steps and says to reproduce every one of them locally;
- says to fix forward, never skipping or disabling the check;
- requires `DONE_WITH_CONCERNS`, naming the check, for any check the agent cannot run locally.

The bot repair and prepare prompts get the same rule. The CI repair's concerns, the checks it targeted, and the checks
still failing after the last round are recorded in the ledger and in `result.json`; the concerns and the checks still
failing also appear in the end-of-run summary. Bot review also runs the resolved checks' `build` gate after the
install step, so a sibling workspace's scoped tests can
start. Its prompt tells the reviewer to report a check that never started as "could not start", not as a defect.

## Motivation

nax#2642: the first live workflow CI repair left the PR a draft with CI red. Gap 1 of that issue (the job log was
unreadable while the run was still in progress) was fixed by nax#2659. `readJobLog` now reads
`repos/<repo>/actions/jobs/<id>/logs`. Three gaps remain:

- **Gap 2.** The agent could not run `pip-audit` in its sandbox but replied `DONE` with no concerns. The workflow
  never reads the branch-fix reply's `concerns`, so nothing recorded that half the job went unchecked.
- **Gap 3.** A job stops at its first failing step. After the agent fixed `bun audit`, CI failed at the next step,
  `pip-audit`, which the first run never reached. The brief named only the job, not the step or the steps after it.
- **Gap 4.** The repair runs the branch-fix prompt ("You are fixing a feature branch after its whole-branch review")
  under the `wf-branch-fix` role. Its tokens are booked with the branch fix, and after the last round the ledger says
  only `CI failed`, with no record of which check or step is still red.

`nax bot fix`'s repair step (`repairStep`, modes `repair` and `prepare`) has the same identity problem: it calls
`runBranchFix`, so it books under `wf-branch-fix` too. The workflow final-gate repair is a repair in the same sense:
make red checks green, as opposed to addressing review findings. Ruling (2026-10-23): one `wf-repair` role covers
all three.

nax#2641: in a monorepo, a sibling workspace's test preload imports a compiled workspace library by package name.
`nax bot review` runs `execution.preRun` (the install) in a fresh worktree, but nothing builds that library. The
scoped suite aborts on a module-resolution error, and the review lists it under "Could not verify", as if the change
were at fault. Ruling (2026-10-23): run the root build gate after the install, and have the reviewer report a check
that never started as "could not start". `--in-place` already reuses an existing checkout and its build, so it gets no
build step.

## Design

### Approach

1. **Role and op.** `wf-repair` joins `CanonicalSessionRole`. `workflowRepairOp` (`src/operations/workflow-repair.ts`)
   is `workflowBranchFixOp` with `name: "workflow-repair"` and `session: { role: "wf-repair", lifetime: "fresh" }`.
   Its tools, model resolution, timeout, writable report, soft-interrupt hop body, parser and recover are the same.
   Because the token meter keys `byRole` by the dispatch's `sessionRole`, the new role books separately with no meter
   change. `runBranchFix` takes `kind?: "fix" | "repair"`. `"repair"` dispatches `workflowRepairOp` and commits
   leftover edits as `wf-repair`, so the commit reads `chore(_run): auto-commit after wf-repair session`. Rule delivery
   treats `wf-repair` exactly like `wf-branch-fix`.
2. **Routing.** `FeatureSteps.branchFix` takes `opts.repair?: true`. `buildFeatureEnv` maps it to `kind: "repair"`.
   `gateRepairStep` and `ciRepairStep` pass `repair: true`; `branchFixStep` is unchanged. Each call stays one line
   (`ciRepairStep` spreads `prUrl` into the options object instead of its current two-call ternary), because
   `feature-steps.ts` has 3 lines left before US-004 moves the CI repair out. Bot `repairStep` passes
   `kind: "repair"` in both modes; bot `fixStep` is unchanged. `REPAIR_VERIFICATION_RULE` is added to
   `src/prompts/builders/workflow-implementer-builder.ts` beside `WORKFLOW_REPLY_CONTRACT`, exported from
   `@/prompts`, and bot `buildBotPrFixPrompt`'s `repair` and `prepare` modes include it.
3. **Job steps.** `FailedCheck` gains `failedStep?: string` and `skippedSteps?: readonly string[]`. For a GitHub
   Actions check, after the job log is read, `readJobSteps` (`src/forge/job-steps.ts`) runs
   `gh api --hostname <host> repos/<repo>/actions/jobs/<id>`. The first step whose `conclusion` is `"failure"` is
   `failedStep`; the names of the steps after it whose `conclusion` is `"skipped"` are `skippedSteps`, in job order.
   Reading the steps is best effort: a failed command, an unparsable reply, a reply without a `steps` array, or a job
   with no failed step leaves both fields absent and changes nothing else. GitLab jobs and non-Actions check runs get
   neither field and make no extra call.
4. **CI repair prompt.** `buildWorkflowCiRepairPrompt` (`src/prompts/builders/workflow-ci-repair-builder.ts`) is the CI
   repair's brief, and includes `REPAIR_VERIFICATION_RULE` (US-002). `FeatureSteps.branchFix` takes `opts.ciRound?: number`. When it is set,
   `buildFeatureEnv` passes `runBranchFix` `ciRepair: { round, prUrl? }`, and `runBranchFix` builds the CI repair
   prompt instead of the branch-fix prompt. Final-gate repair keeps the branch-fix prompt. `ciRepairFindingsOf` puts
   the step facts into each finding's `issue`: with a `failedStep`, the issue is
   `CI check <name> failed at step "<step>".`, then (only when `skippedSteps` is non-empty) a line
   `Steps CI skipped after it, which never ran: <a>, <b>`, then the excerpt, each separated by one newline. Without a
   `failedStep` the issue stays `CI check <name> failed:\n<excerpt>`.
5. **Moving the CI repair out of `feature-steps.ts`.** That file is at 597 of its 600-line limit.
   - `ciRepairStep`, `ciRepairDecision`, `readCiFailuresForRepair` and `ciRepairFindingsOf` move to
     `src/workflow/ci-repair-steps.ts`.
   - `feature-steps.ts` re-exports `ciRepairStep` and `ciRepairDecision`, so `feature-graph.ts` and the existing tests
     import them unchanged.
   - The shared helpers the moved code needs (`DEFAULT_LIMITS`, `limitsOf`, `costExceeded`, `NO_MIRROR`,
     `featureStep`, `roundLabel`; `featureStep` also needs `FEATURE_SCOPE` from `./advisor-live`) are all defined in `feature-steps.ts` and used by code that stays there, so they
     move to a third module, `src/workflow/feature-step-helpers.ts`, which both files import. `feature-steps.ts` keeps
     re-exporting `featureStep` and `NO_MIRROR`. `ci-repair-steps.ts` must not import `feature-steps.ts`: the import-
     cycle baseline is 0 (`bun run check:import-cycles`).
6. **Evidence.** Three optional fields on `WorkflowFeatureRecord`:
   - `ciRepairTargets` is written by `publishStep` whenever it decides a repair: each failed check's `name`, plus
     `failedStep` when known.
   - `ciRepairConcerns` is appended by `ciRepairStep` as `r<N>: <concerns>` when the repair's reply carries
     non-empty `concerns`. The same text goes to the ledger as `CI repair r<N> concerns: <concerns>`.
   - `ciRemaining` is written by `publishStep` when all of these hold: `readCiFailures` exists, the outcome is
     `draft`, CI is `failed`, the publish has a URL and a HEAD, at least one repair round ran, and the rounds are
     spent (`ciRepairRounds >= workflow.ciRepairRounds`). In that case the failed checks are read, whatever the cost
     state, since the read runs no agent. This condition and `ciRepairDecision`'s (rounds left) never both hold, so
     a publish reads the failed checks at most once.
   - How `publishStep` gets the checks: `ciRepairDecision` keeps its signature and still returns the findings array
     (its tests call it directly). A new `ciRepairPlan(env, rec, out, head)` in `ci-repair-steps.ts` returns
     `{ findings, targets } | undefined` from the same single read, and `ciRepairDecision` returns
     `(await ciRepairPlan(...))?.findings`. `publishStep` calls `ciRepairPlan`. The remaining-CI read is a separate
     function, `ciRemainingAfterRepair(env, rec, out, head)`, which calls `env.steps.readCiFailures` directly, not
     `readCiFailuresForRepair`, so it never writes the `(repairing)` note. On a throw it writes only
     `CI logs unavailable: <message>`; on an empty list it writes no note. Each check is recorded with `newFailure: true` unless a
     target has the same `name` and the same `failedStep`. The ledger gets
     `CI still failing after <N> repair round(s): <check>[ at step "<step>"] (new failure|still failing)`, with checks
     joined by `; `.

   `WorkflowSummaryView` gains `ciRemaining` (each `<name>` or `<name> at step "<step>"`) and `ciRepairConcerns`.
   `summaryLine` appends `CI still failing: <a>, <b>` and `CI repair concerns: <a>; <b>`.

   The PR's draft reason stays `CI failed`: `publish` posts it before the CI read (ruled out of scope).
7. **Bot review build.** `reviewBuildSteps(checks)` (`src/bot/checks.ts`) turns the `command` of the gate named
   exactly `build` into steps: a list becomes one step per element, and every step gets
   `timeoutSeconds: REVIEW_BUILD_TIMEOUT_SECONDS`. A `build` gate never carries a `setup` (`resolveGateCommands` gives
   only `e2e` one), so `setup` is ignored. `REVIEW_BUILD_TIMEOUT_SECONDS` is `DEFAULT_GATE_TIMEOUT_MS / 1000` (900),
   derived from the gate runner's own default, as `DERIVED_INSTALL_TIMEOUT_SECONDS` is for the install; the build is
   the same gate command, so it gets the same bound. `DEFAULT_GATE_TIMEOUT_MS` is added to the `@/finish` barrel's
   `./gates/quality` exports.
   - `prepareReviewChecks` runs these steps through `runPreRunSteps` after a successful install, but only when the
     list is non-empty and the checkout is not `inPlace`.
   - A `PRE_RUN_FAILED` from the build records `buildFailed: <command>`; any other error propagates.
   - `ReviewPreparation` gains `buildRan: readonly string[]`: every command of `reviewBuildSteps(checks)` once the
     build was attempted (including the commands after a failing one), and `[]` on every other return path (static
     mode, install failed, in-place, no `build` gate). The checkout state's `setup`
     lists the install commands followed by `buildRan`, and its `setupFailed` is the install's failure or else the
     build's.
   - `postPrReview` forwards `buildFailed` into the summary input beside `preRunFailed` (`src/bot/post.ts`), and the
     review summary gains the line
     `Build step failed (<command>); checks that import built workspace packages may not have started.`
   - The commands come only from the trusted base snapshot (`resolveBotChecks`), and static mode (an untrusted PR)
     still runs nothing.
8. **"Could not start".** `buildBotPrReviewPrompt` appends `COULD_NOT_START_RULE` as the last line of its
   `## Checkout state` section. That section exists only when `checkoutState` is set, which `reviewEnvironment` does
   only outside static mode; no new heading is added, so the pinned `## Checklist` slice, the heading order and the
   `## Your task` tail are unchanged. The rule: a check that stops before it runs any test did not run. It goes in `cannotVerify` as `could not start: <check>: <reason>`,
   naming the setup step it needs, and is never reported as a defect in the change.

### Integration

Read only (verified at `6cc3675eb`):

- `packages/nax/src/forge/ci-failures.ts`: `FailedCheck { name; url?; excerpt; logUnavailable? }`,
  `readExcerpt(run, ref, deps, cwd)`, `toFailedCheck(run, ref, deps, cwd)`, `readGithubFailedChecks`.
- `packages/nax/src/forge/job-log.ts`: `readJobLog(ref, checkId, deps, cwd): Promise<JobLogRead>`, which runs
  `gh api --allow-escape-sequences --hostname <host> repos/<repo>/actions/jobs/<id>/logs`.
- `packages/nax/src/workflow/tokens.ts`: `startTokenMeter(source)` books each dispatch under `e.sessionRole`.
- `packages/nax/src/execution/lifecycle/pre-run-steps.ts`: `runPreRunSteps({ steps, workdir })` throws
  `NaxError` code `PRE_RUN_FAILED` with `context.command`.
- `packages/nax/src/finish/gates/quality.ts`: `DEFAULT_GATE_TIMEOUT_MS = 900_000`.
- `packages/nax/src/prompts/builders/workflow-implementer-builder.ts`: `renderWorkflowFindings`,
  `WORKFLOW_ARTIFACTS_RULE`, `WORKFLOW_REPLY_CONTRACT`.

Changed. Each baseline below only locates the code, and is never the interface to implement; the target is.

- `packages/nax/src/runtime/session-role.ts` `CanonicalSessionRole` / `KNOWN_SESSION_ROLES`
  - Baseline: the union ends at `"wf-branch-fix"`.
  - Target: also `"wf-repair"`, in both the union and the array.
- `packages/nax/src/context/rules/rule-delivery/index.ts` `RULE_READ_ROLES`, `RULE_WRITE_ROLES`
  - Target: both also contain `"wf-repair"`.
- `packages/nax/src/workflow/branch-fix.ts` `BranchFixInput` (internal), `runBranchFix(fc, input)`
  - Baseline: `{ specPath?; findings; model?; prompt?; toolProviders? }`.
  - Target: plus `kind?: "fix" | "repair"` (US-001) and `ciRepair?: { readonly round: number; readonly prUrl?: string }` (US-004).
- `packages/nax/src/workflow/feature-machine.ts` `FeatureSteps.branchFix`
  - Baseline: `(findings, opts?: { readonly prUrl?: string })`.
  - Target: `(findings, opts?: { readonly prUrl?: string; readonly repair?: true; readonly ciRound?: number })`;
    `repair` arrives in US-002 and `ciRound` in US-004.
- `packages/nax/src/forge/ci-failures.ts` `FailedCheck`
  - Target: `{ name; url?; excerpt; logUnavailable?; failedStep?: string; skippedSteps?: readonly string[] }`.
- `packages/nax/src/prompts/builders/bot-pr-fix-builder.ts` `instructions(input)`
  - Target: the `repair` and `prepare` modes end with `- ${REPAIR_VERIFICATION_RULE}`; `fix` is unchanged.
- `packages/nax/src/workflow/types.ts` `WorkflowFeatureRecord`
  - Target: plus `ciRepairTargets?: readonly CiCheckRef[]`, `ciRepairConcerns?: readonly string[]` and
    `ciRemaining?: readonly CiRemainingCheck[]`.
  - `CiCheckRef = { readonly name: string; readonly failedStep?: string }`;
    `CiRemainingCheck = CiCheckRef & { readonly newFailure: boolean }`.
- `packages/nax/src/workflow/feature-graph.ts` `FEATURE_GRAPH`
  - Target: `ci-repair` produces `["ciRepairRounds", "ciRepairFindings", "ciRepairConcerns"]`; `publish` also
    produces `ciRepairTargets` and `ciRemaining`.
- `packages/nax/src/log-format/types.ts` `WorkflowSummaryView`
  - Target: plus `ciRemaining?: readonly string[] | undefined` and `ciRepairConcerns?: readonly string[] | undefined`.
- `packages/nax/src/bot/review-run.ts` `ReviewPreparation`
  - Baseline: `{ checks; preRunFailed?; ci }`.
  - Target: plus `buildFailed?: string` and `buildRan: readonly string[]`.
- `packages/nax/src/finish/index.ts`
  - Target: the `./gates/quality` export list also exports `DEFAULT_GATE_TIMEOUT_MS`.
- `packages/nax/src/workflow/feature-steps.ts` `DEFAULT_LIMITS`, `limitsOf`, `costExceeded`, `NO_MIRROR`, `roundLabel`, `featureStep`
  - Target: defined in `src/workflow/feature-step-helpers.ts` (US-004); `feature-steps.ts` imports them and keeps re-exporting `featureStep` and `NO_MIRROR`.
- `packages/nax/src/bot/post.ts` `PostReviewInput` and `packages/nax/src/bot/render-comments.ts` `ReviewSummaryInput`
  - Target: plus `buildFailed?: string`.

New:

```typescript
// src/operations/workflow-repair.ts (exported from @/operations)
export const workflowRepairOp: RunOperationWithHooks<WorkflowBranchFixInput, ImplementerReply, WorkflowOpConfig, "hopBody" | "recover">;

// src/forge/job-steps.ts (internal to src/forge)
export interface JobSteps { readonly failedStep?: string; readonly skippedSteps?: readonly string[] }
export async function readJobSteps(ref: PrRef, jobId: string, deps: ForgeDeps, cwd: string): Promise<JobSteps>;

// src/prompts/builders/workflow-implementer-builder.ts (exported from @/prompts), US-002
export const REPAIR_VERIFICATION_RULE: string;

// src/prompts/builders/workflow-ci-repair-builder.ts (exported from @/prompts), US-004
export function buildWorkflowCiRepairPrompt(input: {
  readonly round: number;
  readonly prUrl?: string;
  readonly specPath?: string;
  readonly prdPath?: string;
  readonly reportPath: string;
  readonly findings: readonly WorkflowPromptFinding[];
}): string;

// src/bot/checks.ts
export const REVIEW_BUILD_TIMEOUT_SECONDS: number; // DEFAULT_GATE_TIMEOUT_MS / 1000
export function reviewBuildSteps(checks: BotChecks): PreRunStepConfig[];
```

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| Job-steps read exits non-zero | `failedStep` and `skippedSteps` absent; excerpt unchanged |
| Job-steps reply unparsable or has no `steps` array | Both absent |
| Job has no step with conclusion `failure` | Both absent |
| Repair reply has no `concerns` (empty or absent), or the session failed with no reply | No ledger concerns line; `ciRepairConcerns` not patched |
| Remaining-CI read throws | Ledger `CI logs unavailable: <message>`; no `ciRemaining` |
| Remaining-CI read returns no check | No `ciRemaining`, no still-failing note |
| Review install step fails | Build steps not run; `preRunFailed` recorded as today |
| Review build step fails (`PRE_RUN_FAILED`) | `buildFailed` recorded; review still runs |
| Review build step throws anything else | The error propagates out of `runBotReview` |

## Out of Scope

- nax#2642 gap 1 (log unavailable while the Actions run is in progress) was fixed by nax#2659; this feature does not change how the job log is read.
- The `costUsd: 0` booked for native-agent repair tokens in nax#2642 is a cost-estimation issue in the dispatch events, not a role issue; this feature only separates the role.
- The default of `workflow.ciRepairRounds` stays 1.
- The PR's draft reason for a failed CI stays `CI failed`; the remaining checks and concerns go to the ledger, `result.json` and the end-of-run summary only.
- Workflow final-gate repair changes its session role to `wf-repair` but keeps the branch-fix prompt.
- Bot `fix` mode's prompt and role are unchanged.
- Classifying a failure as new when a second repair round is decided; only the final remaining-CI read classifies.
- GitLab jobs expose no step list, so a GitLab failed check never carries `failedStep` or `skippedSteps`.
- Reading CI workflow files to list a job's steps; the steps come only from the Actions jobs API.
- Bot review never runs per-package build overlays (`build@<package>`), only the root gate named `build`.
- Bot review runs no build step for an `--in-place` review, which reuses the user's existing build.
- Bot fix gets no build step; its bar already runs the build gate after the session.
- A job whose step ended `cancelled` or `timed_out` gets no `failedStep`; only a step with conclusion `failure` is named.
- A new verdict field for checks that could not start; the reviewer reports them through `cannotVerify` with the `could not start:` prefix.
- Recording the `concerns` of the bot repair and the workflow final-gate repair replies; only the workflow CI repair records its concerns.
- The session-role table in `.nax/rules/adapter-wiring.md` gains `wf-repair` as a manual follow-up after the run (`.nax/` is read-only to the run).

## Stories

Seven stories, all in `packages/nax`. US-001 to US-006 are nax#2642 plus the bot repair; US-007 is nax#2641. The
count is under 8, and the work is one capability: repair sessions that are identified, briefed and evidenced, plus
the review sandbox fix, which shares the same symptom (a check reported as unverified when the sandbox could not run
it).

### US-001: The `wf-repair` role and `workflowRepairOp`
No dependencies. Workdir: packages/nax.

Adds `"wf-repair"` to `CanonicalSessionRole` and `KNOWN_SESSION_ROLES`, and creates `workflowRepairOp`, exported
from `@/operations`. Adds `wf-repair` to `RULE_READ_ROLES` and `RULE_WRITE_ROLES`. Gives `runBranchFix` the
`kind?: "fix" | "repair"` input: `"repair"` dispatches `workflowRepairOp` and commits leftovers under `wf-repair`.

### US-002: Route the workflow and bot repair sessions to `wf-repair`
Depends on US-001. Workdir: packages/nax.

Adds `repair?: true` to `FeatureSteps.branchFix`'s options; `buildFeatureEnv` maps it to `kind: "repair"`.
`gateRepairStep` and `ciRepairStep` pass `repair: true`, each in a single-line call. Bot `repairStep` passes
`kind: "repair"` to `runBranchFix` in both its `repair` and `prepare` modes. Adds `REPAIR_VERIFICATION_RULE` beside
`WORKFLOW_REPLY_CONTRACT`, and the bot `repair` and `prepare` instructions include it. The `feature-env.test.ts`
harness (`makeScriptedCallOp`) drives the `buildFeatureEnv` ACs.

### US-003: The failed step and skipped steps of a failed Actions check
No dependencies. Workdir: packages/nax.

Creates `src/forge/job-steps.ts` with `readJobSteps`, and adds `failedStep` and `skippedSteps` to `FailedCheck`.
`toFailedCheck` reads the steps after the job log for GitHub Actions checks only.

### US-004: The CI repair prompt and the shared verification rule
Depends on US-002, US-003. Workdir: packages/nax.

Creates `buildWorkflowCiRepairPrompt`, which includes `REPAIR_VERIFICATION_RULE` (US-002). Moves the shared helpers
to `src/workflow/feature-step-helpers.ts` and the CI repair functions to `src/workflow/ci-repair-steps.ts`
(Approach 5). Adds
`opts.ciRound` and `runBranchFix`'s `ciRepair` input. `ciRepairStep` passes `ciRound: round`, and
`ciRepairFindingsOf` writes the step facts into each finding's `issue`.

### US-005: Repair concerns and repair targets
Depends on US-004. Workdir: packages/nax.

Adds `ciRepairTargets` and `ciRepairConcerns` to `WorkflowFeatureRecord`, with `CiCheckRef`, and adds them to the
graph's `produces` (`publish` and `ci-repair`). `ciRepairStep` records the reply's concerns. `publishStep` records
the targets when it decides a repair. Adds `ciRepairConcerns` to the summary view and the end-of-run summary line.

### US-006: The checks still failing after the last repair round
Depends on US-005. Workdir: packages/nax.

Adds `ciRemaining` and `CiRemainingCheck` to `WorkflowFeatureRecord`, and to `publish`'s `produces`. `publishStep`
reads the failed checks again when CI is still red after the last round, and compares them with
`ciRepairTargets`. Adds `ciRemaining` to the summary view and the end-of-run summary line.

### US-007: Build the bot review worktree, and "could not start"
No dependencies. Workdir: packages/nax.

Adds `reviewBuildSteps` and `REVIEW_BUILD_TIMEOUT_SECONDS` to `src/bot/checks.ts`, and exports
`DEFAULT_GATE_TIMEOUT_MS` from `@/finish`. `prepareReviewChecks` runs the build steps after the install, records
`buildRan` and `buildFailed`, and reports them in the checkout state and the review summary. `buildBotPrReviewPrompt`
appends `COULD_NOT_START_RULE` to its `## Checkout state` section. The `review-run.test.ts` harness (the nax#2631
case reaches the real `postPrReview`) and `review-checkout-state.test.ts` (the review prompt) drive the
integration ACs.

### Context Files

**US-001**
- `packages/nax/src/operations/workflow-branch-fix.ts` — `workflowBranchFixOp`, the op the new one mirrors
- `packages/nax/src/runtime/session-role.ts` — `CanonicalSessionRole`, `KNOWN_SESSION_ROLES`
- `packages/nax/src/context/rules/rule-delivery/index.ts` — `RULE_READ_ROLES`, `RULE_WRITE_ROLES`
- `packages/nax/src/workflow/branch-fix.ts` — `runBranchFix`, `commitLeftovers`, `runFixSession`
- `packages/nax/test/unit/workflow/branch-fix.test.ts` — the `makeScriptedCallOp` and leftover-commit harness

**US-002**
- `packages/nax/src/workflow/feature-machine.ts` — `FeatureSteps`
- `packages/nax/src/workflow/feature-env.ts` — `buildFeatureEnv`, the `branchFix` step
- `packages/nax/src/workflow/feature-steps.ts` — `gateRepairStep`, `ciRepairStep`
- `packages/nax/src/bot/repair-step.ts` — `repairStep`
- `packages/nax/src/prompts/builders/bot-pr-fix-builder.ts` — `instructions`, `buildBotPrFixPrompt`

**US-003**
- `packages/nax/src/forge/ci-failures.ts` — `FailedCheck`, `readExcerpt`, `toFailedCheck`
- `packages/nax/src/forge/job-log.ts` — `readJobLog`, the command shape to mirror
- `packages/nax/test/unit/forge/ci-failures.test.ts` — `githubFixture`, `checkRun`
- `packages/nax/test/unit/forge/ci-failures-gitlab.test.ts` — the GitLab fixture

**US-004**
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts` — `buildWorkflowBranchFixPrompt`, the shape to mirror
- `packages/nax/src/workflow/feature-graph.ts` — imports `ciRepairStep` and the helpers that move
- `packages/nax/src/workflow/feature-steps.ts` — the CI repair functions that move
- `packages/nax/src/workflow/branch-fix.ts` — `runBranchFix`'s prompt selection
- `packages/nax/src/workflow/feature-env.ts` — the `branchFix` step

**US-005**
- `packages/nax/src/workflow/ci-repair-steps.ts` — created by US-004, extended here
- `packages/nax/src/workflow/feature-steps.ts` — `publishStep`
- `packages/nax/src/workflow/feature-graph.ts` — `FEATURE_GRAPH` `produces`
- `packages/nax/src/workflow/run-summary.ts` — `buildWorkflowRunSummary`
- `packages/nax/src/execution/workflow-end-report.ts` — `summaryLine`, `reportWorkflowRun`

**US-006**
- `packages/nax/src/workflow/ci-repair-steps.ts` — created by US-004, extended by US-005 and here
- `packages/nax/src/workflow/feature-steps.ts` — `publishStep`
- `packages/nax/src/workflow/feature-graph.ts` — `FEATURE_GRAPH` `produces`
- `packages/nax/src/workflow/run-summary.ts` — `buildWorkflowRunSummary`
- `packages/nax/src/execution/workflow-end-report.ts` — `summaryLine`, `reportWorkflowRun`

**US-007**
- `packages/nax/src/bot/checks.ts` — `BotChecks`, `resolveBotChecks`, `barCommands`
- `packages/nax/src/bot/review-run.ts` — `prepareReviewChecks`, `reviewEnvironment`
- `packages/nax/src/bot/post.ts` — `PostReviewInput`
- `packages/nax/src/bot/render-comments.ts` — `ReviewSummaryInput`, the install-failed line
- `packages/nax/src/prompts/builders/bot-pr-review-builder.ts` — `buildBotPrReviewPrompt`, `projectSections`

### Creates

**US-001**
- `packages/nax/src/operations/workflow-repair.ts`
- `packages/nax/test/unit/operations/workflow-repair.test.ts`

**US-002**
- `packages/nax/test/unit/workflow/feature-steps-repair-routing.test.ts`

**US-003**
- `packages/nax/src/forge/job-steps.ts`
- `packages/nax/test/unit/forge/job-steps.test.ts`

**US-004**
- `packages/nax/src/prompts/builders/workflow-ci-repair-builder.ts`
- `packages/nax/src/workflow/ci-repair-steps.ts`
- `packages/nax/src/workflow/feature-step-helpers.ts`
- `packages/nax/test/unit/prompts/workflow-ci-repair-builder.test.ts`

**US-005**
- `packages/nax/test/unit/workflow/ci-repair-steps-evidence.test.ts`

**US-006**
- `packages/nax/test/unit/workflow/ci-repair-steps-remaining.test.ts`

**US-007**
- `packages/nax/test/unit/bot/checks-review-build.test.ts`
- `packages/nax/test/integration/bot/review-build.test.ts`

### Modifies

**US-001**
None. The role tests assert with `toContain`, and `runBranchFix`'s existing tests call it without `kind`, which keeps the `wf-branch-fix` op and commit role.

**US-002**
- `packages/nax/test/unit/workflow/feature-steps-ci-repair.test.ts` — "US-012 AC-1 forwards the published PR URL and retains C1" expects the `branchFix` calls to equal `[[[C1], { prUrl }]]`; the CI repair now also passes `repair: true`, so it expects `[[[C1], { prUrl, repair: true }]]`. The `"%s stays unbound"` cases expect a one-argument call for `ci-without-url` and `gate-with-url`; both repairs now pass `{ repair: true }`, so each expects `[[[finding], { repair: true }]]`. The invariant that only the CI repair forwards the PR URL is unchanged, and "US-012 AC-2 ordinary branch fix uses one argument" is unchanged.
- `packages/nax/test/integration/bot/repair-step.test.ts` — "AC-8/9/10 builds repair prompt with every tail and increments round" expects `runBranchFix` to have been called with exactly `{ findings, model, toolProviders, prompt }`; the repair now also passes `kind: "repair"`, so the expected object gains `kind: "repair"`. Its prompt and patch assertions are unchanged.
- `packages/nax/test/fixtures/workflow-equivalence/feature/final-gates-repair.json` — the golden trace records each `branchFix` call's arguments, and its final-gate repair calls hold one argument (`[[{ "id": "G1", ... }]]`); `gateRepairStep` now passes `{ repair: true }`, so those calls gain that second argument. Regenerate the golden by running the feature-machine equivalence test with `NAX_UPDATE_WORKFLOW_GOLDEN=1` and check that the only diff is that second argument on the gate-repair calls. The invariant that the machine's step sequence matches the golden is unchanged.

**US-003**
None. `githubFixture` answers the new jobs call with its check-runs JSON, which has no `steps` array, so the existing checks get no step fields. The steps are read after the log, so `calls[1]` is still the log command.

**US-004**
- `packages/nax/test/unit/workflow/feature-steps-ci-repair.test.ts` — after US-002, "US-012 AC-1" expects `[[[C1], { prUrl, repair: true }]]` and the `ci-without-url` case expects `[[[C1], { repair: true }]]`; the CI repair now also passes `ciRound: 1`, so they expect `{ prUrl, repair: true, ciRound: 1 }` and `{ repair: true, ciRound: 1 }`. The `gate-with-url` case is unchanged.

**US-005**
- `packages/nax/test/unit/workflow/feature-graph.test.ts` — `expectedProduces` pins each node's `produces`; `ci-repair` now also produces `ciRepairConcerns`, and `publish` also produces `ciRepairTargets`, so those two entries gain them. The invariant that every node's `produces` matches the graph is unchanged.

**US-006**
- `packages/nax/test/unit/workflow/feature-graph.test.ts` — after US-005, `expectedProduces.publish` ends with `ciRepairTargets`; `publish` now also produces `ciRemaining`, so that entry gains it. The invariant that every node's `produces` matches the graph is unchanged.
- `packages/nax/test/unit/workflow/feature-steps-ci-repair-decision.test.ts` — "AC-13: spent repair rounds read no CI logs" (`record: { ciRepairRounds: 1 }`, one round allowed, draft with failed CI) asserts `h.reads` equals `[]`; a spent round now reads the failed checks once for `ciRemaining`, so it is renamed to say spent rounds decide no repair, asserts `h.reads` has length 1 and that the step returns no `exit` of `"ci-repair"`. Its control (a round to spare reads once) is unchanged.

**US-007**
None. The review fixtures resolve checks with no `build` gate, so `runPreRunSteps` is still called once and the checkout-state text is unchanged.

### Seams

- US-001 -> US-002: `runBranchFix`'s `kind: "repair"` (US-001) is reached from `buildFeatureEnv`'s `branchFix` step and from bot `repairStep` (US-002). US-002's seam ACs enter at the steps `buildFeatureEnv` returns, and at `repairStep`.
- US-003 -> US-004: `FailedCheck.failedStep` / `skippedSteps` (US-003) are consumed by `ciRepairFindingsOf` (US-004). US-004's AC enters at `publishStep` with a stub `readCiFailures`.
- US-004 -> US-005: `src/workflow/ci-repair-steps.ts` (US-004) is extended by US-005. Its ACs enter at `ciRepairStep` and `publishStep`.
- US-005 -> US-006: `ciRepairTargets` (US-005) is what US-006's remaining-CI read compares against. US-006's ACs enter at `publishStep` with a record carrying targets.
- US-004's `buildWorkflowCiRepairPrompt` is reached within the same story through `buildFeatureEnv`'s `branchFix` step with `ciRound`; that AC drives the real builder.

## Acceptance Criteria

### US-001

- [unit] `isSessionRole("wf-repair")` returns `true`.
- [unit] `KNOWN_SESSION_ROLES` contains `"wf-repair"`.
- [unit] `workflowRepairOp`, imported from `@/operations`, has `name` equal to `"workflow-repair"`.
- [unit] `workflowRepairOp.session` equals `{ role: "wf-repair", lifetime: "fresh" }`.
- [unit] `workflowRepairOp.tools` equals `workflowBranchFixOp.tools`.
- [unit] `workflowRepairOp.model` with no `input.model` and a config whose `workflow.models.branchFix` is model `M` returns `M`.
- [unit] `workflowRepairOp.model` with `input.model` set to model `N` returns `N`.
- [unit] `workflowRepairOp.timeoutMs` for an input with `timeoutMs: 1000` returns `1000 + STEP_TIMEOUT_MARGIN_MS`.
- [unit] `workflowRepairOp.writableOutput` for an input with `reportPath: "/r/feature-report.md"` returns `"/r/feature-report.md"`.
- [unit] `workflowRepairOp.recover()` returns the same reply `parseImplementerReply("")` returns.
- [unit] `RULE_READ_ROLES` contains `"wf-repair"`.
- [unit] `RULE_WRITE_ROLES` contains `"wf-repair"`.
- [unit] `runBranchFix(fc, { findings, kind: "repair" })` calls `_workflowDeps.callOp` with `workflowRepairOp`.
- [unit] `runBranchFix(fc, { findings })` with no `kind` calls `_workflowDeps.callOp` with `workflowBranchFixOp`.
- [unit] `runBranchFix(fc, { findings, kind: "repair" })` with an uncommitted file left in `fc.projectDir` calls `_workflowDeps.autoCommitIfDirty` with the role argument `"wf-repair"`.
- [unit] `runBranchFix(fc, { findings })` with an uncommitted file left calls `_workflowDeps.autoCommitIfDirty` with the role argument `"wf-branch-fix"`.

### US-002

- [integration] The `branchFix` step returned by `buildFeatureEnv`, called as `branchFix(findings, { repair: true })` with `_workflowDeps.callOp` scripted, dispatches an op whose `name` is `"workflow-repair"`.
- [integration] The same step called as `branchFix(findings)` dispatches an op whose `name` is `"workflow-branch-fix"`.
- [integration] The same step called as `branchFix(findings, { repair: true, prUrl: "https://github.com/o/r/pull/7" })` dispatches `"workflow-repair"` with a call context whose `toolProviders` holds one provider.
- [unit] `gateRepairStep` with `gateRepairFindings` holding one finding calls `env.steps.branchFix` with that finding as `G1` and a second argument equal to `{ repair: true }`.
- [unit] `ciRepairStep` with `ciRepairFindings` holding one finding and `url` `"https://github.com/o/r/pull/7"` calls `env.steps.branchFix` with a second argument whose `repair` is `true` and whose `prUrl` is that URL.
- [unit] `ciRepairStep` with no `url` calls `env.steps.branchFix` with a second argument whose `repair` is `true` and which has no `prUrl` key.
- [unit] `branchFixStep` with one open finding calls `env.steps.branchFix` with exactly one argument.
- [integration] Bot `repairStep` with state `outcome: "gates-failed"` calls `_fixStepsDeps.runBranchFix` with an input whose `kind` is `"repair"`.
- [integration] Bot `repairStep` with state `outcome: "baseline-red"` and `ciOutcome: "green"` (prepare mode) calls `_fixStepsDeps.runBranchFix` with an input whose `kind` is `"repair"`.
- [integration] Bot `fixStep` with one agreed finding calls `_fixStepsDeps.runBranchFix` with an input that has no `kind` key.
- [unit] `REPAIR_VERIFICATION_RULE`, imported from `@/prompts`, equals `If you cannot run a check here (for example the sandbox blocks its network, or its tool is missing), reply DONE_WITH_CONCERNS and name each such check in "concerns". Never reply DONE for a check you only reasoned about.`
- [unit] `buildBotPrFixPrompt` in mode `repair` returns text containing the value of `REPAIR_VERIFICATION_RULE`.
- [unit] `buildBotPrFixPrompt` in mode `prepare` returns text containing the value of `REPAIR_VERIFICATION_RULE`.
- [unit] `buildBotPrFixPrompt` in mode `fix` returns text that does not contain the value of `REPAIR_VERIFICATION_RULE`.

### US-003

- [unit] `readFailedChecks` for one failed GitHub Actions check (id 991), whose jobs reply has steps `Install` (`success`), `bun audit` (`failure`) and `pip-audit` (`skipped`), returns a check with `failedStep` equal to `"bun audit"`.
- [unit] That check has `skippedSteps` equal to `["pip-audit"]`.
- [unit] For a jobs reply with steps `Cache` (`skipped`), `test` (`failure`) and `report` (`skipped`), the check's `skippedSteps` equals `["report"]`, leaving out the step skipped before the failure.
- [unit] For a jobs reply with two steps whose conclusion is `failure`, `a` then `b`, the check's `failedStep` is `"a"`.
- [unit] For a jobs reply whose failed step is the last step, the check has no `skippedSteps` key.
- [unit] For one failed Actions check (id 991), on a ref with host `github.com` and repo `o/r`, the third command `readFailedChecks` runs is `["gh", "api", "--hostname", "github.com", "repos/o/r/actions/jobs/991"]`, after the job-log command.
- [unit] When the jobs command exits non-zero, the check has no `failedStep` and no `skippedSteps`.
- [unit] When the jobs command exits non-zero, the check's `excerpt` equals the excerpt the same log yields when the jobs reply carries no `steps`.
- [unit] When the jobs reply is not JSON, the check has no `failedStep`.
- [unit] When the jobs reply is a JSON object with no `steps` array, the check has no `failedStep`.
- [unit] When no step's conclusion is `failure`, the check has no `failedStep` and no `skippedSteps`.
- [unit] For a failed check run of app `circleci`, `readFailedChecks` runs only the check-runs listing command.
- [unit] For an Actions check whose job log read fails (`logUnavailable: true`) and whose jobs reply names the failed step `lint`, the check has `failedStep` equal to `"lint"`.
- [unit] For a GitLab failed job, `readFailedChecks` returns a check with no `failedStep`.

### US-004

- [unit] `buildWorkflowCiRepairPrompt({ round: 1, prUrl: "https://github.com/o/r/pull/7", reportPath: "/r/report.md", findings })`, imported from `@/prompts`, returns text containing `You are repairing the CI of pull request https://github.com/o/r/pull/7.`
- [unit] That text contains each finding's id and `issue`, as `renderWorkflowFindings(findings)` renders them.
- [unit] That text contains `Never skip, disable or ignore a failing check, and never edit the CI configuration to make it pass.`
- [unit] That text contains `A CI job stops at its first failing step, so a step CI skipped never ran: reproduce the failing step and every skipped step locally.`
- [unit] That text contains the value of `REPAIR_VERIFICATION_RULE`.
- [unit] With `round: 2`, the text contains `append a "CI repair r2" section to /r/report.md`.
- [unit] That text contains the value of `WORKFLOW_REPLY_CONTRACT`.
- [unit] That text does not contain `whole-branch review`.
- [unit] With `specPath: "/r/spec.md"`, the text contains `/r/spec.md`.
- [unit] `ciRepairStep` in round 1 calls `env.steps.branchFix` with a second argument whose `ciRound` is `1`.
- [integration] The `branchFix` step returned by `buildFeatureEnv`, called as `branchFix(findings, { repair: true, ciRound: 2, prUrl: "https://github.com/o/r/pull/7" })`, dispatches `"workflow-repair"` with an input whose `prompt` contains `"CI repair r2"`.
- [integration] The same step called as `branchFix(findings, { repair: true })` dispatches an input whose `prompt` contains `You are fixing a feature branch after its whole-branch review`.
- [unit] `publishStep` with a draft outcome, CI `failed`, a URL, a HEAD, one round allowed, and a `readCiFailures` returning one check `Security audit` with `failedStep: "bun audit"`, `skippedSteps: ["pip-audit"]` and excerpt `E` patches `ciRepairFindings` with one finding whose `issue` starts `CI check Security audit failed at step "bun audit".`
- [unit] That finding's `issue` contains the line `Steps CI skipped after it, which never ran: pip-audit`.
- [unit] That finding's `issue` equals `CI check Security audit failed at step "bun audit".\nSteps CI skipped after it, which never ran: pip-audit\nE`.
- [unit] The same `publishStep` with a check that has `failedStep: "bun audit"` and no `skippedSteps` patches a finding whose `issue` equals `CI check Security audit failed at step "bun audit".\nE`.
- [unit] The same `publishStep` with a check that has no `failedStep` patches a finding whose `issue` equals `CI check Security audit failed:\nE`.

**Out of scope:** US-004 only: the moves to `src/workflow/feature-step-helpers.ts` and `src/workflow/ci-repair-steps.ts` are verified by `bun run typecheck`, `bun run check:import-cycles` and `bun run check:file-sizes` (run from `packages/nax`), not by an AC.

### US-005

- [unit] `ciRepairStep` in round 1, whose `branchFix` returns a reply with `status: "DONE_WITH_CONCERNS"` and `concerns: "pip-audit not run: PyPI blocked"`, writes the ledger note `CI repair r1 concerns: pip-audit not run: PyPI blocked`.
- [unit] That step's patch has `ciRepairConcerns` equal to `["r1: pip-audit not run: PyPI blocked"]`.
- [unit] `ciRepairStep` in round 2 on a record with `ciRepairConcerns: ["r1: a"]`, whose reply has `concerns: "b"`, patches `ciRepairConcerns` to `["r1: a", "r2: b"]`.
- [unit] `ciRepairStep` whose reply has `concerns: ""` patches no `ciRepairConcerns` key.
- [unit] That step writes no ledger note starting `CI repair r1 concerns`.
- [unit] `ciRepairStep` whose `branchFix` returns `{ failure: "boom", autoCommitted: false, dirty: false }` with no reply patches no `ciRepairConcerns` key.
- [unit] `publishStep` that decides a repair for one check `Security audit` with `failedStep: "bun audit"` patches `ciRepairTargets` equal to `[{ name: "Security audit", failedStep: "bun audit" }]`.
- [unit] `publishStep` that decides a repair for one check `e2e` with no `failedStep` patches `ciRepairTargets` equal to `[{ name: "e2e" }]`.
- [unit] `publishStep` that decides no repair (CI `green`) patches no `ciRepairTargets` key.
- [unit] `buildWorkflowRunSummary` for a feature record with `ciRepairConcerns: ["r1: a"]` returns a view whose `ciRepairConcerns` equals `["r1: a"]`.
- [unit] `buildWorkflowRunSummary` for a feature record with no `ciRepairConcerns` returns a view with no `ciRepairConcerns` key.
- [unit] `reportWorkflowRun` with a view whose `ciRepairConcerns` is `["r1: a", "r2: b"]` logs a summary line containing `CI repair concerns: r1: a; r2: b`.

### US-006

- [unit] `publishStep` on a record with `ciRepairRounds: 1` and `ciRepairTargets: [{ name: "Security audit", failedStep: "bun audit" }]`, with `workflow.ciRepairRounds` 1, a draft outcome, CI `failed`, and a `readCiFailures` returning `Security audit` with `failedStep: "pip-audit"`, patches `ciRemaining` equal to `[{ name: "Security audit", failedStep: "pip-audit", newFailure: true }]`.
- [unit] That run writes the ledger note `CI still failing after 1 repair round(s): Security audit at step "pip-audit" (new failure)`.
- [unit] That run returns no `exit` of `"ci-repair"`.
- [unit] The same run with the remaining check at `failedStep: "bun audit"` patches `ciRemaining` equal to `[{ name: "Security audit", failedStep: "bun audit", newFailure: false }]`.
- [unit] That run writes the ledger note `CI still failing after 1 repair round(s): Security audit at step "bun audit" (still failing)`.
- [unit] The same run with remaining checks `e2e` (no step) and `Security audit` at `"bun audit"` writes the ledger note `CI still failing after 1 repair round(s): e2e (new failure); Security audit at step "bun audit" (still failing)`.
- [unit] The same run with `env.costExceeded` returning `true` calls `readCiFailures` once.
- [unit] That run patches `ciRemaining`.
- [unit] `publishStep` on a record with no `ciRepairRounds`, `workflow.ciRepairRounds` 0, a draft outcome and CI `failed` never calls `readCiFailures`.
- [unit] That run patches no `ciRemaining` key.
- [unit] `publishStep` after one repair round with CI `green` never calls `readCiFailures`.
- [unit] `publishStep` after one repair round with CI `failed`, whose `readCiFailures` throws `Error("gh down")`, writes the ledger note `CI logs unavailable: gh down`.
- [unit] That run patches no `ciRemaining` key.
- [unit] `publishStep` after one repair round with CI `failed`, whose `readCiFailures` returns `[]`, patches no `ciRemaining` key.
- [unit] That run writes no ledger note containing `CI still failing` and none containing `(repairing)`.
- [unit] `buildWorkflowRunSummary` for a feature record with `ciRemaining: [{ name: "Security audit", failedStep: "pip-audit", newFailure: true }, { name: "e2e", newFailure: false }]` returns a view whose `ciRemaining` equals `['Security audit at step "pip-audit"', "e2e"]`.
- [unit] `reportWorkflowRun` with a view whose `ciRemaining` is `['Security audit at step "pip-audit"', "e2e"]` logs a summary line containing `CI still failing: Security audit at step "pip-audit", e2e`.
- [unit] `publishStep` after one repair round, one round allowed, CI `failed` and outcome `ready`, never calls `readCiFailures`.
- [unit] `publishStep` on a record with `ciRepairRounds: 1`, `workflow.ciRepairRounds` 2, a draft outcome and CI `failed`, whose `readCiFailures` returns one check, calls `readCiFailures` exactly once.
- [unit] That run returns `exit` `"ci-repair"`.
- [unit] That run patches no `ciRemaining` key.

### US-007

- [unit] `reviewBuildSteps` for checks whose gates are `test` (`npm run test`) and `build` (`bun run build`) returns `[{ command: "bun run build", timeoutSeconds: 900 }]`.
- [unit] `REVIEW_BUILD_TIMEOUT_SECONDS` equals `DEFAULT_GATE_TIMEOUT_MS / 1000`, with `DEFAULT_GATE_TIMEOUT_MS` imported from `@/finish`.
- [unit] `reviewBuildSteps` for a `build` gate with `command: ["c", "d"]` returns steps with commands `c` then `d`, each with `timeoutSeconds` 900.
- [unit] `reviewBuildSteps` for checks with no `build` gate returns `[]`.
- [unit] `reviewBuildSteps` for checks whose only build gate is named `build@packages/lib` returns `[]`.
- [integration] `runBotReview` for a trusted PR in a fresh worktree, whose resolved checks have `preRun` `[bun install --frozen-lockfile]` and a `build` gate `bun run build`, calls `runPreRunSteps` twice: first with the install steps, then with the build steps, both with `workdir` equal to the checkout worktree.
- [integration] That review's prompt contains `Setup nax ran: bun install --frozen-lockfile, bun run build — all succeeded`.
- [integration] When the install step throws `PRE_RUN_FAILED` for `bun install --frozen-lockfile`, `runBotReview` calls `runPreRunSteps` once.
- [integration] That review's prompt contains `Setup nax ran: bun install --frozen-lockfile — failed at bun install --frozen-lockfile`.
- [integration] When the build step throws `PRE_RUN_FAILED` with `context.command` `bun run build`, `runBotReview` still calls `runPrReview` once.
- [integration] That review's prompt contains `failed at bun run build`.
- [integration] That review calls `postPrReview` with an input whose `buildFailed` is `bun run build`.
- [integration] The real `postPrReview`, given an input with `buildFailed: "bun run build"`, posts a review summary body containing `Build step failed (bun run build); checks that import built workspace packages may not have started.`
- [integration] When the build step throws a `NaxError` whose code is not `PRE_RUN_FAILED`, `runBotReview` rejects with that error.
- [integration] An `--in-place` review whose resolved checks have a `build` gate calls `runPreRunSteps` once, with the install steps only.
- [integration] A review of an untrusted PR (static mode) whose base has a `build` gate calls `runPreRunSteps` zero times.
- [unit] `renderReviewSummary` with `buildFailed: "bun run build"` returns a body containing `Build step failed (bun run build); checks that import built workspace packages may not have started.`
- [unit] `buildBotPrReviewPrompt` with a `checkoutState` returns a `## Checkout state` section whose last line is `If a check stops before it runs any test, for example because a module or workspace package cannot be resolved, it did not run: list it in "cannotVerify" as "could not start: <check>: <reason>" and name the setup step it needs. Never report it as a defect in the change.`
- [unit] `buildBotPrReviewPrompt` in static mode with no `checkoutState` returns text that does not contain `could not start:`.
