# SPEC: Run integrity — preserve worktrees, honor pause, identify logs and bind green CI to the checked head

## Summary

Ship the four fixes explicitly marked **Fix first** in `docs/reviews/nax-v0.94.2-verified-code-review.md` as one nax workflow run. These are in-place changes in `packages/nax`. Each story has an independent regression. Review numbers below refer to that document, not GitHub issues.

## Motivation

At `5a112f0a2`, the revised review reproduced loss of work in a disposable Git repository (#4), showed that independent package stories can continue after a root `PAUSE` (#1), selected a newer run's log for an older ID and the wrong latest replay across workdirs (#2), and obtained a green CI verdict for expected B despite two head reads reporting A (#3). The worktree regression must protect identical concurrent comparisons, not just ambiguous tuple encodings.

## Design

### Integration and failure handling

The baseline descriptions locate current behavior; the targets are the intended contracts.

- **Compare ownership (#4).** Baseline: `runBakeoff` reclaims stale branches before validation; `WorktreeManager.create` tries to clear the derived path, and `runContestant` cleans up in `finally` even when create failed. Target: acquire exclusive comparison ownership for the checkout before reclaim/create and hold it through cleanup. A contender fails before mutating Git state. Ownership is per invocation, not merely a feature name or a branch prefix. A successful creator may clean its own allocation; a failed or stale owner may not clean a successor's. An existing registered tree with no proof of ownership, including a legacy name, is left intact. Keep branch-only orphan recovery distinct from live-tree replacement. Use the existing checkout lock contract where possible; inner runs must still operate in their own contestant workdirs without deadlocking on the parent lock. Disambiguate the original tuple before lossy sanitization/truncation in both ID namespaces; retain the existing validator, namespace prefixes and 64-character bound.
- **Between-story stop (#1).** Baseline: `queueCheckStage` consumes under the selected story's `workdir`, and a pause result marks that story paused. Target: consume operator commands at their run root and distinguish *operator paused run* from *one story needs a human*. The former terminates dispatch without skipping or failing pending work. Extend the persisted run-status union with `paused` for this stop: both project and feature snapshots carry it under `run.status`, not in a story status field. Preserve the current command parser, ordering and dropped-command audit. Package-relative payloads retain their documented resolution semantics. No interruption of an in-flight implementer.
- **Run artifacts (#2).** Baseline: the CLI opens a timestamped log before invoking the runner, registry metadata records `eventsDir`, exact lookup can fall back to a sibling, and `discoverRun` compares ID strings for latest. Target: use `buildRunId` with the ordinary run workdir, as resume does, before opening a new ordinary run log; persist its actual filename as an optional basename in run metadata relative to `eventsDir` (example: `"logFileName": "run-abcd1234-2026-11-28T10-00-00.000.jsonl"`). Use that filename for the selected record; absent on a legacy record, try only `<runId>.jsonl`. A missing log may degrade replay to metrics/status, never another run's events. Default replay orders by start chronology, not by when the subscriber managed to write the file: source new `registeredAt` values from the runner start instant already on the executor context. Rank valid instants descending, then missing/unparseable instants; within an equal rank and time (including two undated records), retain the descending run-ID tie break. For feature-directory logs, preserve chronological default selection and list ordering for timestamp-only and new canonical filenames. Preserve log rendering apart from extracting the timestamp for the existing list column; registry metadata gains the optional field above. Apply the same filename safety rules to a declared basename and to the legacy exact-name candidate. For an invalid filename report unavailable; never use the mutable latest alias or follow a symlink outside the events directory.
- **GitHub wait (#3).** Baseline: the stable head recovered by the reads bracketing `gh pr checks` is attached to failed polls but not passing ones. Target on the expected-head GitHub wait only: give an otherwise SHA-less passing poll that same head before expected-head comparison. Do not replace an inline SHA, interpret movement as stability, or change the existing policy when *no* head is available. Keep one-shot, GitLab and commit-check paths unchanged.

## Out of Scope

- Findings 5–14 of the revised v0.94.2 report, including MCP retries, ACP shutdown, native memory retention, image sidecars and replay performance, are deferred.
- No rewrite of historical JSONL files, registry migration, or guessing legacy log identity from a timestamp, directory order or file modification time.
- No change to CI readiness policy for a genuinely unreadable head, forge support, poll timing or retry limits.
- No mid-story cancellation, queue syntax redesign, or automatic resumption of genuinely blocked stories.
- No automatic deletion or migration of old live worktrees or operator recovery of work already lost. Do not change global stale-lock timeouts or recovery policy.
- US-003 only: No new CLI switches or changes to log output streams, exit codes or formats apart from the specified selection, timestamp display and unavailable-log behavior.
- US-004 only: No change to the GitLab, commit-check or one-shot CI paths.
- No release, new package, config profile, or network-dependent acceptance test.

## Stories

**US-001: Isolate comparison worktrees and cleanup (#4).** Workdir: `packages/nax`. No dependencies. Protect the whole comparison, not just a single contestant. Use disposable repositories with a committed feature PRD and valid offline contestant profiles. Hold the winning allocation at a barrier after committing a unique change on its branch and recording that tip and writing a dirty sentinel, then attempt the competing create; do not synchronize with sleeps. For reuse, hold the earlier cleanup callback, retire its allocation, create a successor and only then release the old callback.

**US-002: Stop the run at the operator's pause boundary (#1).** Workdir: `packages/nax`. No dependencies. Drive the actual dispatch loop with independent stories and a fake implementer; asserting the first stage's return alone cannot establish the run stopped.

**US-003: Bind run registration, log lookup and replay to one identity (#2).** Workdir: `packages/nax`. No dependencies. Exercise real temporary logs and registry records. For replay seed matching per-run metrics with the tested story ID and a JSONL record for that ID at stage `story-orchestrator` with message `Phase passed: older` (distinct phase names in decoys). For filename chronology, use a temporary single-feature project and place the shared runs directory where plain `logs` reads it, under that project’s `.nax/features/<feature>/runs`. Generate IDs for two distinct workdirs with `buildRunId`, assigning the earlier instant to the higher hash. Also exercise a mix with a newer legacy timestamp-only filename in that directory; this tests directory browsing, not guessing an exact registry match.

**US-004: Check a recovered SHA before accepting a green poll (#3).** Workdir: `packages/nax`. No dependencies. Exercise the public wait with a scripted forge and bounded clock; do not test only the bracket helper.

### Context Files

**US-001**
- `packages/nax/src/worktree/worktree-id.ts` — tuple formatting and validation.
- `packages/nax/src/worktree/manager.ts` — creation, reclamation and removal.
- `packages/nax/src/bakeoff/coordinator.ts` — outer comparison boundary.
- `packages/nax/src/bakeoff/contestant.ts` — creator and cleanup owner.
- `packages/nax/src/execution/lock.ts` — existing checkout lock semantics.

**US-002**
- `packages/nax/bin/run-action-execute.ts` — TUI queue writer.
- `packages/nax/src/pipeline/stages/queue-check.ts` — queue consumption.
- `packages/nax/src/execution/iteration-runner.ts` — project versus package directory.
- `packages/nax/src/execution/pipeline-result-handler.ts` — story-level results.
- `packages/nax/src/execution/unified-executor-dispatch-phases.ts` — subsequent dispatch decision.

**US-003**
- `packages/nax/bin/run-action.ts` — initial log creation.
- `packages/nax/bin/run-action-execute.ts` — runner options.
- `packages/nax/src/pipeline/subscribers/registry.ts` — metadata contract.
- `packages/nax/src/commands/logs-reader.ts` — explicit ID lookup.
- `packages/nax/src/replay/discovery.ts` — selected run and backing log.

**US-004**
- `packages/nax/src/workflow/ci-wait-head-bind.ts` — fallback head handling.
- `packages/nax/src/workflow/ci-wait.ts` — polling and expected-head comparison.
- `packages/nax/test/unit/workflow/ci-wait-sha.test.ts` — fake forge and unknown-head controls.

### Modifies

**US-001**
- `packages/nax/test/integration/worktree/manager.test.ts` — replace second-create success for a registered live tree with refusal preserving sentinel and branch tip; keep successful recovery of a prunable record whose directory is gone.
- `packages/nax/test/integration/worktree/manager-worktree-id.test.ts` — calculate expected path and branch using the new bounded tuple ID; preserve isolation and orphan-branch recovery assertions.
- `packages/nax/test/unit/worktree/nax-orphan-ref.test.ts` — preserve refs/nax/orphan namespace but derive the suffix from the supplied typed ID rather than the old encoder spelling.
- `packages/nax/test/unit/execution/pipeline-result-handler-worktree-cleanup.test.ts` — assert cleanup uses the derived worktree ID rather than the raw story ID; update outdated expected short-name literals.
- `packages/nax/test/unit/worktree/manager.test.ts` — replace the live-tree force-removal/orphan-ref assertion with refusal and preservation of the live tree; replace the no-tree fixture’s expected removal warning with no attempt to remove an unowned tree. Retain verified branch-only orphan cases.
- `packages/nax/test/unit/worktree/worktree-id.test.ts` — replace fixed ID, path and branch literal expectations where derived names change with bounded, deterministic, tuple-distinct IDs. Preserve namespace, length and validation assertions, including overlong inputs.
- `packages/nax/test/unit/worktree/bakeoff-worktree-id.test.ts` — short derived IDs need not equal `bakeoff-f-agent`; retain deterministic, branded and prefix guarantees.
- `packages/nax/test/unit/bakeoff/contestant.test.ts` — cleanup expectations must distinguish successful allocation from a create failure that confers no ownership.
- `packages/nax/test/unit/bakeoff/coordinator.test.ts` — isolate outer-lock acquisition on the fictitious shared project root; retain the coordinator sequencing and result assertions.
- `packages/nax/test/unit/bakeoff/run-action.test.ts` — give tests reaching the real coordinator an isolated writable checkout or lock double; keep the PRD and dispatch guards.

**US-002**
- `packages/nax/test/unit/pipeline/stages/queue-check.test.ts` — the operator PAUSE result may carry a run-level discriminator; continue to verify queue consumption and dropped-command auditing.

**US-003**
- `packages/nax/test/unit/replay/discovery.test.ts` — replace the lexicographically greatest-ID latest-run contract with timestamp ordering and deterministic ties.

### Seams

None across stories: each story wires and exercises its own production path. Suggested implementation order is the numbering above, not a dependency graph.

## Acceptance Criteria

### US-001

1. [unit] Within each of `deriveStoryWorktreeId` and `deriveBakeoffWorktreeId`, `(billing-api, retry-1)` and `(billing, api-retry-1)` yield distinct IDs accepted by `validateStoryId`. Repeat with `(f, a!)` versus `(f, a?)`, whose raw inputs differ before sanitization.
2. [integration] While one `run --compare` owns the checkout, an identical competing invocation reports a lock conflict before its stale-branch sweep or any contestant create.
3. [integration] Given two competing `WorktreeManager.create` requests for the same ID, the losing request leaves the winner's uncommitted sentinel contents intact in its worktree.
4. [integration] A refused `WorktreeManager.create` leaves the winner's unique commit reachable by its original branch at the same SHA.
5. [integration] When create refuses an occupied path, `runContestant` makes zero calls to the manager's `remove` method. Include refusal against a seeded legacy tree; changing the derived ID must not let an unconditional cleanup pass just because it targets a different path.
6. [integration] A delayed `runContestant` cleanup for an earlier contestant cannot remove the tree of a subsequent owner using the same ID.
7. [integration] A successful `run --compare` cleans up its own contestant worktree.
8. [integration] After a contestant failure a later `run --compare` can acquire the released outer lock.
9. [integration] With a live legacy `nax/bakeoff-f-agent` tree for feature f and profile agent, `run --compare` leaves its dirty sentinel and original branch tip untouched through preflight and contestant cleanup. Seed the old name literally, not via the changed encoder.

### US-002

1. [integration] When an operator writes `PAUSE` at the run root during a package story, the in-flight story is allowed to finish.
2. [integration] With two independent package stories remaining, a root `PAUSE` causes zero further implementer calls in that invocation.
3. [integration] After completion and finish-status reconciliation return from an operator `PAUSE`, read both the project and feature status.json files: each has `run.status` equal to `paused`.
4. [integration] Untouched stories after `PAUSE` remain eligible for a later resumed run.
5. [integration] Once the root `PAUSE` has taken effect, the consumed command does not pause the subsequent resume again.
6. [integration] A non-operator story-level `pause` result still allows selection of another independent story.
7. [integration] `ABORT` retains its existing skip-pending behavior rather than adopting pause/resume semantics.
8. [integration] Operator `PAUSE` returns from completion without calling the feature-workflow entry `runWorkflowFeature` (which owns finalization and publication).
9. [integration] An `INJECT relative.json` in the root queue adds the valid, uniquely identified story stored only in the selected package’s relative.json to the PRD.
10. [integration] In a one-story run, queue root `PAUSE` before the fake implementer returns success: the final PRD retains the story as passed.
11. [integration] At that final-story boundary, the persisted `run.status` is `paused` in both status files even though no stories remain to dispatch.
12. [integration] At that boundary, `runWorkflowFeature` is not invoked before explicit resume.
13. [integration] Resuming the held, all-passed PRD invokes `runWorkflowFeature` once without rerunning the passed story.

### US-003

1. [integration] For an ordinary `nax run`, advance the clock between logger setup and runner start. The log filename stem and its `run.start` data.runId each equal `buildRunId` for the resolved workdir and logger-setup instant, including milliseconds.
2. [integration] Start `executeUnified` with `ctx.logFilePath` set to a full path inside the feature runs directory whose basename differs from `<runId>.jsonl`; after the real registry subscriber drains, `meta.json` contains only that basename in `logFileName`.
3. [integration] With two runs of one feature and an exact-ID decoy for the older one, `logs --run <older-id>` renders only the older run's sentinel from its declared file.
4. [integration] With those competing logs, `replay <older-id>` reconstructs only the older run's declared-file phase.
5. [integration] When the registered file is absent but a sibling log exists, `logs --run <id>` reports the requested log unavailable rather than rendering that sibling.
6. [integration] A legacy registry record without `logFileName` still resolves an existing exact `<runId>.jsonl` in both log and replay readers.
7. [integration] With a legacy exact-name miss, `replay <id>` reconstructs no phases from a different file in `eventsDir`.
8. [integration] With no query, `discoverRun` returns the greater valid `registeredAt` even if that record's workdir hash sorts lower.
9. [integration] For tied `registeredAt` instants (or both undated), `discoverRun` returns the greater run ID.
10. [integration] An undated legacy entry (missing or unparseable `registeredAt`) does not outrank a dated entry in `discoverRun`.
11. [integration] `nax resume` continues to produce a log resolvable by its registered ID.
12. [integration] Both readers report unavailable log data for a `logFileName` that is not a single JSONL basename, even with a readable exact-ID decoy.
13. [integration] If registration is delayed, `executeUnified` persists `registeredAt` equal to the ISO instant of `ctx.startTime`, not the later wall clock at subscriber delivery.
14. [integration] A `logFileName` of `latest.jsonl` yields unavailable log data in both readers rather than following the mutable alias.
15. [integration] An escaping symlink under `eventsDir` yields unavailable log data for both readers, including for a legacy exact-name candidate.
16. [integration] In the shared feature-directory chronology fixtures, plain `logs` renders the newest run by the timestamp in its filename, not the greatest filename.
17. [integration] In the same fixtures `logs --list` lists the newest run first.
18. [integration] For hash-prefixed files `logs --list` renders just the timestamp portion of the stem in the Timestamp column.

### US-004

1. [unit] With expected B, stable bracket reads A/A, passing checks and missing inline `headRefOid`, `waitForChecks` returns `unavailable` with head-mismatch detail at deadline.
2. [unit] With the same reads and a rejected mergeability lookup, `waitForChecks` likewise refuses green for B.
3. [integration] With stable B/B and no inline SHA, a passing `waitForChecks` returns green for expected B.
4. [unit] When a green poll already carries a different inline SHA, `waitForChecks` refuses green for the expected SHA.
5. [unit] A `waitForChecks` bracket that observes A then B is not a green verdict for either observed head on that poll.
6. [unit] A passing poll with neither inline nor readable fallback SHA returns green from `waitForChecks` under the existing unknown-head policy.
7. [unit] With expected B, bracket A/A, no inline SHA and final one-shot lookup B, `readChecksOnce` retains its green verdict based on the final lookup.
8. [unit] With one unreadable bracket endpoint and no inline SHA, a passing `waitForChecks` poll retains the existing unknown-head outcome.
