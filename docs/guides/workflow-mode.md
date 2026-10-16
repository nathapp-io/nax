---
title: Workflow Mode
description: The default execution mode for nax run - the per-story loop, the feature workflow, publishing, and the workflow config block
---

# Workflow Mode

Workflow mode is the default execution mode for `nax run` (since v0.88.0). It is set with
`execution.mode` and runs when the key is absent or `"workflow"`. The decision and its trade-offs are in
[ADR-034](../adr/ADR-034-workflow-execution-mode.md). The code lives in `packages/nax/src/workflow/`.

`execution.mode: "pipeline"` is deprecated. nax warns once at config load and the mode is frozen; it will be
removed in a future release. The pipeline-era guides (acceptance tests, test strategies, the regression gate,
parallel execution) describe pipeline behaviour that workflow mode does not run; see
[What workflow mode changes](#what-workflow-mode-changes).

```json
{
  "execution": { "mode": "workflow" },
  "workflow": {
    "maxFixRounds": 5,
    "maxBranchFixRounds": 2,
    "finalGateRepairRounds": 1,
    "preflight": true,
    "publish": "pr"
  }
}
```

## How a run is organised

A run has two levels:

1. **Per story**, in dependency order, one story at a time: an implement turn, deterministic gates, an LLM
   story review, and a bounded fix loop. Each story closes with an end state.
2. **Per feature**, once after the last story: repo gates, one whole-branch review, branch fix rounds with a
   scoped re-review each, adjudication, final gates, and publishing.

Gates are deterministic. The LLM reviewers and the advisor decide what to fix and what to defer. Nothing in
the workflow merges a pull request.

### Per-story loop

1. **Implement.** One implementer session per story writes the tests and the code, runs them, commits, and
   writes a report. If the implementer produces no work, a no-work ladder retries before the story closes as
   `complete-gate-open`.
2. **Gates.** After each turn: `lint`, `typecheck` and `scoped` (scoped tests). Gate names are the
   `GateName` values `lint`, `typecheck`, `scoped` and `full-suite`.
3. **Story review.** When the gates are green, one review session returns a spec verdict and a quality verdict
   over the story diff. A verdict of "changes" with no blocking finding is treated as a finding, so the fix
   pass always has something to act on.
4. **Fix rounds.** Open findings go back to the implementer. The run allows up to `workflow.maxFixRounds`
   rounds (default 5). Rounds after the warm cap are fresh sessions. Minor findings are recorded in the ledger
   as deferred items and do not re-enter the loop.
5. **Full suite.** Once the review passes, the `full-suite` gate runs once.
6. **Residual.** Findings still open when the rounds run out go to one batched advisor call. A missing or failed
   answer becomes a `hold`.

The story closes with one of three end states:

| End state | Meaning |
|:----------|:--------|
| `complete` | Gates green, review clean, no rulings |
| `complete-with-rulings` | Closed, but the advisor or the default hold ruled on at least one residual item |
| `complete-gate-open` | A gate is still red, the implementer produced no work, the workflow errored, or the cost limit stopped the loop |

The cost limit is `execution.costLimit` (USD, default 30). When it is reached, the story loop stops with
reason `cost-limit`.

### Feature workflow

After the last story, the feature runs these steps in order (`FeatureStep`):

| Step | What it does |
|:-----|:-------------|
| `repo-gates` | Repo-level quality gates (`quality.commands`) |
| `branch-review` | One review of the whole branch |
| `branch-fix` | Fix pass on the branch findings; repeated up to `workflow.maxBranchFixRounds` (default 2) |
| `branch-rereview` | Scoped re-review after each branch fix round |
| `adjudicate` | Advisor adjudication of what remains |
| `final-gates` | Repo gates again |
| `gate-repair` | Up to `workflow.finalGateRepairRounds` (default 1) repair passes, only if the branch fix turned a green gate red |
| `publish` | See [Publishing](#publishing) |
| `done` | Record closed |

If the cost limit is reached, the feature skips the agent steps, runs the final gates, and publishes a draft.
If a prior record exists for the same HEAD and is finished, the feature is skipped. A crashed run resumes at
its recorded step.

## Publishing

`workflow.publish` selects how far publishing goes:

| Value | Behaviour |
|:------|:----------|
| `"pr"` (default) | Commit the ledger, push, open or find a draft PR/MR, wait for CI, ask the advisor for approval only when no deterministic reason keeps the PR a draft, then promote the draft or leave it as a draft |
| `"push"` | Commit the ledger, push, wait for CI, stop. nax opens no PR |
| `"none"` | Touches nothing |

The feature ends with one outcome: `ready`, `draft`, `local-only` or `pushed`. A non-feature branch, a dry
run, or no configured forge ends as `local-only`.

Readiness is decided by deterministic reasons first. These include failing final gates, failed or conflicting CI,
no CI checks reported, stories that are `complete-gate-open` or not run, rulings flagged for a human, a branch
review that did not run or left items unread, and a ledger that did not reach the branch. The advisor is
consulted only when none of these apply.

PR bodies list the closing issues the feature spec declares with a `Closes:` line outside any code fence, for
example `Closes: #12, #13`. Prose mentions of issues are not parsed.

CI waiting uses `workflow.timeouts.ciWaitMs` (default 20 minutes) and polls every `ciPollMs` (default 30 s).
A timeout with no checks reads as `no-checks`. Slow CI reads as `pending`. Neither counts as a failure.

## What workflow mode changes

Workflow mode forces some settings whatever the config says (`applyWorkflowMode` in `src/config/workflow-mode.ts`):

| Setting | Effect in workflow mode |
|:--------|:------------------------|
| `acceptance.enabled` | Forced off. The acceptance-test pipeline does not run |
| `execution.storyIsolation` | Forced to `shared`. A `worktree` setting produces a warning |
| `advisor.enabled` | Forced on |
| `nax run --parallel <n>` | Ignored (the run is sequential) |
| Story batching | Disabled. Each story runs alone |

The per-story test strategy (`testStrategy` in `prd.json`) and `tdd.strategy` are not read by the workflow
story loop. The regression gate of the pipeline is replaced by the `full-suite` gate at story level and the
`final-gates` step at feature level.

## Advisor

In workflow mode the advisor answers only judgment calls: implementer questions, residual items after the fix
rounds, preflight, and the finish approval. A ruling is recorded in the run ledger and in the PR body. A ruling
that needs human confirmation is shown in the draft PR. The run does not stop to wait for it.

Advisor settings are in the `advisor` block; see the [Configuration Guide](configuration.md).

## Preflight

With `workflow.preflight` on (default), the advisor scans the PRD before the first story for stories that share
files or interfaces and for contradictions between the spec and the acceptance criteria. Its result is written to
`preflight.json`. The newest reusable `preflight.json` from an earlier run of the same feature is reused.

## Artifacts

Workflow state is written under the feature directory, so agents can read briefs and reports with their file
tools. The `workflow/` tree is git-ignored.

```text
.nax/features/<feature>/workflow/
  <runId>/
    ledger.md          run ledger: rulings, step lines, deferred minors
    preflight.json     pre-flight result (when enabled)
    <storyId>/         per-story brief, reports and review packages
```

## Configuration reference

All keys live under the top-level `workflow` block unless noted.

| Key | Default | Notes |
|:----|:--------|:------|
| `execution.mode` | `"workflow"` | `"pipeline"` is deprecated |
| `execution.costLimit` | `30` | USD. Shared with the pipeline; see [Configuration](configuration.md) |
| `workflow.maxFixRounds` | `5` | Minimum 1. Per-story fix rounds |
| `workflow.maxBranchFixRounds` | `2` | Minimum 0. Feature-level branch fix rounds |
| `workflow.finalGateRepairRounds` | `1` | Minimum 0 |
| `workflow.preflight` | `true` | Advisor pre-flight before the first story |
| `workflow.publish` | `"pr"` | `"pr"`, `"push"` or `"none"` |
| `workflow.models.storyReview` | unset | Model for the story review |
| `workflow.models.branchReview` | unset | Model for the branch review |
| `workflow.models.branchFix` | unset | Model for the branch fix |
| `workflow.timeouts.implementMs` | 3600000 | Implement turn |
| `workflow.timeouts.fixMs` | 3600000 | Fix turn |
| `workflow.timeouts.reviewMs` | 1800000 | Review turn |
| `workflow.timeouts.ciWaitMs` | 1200000 | Total CI wait |
| `workflow.timeouts.ciPollMs` | 30000 | CI poll interval |

## Related

- [ADR-034: Workflow Execution Mode](../adr/ADR-034-workflow-execution-mode.md)
- [Configuration Guide](configuration.md)
- [CLI Reference](cli-reference.md)
- [Permissions](permissions.md)
- [Approvals](approvals.md)
- [Documentation index](../README.md)
