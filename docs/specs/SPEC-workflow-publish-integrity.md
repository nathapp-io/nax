# SPEC: Workflow Publish Integrity

## Summary

Bundles four open issues so a workflow-mode run (`execution.mode: "workflow"`) leaves an honest, complete
record that a person or an outside orchestrator can rely on. nax#2508: `status.json` reports a failed
feature workflow as `failed`, and a new `workflow.publish` setting (`pr` | `push` | `none`) lets a caller
that owns the PR switch off nax's own PR. nax#2507: the advisor decisions ledger is committed (and pushed
with the branch) instead of being left dirty. nax#2480: rulings flagged for a human are listed at run end
for every publish outcome, not only in a PR body. nax#2499: a shorthand model with an effort suffix
(`sonnet[medium]`) resolves through its tier like native ids do, without the "neither a tier nor a
recognizable model id" warning.

## Motivation

- **nax#2508, status.** `writeFinalFeatureStatus` (`src/execution/lifecycle/run-completion-phases.ts`)
  derives the final run status from `pluginGateFailed`, `exitReason` and `isComplete(prd)` and runs
  *before* the end phase, so a workflow-mode run whose feature workflow fails (red final gates, a story
  left gate-open, or a throw) still persists `run.status: "completed"`. Workflow mode never writes
  `postRun.finish`, so a caller that reads `status.json` the way it reads a pipeline run (koda's runner
  does) reports the run as completed.
- **nax#2508, publishing.** `publish()` (`src/workflow/finalize.ts`) always pushes and opens or finds a
  draft PR when a forge exists. An orchestrator that opens the PR itself gets two PR attempts on one
  branch, and has no way to turn nax's off.
- **nax#2507.** `publish()` pushes with `skipCommit: true` and only afterwards asks the advisor for the
  `finish-approval` decision, which `askApproval` appends to `.nax/features/<f>/decisions.jsonl`. Nothing
  commits it, so every approved run leaves the ledger modified, and branch-scope rulings written at
  `adjudicate` after the last auto-commit miss the pushed branch. Observed on store-erp
  `m2-s5-invoice-notify` (nax `93f8818`).
- **nax#2480.** A ruling with `needsHumanConfirm: true` reaches a human only through the PR body. When the
  feature ends `local-only`, `deliverHeadsUp` returns `no-channel` and the end-of-run summary does not
  mention the ruling, so a ruling that changed an acceptance criterion can go unnoticed.
- **nax#2499.** `resolveConfiguredModel` (`src/config/schema-types.ts`) looks up
  `MODEL_SHORTHAND_TIERS[selection.model.toLowerCase()]` on the whole string, so `sonnet[medium]` misses
  the `sonnet` -> `balanced` alias, falls through to the literal path and warns at every resolution
  (three times in one workflow run). `resolvePlanModelSelection` (`src/cli/plan-runtime/index.ts`) goes
  further and replaces it with the default balanced model.

## Design

### Approach

One rule per issue, each owned by one story:

1. **Model specs (US-001).** Split the effort suffix off with `parseModelSpec` (exported by
   `@nathapp/nax-agent`) before any alias or tier lookup, resolve the base, then put the suffix back on
   the resolved model id. The config-site suffix replaces any suffix the tier entry already carries.
2. **Publish modes (US-002).** `workflow.publish` selects what `publish()` does after the final gates:
   `pr` (default, today's behaviour), `push` (push, wait for CI, open no PR, ask no approval; outcome
   `pushed`), `none` (no push, no PR; outcome `local-only`).
3. **Ledger commits (US-003).** A ledger-only commit (`git add` + `git commit --no-verify -- <ledger>`,
   message `chore(<feature>): advisor decisions`) runs before the first push and on every path that does
   not push, and again after the advisor's approval, followed by a second push when that commit was made.
   No `[skip ci]`: a skipped required check blocks a merge.
4. **Final run status (US-004).** After the end phase, a workflow-mode run whose feature workflow did not
   pass has its run status turned from `completed` into `failed`. A draft or local-only result with green
   gates stays `completed`, matching pipeline mode where a draft finish leaves `run.status: "completed"`
   and the detail lives in `postRun.finish`. The `status.json` workflow block carries `passed`.
5. **Flagged rulings (US-005).** After publish, the publish step collects the ids of trusted ledger
   decisions with `needsHumanConfirm: true`, stores them on the feature record, and every surface built
   from the record shows them: `result.json`, the `status.json` workflow block, the end-of-run summary log
   line and the headless footer (with the hint `nax advisor list -f <feature>`).

### Integration

Symbols the feature reads, verified on `main` `ee04b5483`:

- `parseModelSpec(raw: string): ModelSpec` — `packages/nax-agent/src/cost/model-spec.ts`, exported from
  `@nathapp/nax-agent`; `ModelSpec` is `{ model: string; effort?: string }`. Only a well-formed trailing
  `[..]` is a suffix.
- `MODEL_SHORTHAND_TIERS` (`haiku` -> `fast`, `sonnet` -> `balanced`, `opus` -> `powerful`),
  `resolveModelForAgent(models, agent, tier, defaultAgent): ModelDef`, `resolveTierMembership`,
  `resolveModel(entry: ModelEntry): ModelDef` — `src/config/schema-types.ts`.
- `ModelDef` — `{ provider: string; model: string; pricing?; contextWindow?; env? }`.
- `commitAndPush(repoRoot, branch, message, opts: { skipHooks?; skipCommit?; excludeDir? })` —
  `src/finish/commit.ts`; throws `NaxError` `FINISH_GIT_PUSH_FAILED` on a failed push.
- `ledgerPath(repoRoot, feature): string` — `src/advisor/ledger.ts`; resolves
  `.nax/features/<feature>/decisions.jsonl`.
- `readTrustedDecisions(repoRoot, feature, outputDir): Promise<AdviceDecision[]>` — `src/advisor/ledger.ts`.
  `AdviceDecision` has `id: string` and `needsHumanConfirm: boolean`.
- The pipeline-mode ledger commit to mirror: `commitLedger` in `src/finish/advise.ts` (`git add -- <path>`,
  `git diff --cached --quiet -- <path>`, `git commit --no-verify -m "chore(<feature>): advisor decisions" -- <path>`).
- `_featureDeps` (`src/workflow/feature-deps.ts`): `detectForge`, `commitAndPush`, `openDraftFinishPr`,
  `openOrPromotePr`, `waitForChecks`. `_workflowDeps.git(args, cwd)` (`src/workflow/step-context.ts`).
- `askApproval(advisor, { feature, evidence })` and `readinessReasons(facts)` — `src/workflow/approval.ts`.
- `runEndPhase(options, deps): Promise<boolean | undefined>` — `src/execution/end-phase.ts`; returns
  `undefined` in pipeline mode, the feature result's `passed` in workflow mode, `false` when the feature
  workflow throws.
- `runCompletionPhase(options)` — `src/execution/runner-completion.ts`; its `finishRun` calls
  `writeFinalFeatureStatus`, the run-end auto-commit, then `runEndPhaseReported`, and
  `persistFinishStatus` writes `status.json` (run and feature) afterwards.
- `StatusWriter.setRunStatus(status)` — `src/execution/status-writer.ts`; the run status union is
  `"running" | "completed" | "failed" | "stalled" | "crashed" | "precheck-failed" | "cost-limit" | "aborted"`.

Symbols the feature changes. The baseline is listed only to locate the code; implement the target.

- `resolveConfiguredModel(models, preferredAgent, selection, defaultAgent): ResolvedConfiguredModel`
  - Baseline: shorthand and tier lookups use `selection.model` whole.
  - Target: same signature; shorthand and tier lookups use the base from `parseModelSpec(selection.model)`;
    a resolved `modelDef.model` carries the selection's effort suffix when the selection had one.
- `isUnrecognizedLiteralModel(model: string): boolean`
  - Baseline: `!model.includes("/") && resolveModel(model).provider === "unknown"`.
  - Target: same signature; evaluates the base from `parseModelSpec(model)`, and returns `false` for a
    base that is a `MODEL_SHORTHAND_TIERS` key (case-insensitive).
    **Superseded by nax#2571:** `MODEL_SHORTHAND_TIERS` is removed; the signature gains `agent`,
    and haiku/sonnet/opus are recognised (case-sensitively) only for the `claude` agent.
- `WorkflowConfig` (`src/config/runtime-types-workflow.ts`) and `WorkflowConfigObjectSchema`
  (`src/config/schemas-workflow.ts`)
  - Target: new optional field `publish?: WorkflowPublishMode`, where
    `type WorkflowPublishMode = "pr" | "push" | "none"`; the schema field is
    `z.enum(["pr", "push", "none"]).default("pr")`. Readers treat an absent value as `"pr"`.
- `FIELD_DESCRIPTIONS` (`src/cli/config-descriptions.ts`) — new entry `"workflow.publish"` next to the
  other `workflow.*` keys, describing the three modes.
- `FeatureOutcome` (`src/workflow/types.ts`)
  - Baseline: `"ready" | "draft" | "local-only"`.
  - Target: `"ready" | "draft" | "local-only" | "pushed"`.
- `publish(fc, input): Promise<PublishOutcome>` (`src/workflow/finalize.ts`)
  - Target: same signature; branches on `fc.workflow.publish ?? "pr"` and runs the ledger commits below.
- `isFinishedAtHead(prior, head)` (`src/workflow/feature.ts`, file-local)
  - Target: also treats a prior with `outcome: "pushed"` at the same HEAD as finished.
- New: `commitLedger(projectDir: string, feature: string): Promise<boolean>` in `src/workflow/git.ts`,
  wired as `_featureDeps.commitLedger`; returns `true` only when it created a commit.
- `WorkflowStatusBlock` (`src/execution/status-file.ts`)
  - Baseline: `{ step; stories; outcome?; url? }`.
  - Target: adds `passed?: boolean` and `flagged?: string[]`.
- `workflowStatusBlock(stories, step, rec?)` (`src/workflow/status-block.ts`)
  - Baseline: `rec?: Pick<WorkflowFeatureRecord, "outcome" | "url">`.
  - Target: `rec?: Pick<WorkflowFeatureRecord, "outcome" | "url" | "passed" | "flaggedDecisions">`; copies
    `passed` when defined and `flagged` when `flaggedDecisions` is non-empty.
- `StatusWriter` — new read-only getter `runStatus` returning the value last passed to `setRunStatus`.
- New: `workflowFinalRunStatus(current: RunStatus | undefined, workflowPassed: boolean | undefined): RunStatus | undefined`
  in `src/execution/lifecycle/workflow-run-status.ts` (pure; `RunStatus` is the run status union above),
  called in `finishRun` right after `runEndPhaseReported` and before `persistFinishStatus`. The call site
  invokes `options.statusWriter.setRunStatus(next)` only when `next` differs from the writer's current
  `runStatus`, so pipeline mode and a passing workflow add no `setRunStatus` call (test writers built by
  `makeStatusWriter` mock `setRunStatus`, and assertions such as `toHaveBeenLastCalledWith("failed")` in
  `runner-completion-skip.test.ts` must keep holding). `runner-completion.ts` is 578 lines against the
  600-line source limit, so the rule lives in the new module and the call site adds no more than 3 lines.
- `WorkflowFeatureRecord` (`src/workflow/types.ts`) — new optional field
  `flaggedDecisions?: readonly string[]`.
- `FeatureSteps` (`src/workflow/feature-machine.ts`) — new optional step
  `flaggedDecisions?: () => Promise<readonly string[]>`, wired in `buildFeatureEnv`
  (`src/workflow/feature-env.ts`) to `_workflowDeps.readTrustedDecisions(fc.projectDir, fc.feature, fc.outputDir)`
  (the same seam `finalize.ts` uses) filtered to `needsHumanConfirm === true`, in ledger order.
- `WorkflowSummaryView` (`src/log-format/types.ts`) — new optional field
  `flagged?: { ids: readonly string[]; hint: string }`.
- `buildWorkflowRunSummary(result, timing, feature?: string)` (`src/workflow/run-summary.ts`) — new
  optional third parameter used for the hint; `readWorkflowRunSummary(projectDir, feature, runId, timing)`
  forwards its `feature` argument to it.

### Ledger commit and publish order

`pr` mode, forge present, publishable branch:

```
commitLedger -> push -> open draft PR -> wait for CI -> [askApproval
  -> commitLedger -> push again only if that commit was made] -> promote or keep the draft
```

`push` mode: `commitLedger -> push -> wait for CI`; no PR call, no `askApproval`, outcome `pushed`, `ci`
from the wait, `reasons` from `readinessReasons` with the CI result plus the dirty-tree reason (the flagged
count stays a reason).

`pr` mode with a deterministic readiness reason never asks the advisor, so no second ledger commit runs.

`none` mode, and every `local-only` path (no forge, a non-feature branch, a failed push): `commitLedger`
runs, nothing is pushed. A dry run skips `commitLedger` along with every other git write.

`publish()` grows by two modes and the ledger calls; keep it under the complexity limits by extracting
file-local helpers (for example one for the `push` branch and one fail-open wrapper around
`_featureDeps.commitLedger` that logs and returns `false` on a throw).

The `none` check runs first: on any branch, with or without a forge, `none` returns `local-only` with the
single target reason `publish disabled (workflow.publish: none)` after the readiness and dirty-tree reasons.
After `askApproval` (approved or held), the second ledger commit runs, because `askApproval` appends the
`finish-approval` decision either way.

### Failure Handling

| Failure | Behaviour |
|---|---|
| `commitLedger` throws (git missing, index locked) | Logged at warn with `storyId: "_run"`; `publish` continues as if no commit was made (fail-open). |
| The ledger file does not exist | `commitLedger` returns `false`; no commit, no error. |
| The second push (after the approval ledger commit) fails | Logged at warn with `storyId: "_run"`; promotion still runs and the outcome is unchanged. |
| `push` mode: the push fails | Outcome `local-only` with the `push failed: ...` reason, as in `pr` mode. |
| `push` mode: run aborted during the CI wait | Throws `NaxError` `WORKFLOW_ABORTED`, as in `pr` mode. |
| `flaggedDecisions` step throws (unreadable ledger) | Logged at warn with `storyId: "_run"`; the record gets no `flaggedDecisions`; publish outcome unaffected. |
| A suffixed shorthand whose base is not a known alias or tier (`sonet[medium]`) | Unchanged: resolves as a literal and warns. |

## Out of Scope

- Routing feature-scope (`_run`) advisor heads-ups through the story heads-up queue — the optional half of nax#2480; this spec only lists flagged rulings at run end.
- Per-run scoping or confirmation tracking of flagged decisions — the list is every trusted decision in the feature's ledger with `needsHumanConfirm: true`, across all runs of the feature.
- `[skip ci]` (or any CI-skip marker) on ledger commits — a skipped required check blocks a merge.
- Writing `postRun.finish` in workflow mode — callers read `run.status` and the `workflow` block.
- Changing pipeline-mode run status, finish behaviour or `postRun` contents.
- The `run:completed` reporters and the on-complete hook, which still fire before the end phase with the stories-only status.
- Reporting `aborted` for an abort during the feature workflow — such a run reports `failed`.
- Validating effort values inside the suffix (`[ultra]` passes through unchanged, as today).
- Re-running a feature whose prior run ended `local-only` (including `publish: "none"`) at the same HEAD — it runs the feature workflow again, as today.
- Any advisor approval, PR, or PR promotion in `push` mode — the caller owns the PR.
- Waiting for the CI run that the post-approval ledger push triggers — the PR is promoted on the CI result observed before the approval.
- `status.json` showing `run.status: "completed"` while the feature workflow is still running; the downgrade to `failed` lands when the end phase finishes.
- Flagged ids for a run that skips the feature workflow as already finished at the same HEAD — its `result.json` has no feature record, so the end-of-run summary shows no flagged list (the status block, built from the prior record, still carries it).
- koda-side changes (nathapp-io/koda#270) and nax-finish skill support for the new `pushed` outcome.

## Stories

### US-001 — Shorthand and tier models keep their effort suffix

Workdir: `packages/nax`

Changes `resolveConfiguredModel` and `isUnrecognizedLiteralModel` so a model selector with a trailing
`[effort]` resolves through the shorthand alias or tier of its base, with the suffix carried onto the
resolved model id; `resolvePlanModelSelection` then keeps such a `plan.model` instead of falling back.

Dependencies: none.

### US-002 — `workflow.publish` modes

Workdir: `packages/nax`

Adds the `workflow.publish` config field (`pr` default, `push`, `none`), the `pushed` feature outcome, the
`push` and `none` branches of `publish()`, and the already-finished skip for a `pushed` prior.

Dependencies: none.

### US-003 — Advisor ledger committed and pushed with the branch

Workdir: `packages/nax`

Adds `commitLedger` and calls it from `publish()` before the first push, on every non-pushing path, and
after the advisor's approval, with a second push when that commit was made.

Dependencies: US-002.

### US-004 — Final run status honours the feature workflow

Workdir: `packages/nax`

Adds `workflowFinalRunStatus`, the `StatusWriter.runStatus` getter, and the call after the end phase that
turns `completed` into `failed` when the feature workflow did not pass; the workflow status block carries
`passed`.

Dependencies: none.

### US-005 — Flagged rulings listed at run end

Workdir: `packages/nax`

Adds the `flaggedDecisions` feature step and record field, set by the publish step after publishing,
and shows the ids in the `status.json` workflow block, the end-of-run summary line and the headless
footer with the `nax advisor list -f <feature>` hint.

Dependencies: US-003, US-004.

Story split rationale: the project's `maxAcCount` is 24. Each issue touches a different seam (config
resolution, publish branching, git ledger commits, run completion, run-end reporting). US-002 and US-003
both edit `publish()` but merged would exceed 24 assertions; US-003 depends on US-002 so the ledger
calls land on the final branch structure. US-005 depends on US-004 because both extend
`workflowStatusBlock`, and on US-003 so the ids it reads include the approval decision.

### Context Files

**US-001**
- `packages/nax/src/config/schema-types.ts` — `resolveConfiguredModel`, `isUnrecognizedLiteralModel`, `MODEL_SHORTHAND_TIERS`, `resolveModelForAgent`
- `packages/nax-agent/src/cost/model-spec.ts` — `parseModelSpec`, the suffix grammar
- `packages/nax/src/cli/plan-runtime/index.ts` — `resolvePlanModelSelection`, the plan fallback
- `packages/nax/test/unit/config/schema-types.test.ts` — existing `resolveConfiguredModel` and `isUnrecognizedLiteralModel` tests
- `packages/nax/test/unit/cli/plan-runtime.test.ts` — existing `resolvePlanModelSelection` tests

**US-002**
- `packages/nax/src/workflow/finalize.ts` — `publish`, `publishTarget`, `pushBranch`, `finishPr`
- `packages/nax/src/config/schemas-workflow.ts` — `WorkflowConfigObjectSchema`, `WORKFLOW_DEFAULTS`
- `packages/nax/src/config/runtime-types-workflow.ts` — `WorkflowConfig`
- `packages/nax/src/workflow/feature.ts` — `isFinishedAtHead`, `runWorkflowFeature`
- `packages/nax/test/unit/workflow/finalize.test.ts` — the `wire()` forge fakes and publish tests

**US-003**
- `packages/nax/src/workflow/finalize.ts` — `publish`, where the ledger commits are called
- `packages/nax/src/workflow/git.ts` — `_workflowDeps.git` usage; `commitLedger` is added here
- `packages/nax/src/finish/advise.ts` — pipeline-mode `commitLedger`, the commit shape to mirror
- `packages/nax/src/workflow/feature-deps.ts` — `_featureDeps`, where `commitLedger` is wired
- `packages/nax/test/unit/workflow/finalize.test.ts` — the `wire()` forge fakes and publish tests

**US-004**
- `packages/nax/src/execution/runner-completion.ts` — `finishRun`, `persistFinishStatus`
- `packages/nax/src/execution/status-writer.ts` — `StatusWriter.setRunStatus`, `setWorkflowStatus`
- `packages/nax/src/workflow/status-block.ts` — `workflowStatusBlock`
- `packages/nax/test/unit/execution/runner-completion-finish.test.ts` — drives `runCompletionPhase` with a real `StatusWriter` and reads the written `status.json`
- `packages/nax/test/unit/execution/runner-completion-workflow-duration.test.ts` — how `runCompletionPhase` is driven in workflow mode with a faked feature workflow

**US-005**
- `packages/nax/src/workflow/feature-machine.ts` — `publishStep`, `FeatureSteps`, `runFeatureMachine`
- `packages/nax/src/workflow/feature-env.ts` — `buildFeatureEnv`, where the step is wired
- `packages/nax/src/workflow/run-summary.ts` — `buildWorkflowRunSummary`, `readWorkflowRunSummary`
- `packages/nax/src/log-format/workflow-summary.ts` — the headless footer's workflow lines
- `packages/nax/src/execution/workflow-end-report.ts` — `summaryLine`, the end-of-run summary log line

### Creates

**US-004**
- `packages/nax/src/execution/lifecycle/workflow-run-status.ts` — `workflowFinalRunStatus`

### Modifies

**US-001**

None. No existing test passes a suffixed shorthand or tier to `resolveConfiguredModel`,
`isUnrecognizedLiteralModel` or `resolvePlanModelSelection`.

**US-002**
- `packages/nax/test/unit/config/workflow-config.test.ts` — the test "defaults: pipeline mode, every workflow default filled (Zod 4 prefault)" asserts `parsed.workflow` equals an object without `publish`. Under US-002 the parsed defaults carry `publish: "pr"`; US-002 owns adding `publish: "pr"` to that expected object, keeping every other default as asserted.

- `packages/nax/test/unit/workflow/feature.test.ts` — the fixture helper `seedFinished` (line 77) types `over.outcome` as `"ready" | "draft" | "local-only"`, so the US-002 test of an already-finished `pushed` prior cannot be written against it. US-002 owns widening that parameter type to include `"pushed"`; existing callers are unchanged.

**US-003**
- `packages/nax/test/unit/workflow/finalize.test.ts` — `wire()` fakes every forge-side dep but not `_featureDeps.commitLedger`, so the real git would run against the fixture repo path. US-003 owns adding a `commitLedger` fake to `wire()` that records a `{ name: "ledger" }` call and returns a configurable boolean (default `true`), and updating the call-sequence assertions that the new ledger calls extend: the happy path (line 116) becomes ledger, push, draft, ci, ledger, push, promote; the local-only test "main, an empty branch, a dry run, or no forge" (line 157) expects one ledger call for each non-dry-run case and none for the dry run; the push-failure test (line 165) becomes ledger, push; the abort-during-CI test (line 214) becomes ledger, push, draft, ci; and any test added by US-002 that asserts a full call sequence gains the same ledger entries.

**US-004**
- `packages/nax/test/unit/workflow/feature.test.ts` — the test "an already-finished skip still emits the done status block" (line 166) asserts the block equals `{ step, stories, outcome, url }`. Its `seedFinished` prior has `passed: true`, so under US-004 the block also carries `passed: true`; US-004 owns adding `passed: true` to that expected block.

**US-005**

None. `flaggedDecisions` is absent on every existing record and fixture, and `workflowStatusBlock` and
`buildWorkflowRunSummary` add `flagged` only for a non-empty list.

### Seams

- `_featureDeps.commitLedger` (US-003, new) is invoked by `publish` — US-003's own ACs stub it and assert the call order through `publish`, the entry point the feature machine's publish step calls.
- `workflowFinalRunStatus` (US-004, new) is invoked from `runCompletionPhase` — US-004's integration ACs drive `runCompletionPhase` with a faked feature workflow and assert the persisted `status.json`.
- `flaggedDecisions` step (US-005, new) is invoked from the feature machine's publish step — US-005's ACs drive `runFeatureMachine` from the `publish` step with a stubbed step and assert the persisted record, and drive `buildFeatureEnv` against a real ledger for the wiring.
- `WorkflowStatusBlock.passed` (US-004) and `.flagged` (US-005) are produced by `workflowStatusBlock`, which the feature env's `sink.step` and `runWorkflowFeature`'s already-finished skip both call.

## Acceptance Criteria

### US-001

- [unit] `resolveConfiguredModel` with `models.claude = { fast: "claude-haiku-5", balanced: "claude-sonnet-5", powerful: "claude-opus-5" }` and selection `{ agent: "claude", model: "sonnet[medium]" }` returns `modelTier: "balanced"` and `modelDef.model: "claude-sonnet-5[medium]"`.
- [unit] With the same models, selection `{ agent: "claude", model: "haiku[low]" }` returns `modelTier: "fast"` and `modelDef.model: "claude-haiku-5[low]"`.
- [unit] With the same models, selection `{ agent: "claude", model: "opus[high]" }` returns `modelTier: "powerful"` and `modelDef.model: "claude-opus-5[high]"`.
- [unit] With the same models, selection `{ agent: "claude", model: "Sonnet[high]" }` returns `modelTier: "balanced"` and `modelDef.model: "claude-sonnet-5[high]"`.
- [unit] When `models.claude.balanced` is `"claude-sonnet-5[high]"`, selection `{ agent: "claude", model: "sonnet[low]" }` returns `modelDef.model: "claude-sonnet-5[low]"` (the selection's suffix replaces the tier entry's).
- [unit] When `models.claude.balanced` is `"claude-sonnet-5[high]"`, selection `{ agent: "claude", model: "sonnet" }` returns `modelDef.model: "claude-sonnet-5[high]"` (no selection suffix leaves the entry's suffix in place).
- [unit] When `models.claude.balanced` is the object `{ provider: "anthropic", model: "claude-sonnet-5", contextWindow: 200000 }`, selection `{ agent: "claude", model: "sonnet[medium]" }` returns a `modelDef` with `provider: "anthropic"`, `contextWindow: 200000` and `model: "claude-sonnet-5[medium]"`.
- [unit] Selection `{ agent: "claude", model: "balanced[high]" }` returns `modelTier: "balanced"` and `modelDef.model: "claude-sonnet-5[high]"`.
- [unit] Resolving selection `{ agent: "claude", model: "sonnet[medium]" }` logs no warn entry with the message "Configured model is neither a tier nor a recognizable model id — dispatching as a literal".
- [unit] Resolving selection `{ agent: "claude", model: "sonet[medium]" }` logs that warn message once, and returns `modelTier: undefined` and `modelDef.model: "sonet[medium]"`.
- [unit] `isUnrecognizedLiteralModel("sonnet[medium]")` returns `false`.
- [unit] `isUnrecognizedLiteralModel("sonet[medium]")` returns `true`.
- [unit] `isUnrecognizedLiteralModel("claude-opus-5[high]")` returns `false`.
- [unit] `isUnrecognizedLiteralModel("turbo[high]")` returns `true`.
- [unit] `resolvePlanModelSelection` with `plan.model: { agent: "claude", model: "sonnet[high]" }` and the claude models above returns `modelTier: "balanced"` and `modelDef.model: "claude-sonnet-5[high]"`, and logs no "plan.model is neither a tier nor a recognizable model id" warning.

### US-002

- [unit] `NaxConfigSchema.parse({}).workflow.publish` equals `"pr"`.
- [unit] `NaxConfigSchema.safeParse({ workflow: { publish: "push" } })` succeeds with `workflow.publish` `"push"`, and the same for `"none"`.
- [unit] `NaxConfigSchema.safeParse({ workflow: { publish: "draft" } })` fails.
- [unit] `publish` with `fc.workflow.publish` `"none"` on a publishable branch with a forge calls none of `_featureDeps.detectForge`, `commitAndPush`, `openDraftFinishPr`, `waitForChecks` or `openOrPromotePr`, and returns `outcome: "local-only"` and `ci: "skipped"`.
- [unit] `publish` with `fc.workflow.publish` `"none"` returns `reasons` whose last entry is `"publish disabled (workflow.publish: none)"`.
- [unit] `publish` with `fc.workflow.publish` `"push"` calls `_featureDeps.commitAndPush` with `skipCommit: true` and then `_featureDeps.waitForChecks`, and never calls `openDraftFinishPr` or `openOrPromotePr`.
- [unit] `publish` with `fc.workflow.publish` `"push"` and a CI wait returning `green` returns `outcome: "pushed"`, `ci: "green"`, no `url`, and empty `reasons` when the record's final gates are green, `reviewRan` is `true`, every story is complete, nothing is flagged and the tree is clean.
- [unit] `publish` with `fc.workflow.publish` `"push"` never asks the advisor: an advisor fake that records questions records none.
- [unit] `publish` with `fc.workflow.publish` `"push"` and a CI wait returning `failed` returns `outcome: "pushed"` with `"CI failed"` in `reasons`.
- [unit] `publish` with `fc.workflow.publish` `"push"` and an uncommitted non-`.nax` file in the tree returns `outcome: "pushed"` with `"uncommitted changes after the branch fix"` in `reasons`.
- [unit] `publish` with `fc.workflow.publish` `"none"` on branch `main` returns `reasons` whose last entry is `"publish disabled (workflow.publish: none)"` and that do not mention the branch.
- [unit] `FIELD_DESCRIPTIONS["workflow.publish"]` is a non-empty string.
- [unit] `publish` with `fc.workflow.publish` `"push"` and `input.flagged` `2` returns `"2 ruling(s) flagged for a human"` in `reasons`.
- [unit] `publish` with `fc.workflow.publish` `"push"` and a failing push returns `outcome: "local-only"` with a reason starting `"push failed: "`, and never calls `waitForChecks`.
- [unit] `publish` with `fc.workflow.publish` `"push"` and no forge detected returns `outcome: "local-only"` with the reason `"no forge detected (origin is not GitHub or GitLab)"`.
- [unit] `publish` with `fc.workflow.publish` `"push"` rejects with a `NaxError` of code `WORKFLOW_ABORTED` when the run signal is aborted during the CI wait.
- [unit] `publish` with `fc.workflow` lacking `publish` follows the `pr` path: push, draft PR, CI wait, then `openOrPromotePr`.
- [unit] `runWorkflowFeature` with a prior feature record at the current HEAD with `step: "done"` and `outcome: "pushed"` returns `outcome: "already-finished"` without running the feature machine.

### US-003

- [integration] In a temporary git repository with a committed `.nax/features/f/decisions.jsonl`, appending a line to it and calling `commitLedger(repo, "f")` returns `true` and creates exactly one commit with the message `chore(f): advisor decisions` whose only changed path is `.nax/features/f/decisions.jsonl`.
- [integration] In the same setup with an unrelated modified tracked file, `commitLedger(repo, "f")` leaves that file modified and uncommitted.
- [integration] `commitLedger(repo, "f")` returns `false` and creates no commit when `decisions.jsonl` has no changes.
- [integration] `commitLedger(repo, "f")` returns `false` and does not throw when `.nax/features/f/decisions.jsonl` does not exist.
- [unit] `publish` in `pr` mode calls `_featureDeps.commitLedger` before its first `_featureDeps.commitAndPush` call.
- [unit] `publish` in `pr` mode, when the advisor approves and the second `commitLedger` call returns `true`, calls `commitAndPush` a second time with `skipCommit: true` before `openOrPromotePr`; the call order is ledger, push, draft, ci, ledger, push, promote.
- [unit] `publish` in `pr` mode, when the advisor approves and the second `commitLedger` call returns `false`, calls `commitAndPush` exactly once.
- [unit] `publish` in `pr` mode, when the advisor holds and the second `commitLedger` call returns `true`, calls `commitAndPush` a second time before `openOrPromotePr` is called with `keepDraft: true`.
- [unit] `publish` in `pr` mode with a deterministic readiness reason (a gate-open story) calls `commitLedger` exactly once and `commitAndPush` exactly once.
- [unit] `publish` in `pr` mode, when the second push throws, still calls `openOrPromotePr` with `keepDraft: false` and returns `outcome: "ready"`, and logs a warn entry with `storyId: "_run"`.
- [unit] `publish` on a non-feature branch (`main`) calls `commitLedger` once and never calls `commitAndPush`.
- [unit] `publish` with no forge detected calls `commitLedger` once and never calls `commitAndPush`.
- [unit] `publish` with `fc.workflow.publish` `"none"` calls `commitLedger` once and never calls `commitAndPush`.
- [unit] `publish` in `push` mode calls `commitLedger` exactly once, before `commitAndPush`.
- [unit] `publish` with `fc.dryRun` true never calls `commitLedger`.
- [unit] `publish` in `pr` mode, when `commitLedger` throws, still calls `commitAndPush` and logs a warn entry with `storyId: "_run"`.

### US-004

- [unit] `workflowFinalRunStatus("completed", false)` returns `"failed"`.
- [unit] `workflowFinalRunStatus("completed", true)` returns `"completed"`.
- [unit] `workflowFinalRunStatus("completed", undefined)` returns `"completed"`.
- [unit] `workflowFinalRunStatus(undefined, false)` returns `undefined`.
- [unit] `workflowFinalRunStatus("cost-limit", false)` returns `"cost-limit"`, and `workflowFinalRunStatus("failed", false)` returns `"failed"`.
- [unit] A `StatusWriter` after `setRunStatus("cost-limit")` reports `runStatus` `"cost-limit"`.
- [integration] `runCompletionPhase` in workflow mode, using a real `StatusWriter` that writes a temporary `status.json` and whose run status is `"completed"` before the call (`handleRunCompletion` faked as in the workflow-duration suite), with `_runnerCompletionDeps.runWorkflowFeature` faked to return `{ passed: false, outcome: "draft", reasons: ["gates red: test"] }`, writes `status.json` with `run.status` `"failed"`.
- [integration] `runCompletionPhase` in workflow mode, using a real `StatusWriter` that writes a temporary `status.json` and whose run status is `"completed"` before the call (`handleRunCompletion` faked as in the workflow-duration suite), with `_runnerCompletionDeps.runWorkflowFeature` faked to return `{ passed: true, outcome: "draft", reasons: ["CI failed"] }`, writes `status.json` with `run.status` `"completed"`.
- [integration] `runCompletionPhase` in workflow mode, using a real `StatusWriter` that writes a temporary `status.json` and whose run status is `"completed"` before the call (`handleRunCompletion` faked as in the workflow-duration suite), with `_runnerCompletionDeps.runWorkflowFeature` faked to throw a plain error, writes `status.json` with `run.status` `"failed"`.
- [integration] `runCompletionPhase` in pipeline mode with a `makeStatusWriter` writer makes no `setRunStatus` call after the end phase: its last `setRunStatus` call is the one `writeFinalFeatureStatus` made.
- [integration] `runCompletionPhase` in workflow mode with a `makeStatusWriter` writer and `_runnerCompletionDeps.runWorkflowFeature` faked to return `{ passed: true, outcome: "ready", reasons: [] }` makes no `setRunStatus` call after the end phase.
- [unit] `workflowStatusBlock(stories, "done", { outcome: "draft", passed: true })` returns a block with `passed: true` and `outcome: "draft"`.
- [unit] `workflowStatusBlock(stories, "publish", { outcome: "draft" })` returns a block without a `passed` key.
- [unit] `workflowStatusBlock(stories, "done", { outcome: "ready", passed: false })` returns a block with `passed: false`.

### US-005

- [unit] The feature env built by `buildFeatureEnv`, with `_workflowDeps.readTrustedDecisions` stubbed to return decisions `D-1` (`needsHumanConfirm: true`), `D-2` (`false`) and `D-3` (`true`), resolves `steps.flaggedDecisions()` to `["D-1", "D-3"]`.
- [unit] `steps.flaggedDecisions()` resolves to `[]` when `_workflowDeps.readTrustedDecisions` resolves to `[]`.
- [unit] `runFeatureMachine` started at the `publish` step, with a `flaggedDecisions` step resolving `["D-1"]`, ends with a record whose `flaggedDecisions` is `["D-1"]`, and calls `flaggedDecisions` after `publish`.
- [unit] `runFeatureMachine` started at the `publish` step, with a `flaggedDecisions` step that rejects, ends with `step: "done"`, the publish outcome recorded, no `flaggedDecisions` on the record, and one warn entry with `storyId: "_run"`.
- [unit] `runFeatureMachine` started at the `publish` step with no `flaggedDecisions` step ends with no `flaggedDecisions` on the record.
- [unit] The record persisted to `result.json` by the feature env's `sink.update` after that publish step carries `featureWorkflow.flaggedDecisions` `["D-1"]`.
- [unit] `workflowStatusBlock(stories, "done", { outcome: "local-only", flaggedDecisions: ["D-1", "D-3"] })` returns a block with `flagged: ["D-1", "D-3"]`.
- [unit] `workflowStatusBlock(stories, "done", { outcome: "ready", flaggedDecisions: [] })` returns a block without a `flagged` key.
- [unit] `buildWorkflowRunSummary(result, timing, "f")` for a result whose feature record has `outcome: "local-only"` and `flaggedDecisions: ["D-1"]` returns `flagged: { ids: ["D-1"], hint: "nax advisor list -f f" }`.
- [unit] `buildWorkflowRunSummary(result, timing, "f")` for a record with `outcome: "ready"` and `flaggedDecisions: ["D-2"]` also returns `flagged` with ids `["D-2"]`.
- [unit] `buildWorkflowRunSummary(result, timing)` with no feature argument returns the hint `"nax advisor list"` for a non-empty list.
- [unit] `buildWorkflowRunSummary` returns no `flagged` key when the record has no `flaggedDecisions`.
- [unit] `formatWorkflowSummary` for a view with `flagged: { ids: ["D-1", "D-3"], hint: "nax advisor list -f f" }` includes a line containing `Flagged for a human:`, `D-1, D-3` and `nax advisor list -f f`.
- [unit] `reportWorkflowRun` for a run whose `result.json` record has `flaggedDecisions: ["D-1"]` logs the `Workflow summary:` info line containing `flagged 1 (nax advisor list -f <feature>)` with the run's feature name.
