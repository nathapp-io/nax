# Spec Review — review-0942-run-integrity/spec.md → prd.json

**Reviewed against:** `repos/nax` at `5a112f0a2`  
**Date:** 2026-11-28  
**Phases run:** 1 of 9 (--phase 9: phases 1-8 skipped by request)  
**Verdict:** ✅ Ready at the PRD fidelity gate. The approved last-story hold and explicit resume are both delivered. This is not an implementation or test result.

## Summary

- **Phase 9:** 48/48 spec ACs mapped to 48/48 PRD ACs in their owning stories; 38 differ at most in Markdown quoting, 10 semantically equivalent rewrites. No missing, degraded, low-confidence or material orphan AC. Checked 4/4 dependency sets, 18 context reads, 0 spec creates, 6 planner test outputs, 12 modified path/reason pairs, 8 exclusions, 2 named contract additions and all 4 description Interface blocks. **0 blockers, 0 majors, 1 minor.**

**Minor — US-001 points to commentary its implementer does not receive.** Spec `### Modifies`, lines 73–83; PRD US-001 `description`, Regression design: “Update all existing tests listed for US-001 in the shared analysis.” Root `analysis` is not a story prompt. No authorization or assertion is lost: all ten test paths and their exact reasons are in US-001 `modifiedFiles` (rendered by `packages/nax/src/prompts/sections/story.ts`), and the behavior is in the ACs/description. **Next step:** accept the fidelity gate; in future generated wording point to “this story’s modified files” rather than “the shared analysis.” No re-plan or input edit needed for this issue. Leave launch to the operator.

## Story, dependency and file fields

Counts are per owning story (a shared read in two stories counts twice). Compared the explicit “No dependencies” declarations at spec lines 35–41, not the suggested order. The four IDs, titles’ intent, stated `packages/nax` workdirs and story order match. No additional story, missing array, invented or omitted edge.

| Story | Spec deps → PRD deps | Context: exact + on disk | Spec creates → PRD expected files | Modified: exact path **and** exact reason |
|---|---|---:|---:|---:|
| US-001 | ∅ → `[]` | 5/5 | 0 → 0 | 10/10 |
| US-002 | ∅ → `[]` | 5/5 | 0 → 2 | 1/1 |
| US-003 | ∅ → `[]` | 5/5 | 0 → 3 | 1/1 |
| US-004 | ∅ → `[]` | 3/3 | 0 → 1 | 0/0 |

Compared ordered context paths and each `modifiedFiles` object against the grouped source bullets (spec lines 43–89), including punctuation, backticks and typographic apostrophes in reasons; **12/12 exact**, no extras, empty reasons or swallowed paths. No added/dropped context, self-create/read overlap or upstream-produced read. No spec `Creates` block. All six extra `expectedFiles` are absent on disk, repo-rooted and distinct from the existing tests. Under `packages/nax/test/integration/`: US-002 `execution/run-operator-pause{,-final-story}.test.ts`; US-003 `commands/run-artifact-{identity,chronology}.test.ts` and `execution/run-artifact-registration.test.ts`; US-004 `workflow/ci-wait-head-binding.test.ts`. These name where to put required regressions; they do not add product behavior.

**Other fields:** Project `nax-monorepo`, feature slug and branch identify the intended artifact. Root timestamps and `routingProfile` are planner metadata; no spec value to preserve. The four stories start `pending`, `passes: false`, zero attempts and empty escalations. Story routing (complex/lite, complex/lite, complex/three-session TDD, medium/simple) and tags do not change ownership or acceptance. No `storyPoints` or per-story exclusions required. Read `analysis` for discrepancies, not as evidence of delivery; neither it, tags, nor routing substitutes for a description or AC.

## Delivery of corrections and boundaries

| Owner | What reaches the story via `description` and/or ACs |
|---|---|
| US-001 | Approach + Regression design require the checkout lock before the sweep through cleanup, isolated inner workdirs, distinct raw tuples in both bounded namespaces, branch-only recovery rather than live-tree reclamation, committed/offline repo fixtures, a barrier rather than sleeps, literal legacy seeding and release of an old callback only after successor allocation. AC1–9 measure identity, contents, branch tip, cleanup authority and lock release. |
| US-002 | Approach + Interface distinguish run-level operator stop from story pause and separate queue root from package payload base. Regression design drives real dispatch with a fake implementer, not just the queue stage. AC2–9 cover remaining work, both reconciled files, consumed command, ABORT, genuine story pause, publication suppression and relative INJECT. **AC10–13 are separate and unchanged:** queue PAUSE before the only implementer returns success; persist the story as passed and both `run.status` values as `paused` with zero work left; call `runWorkflowFeature` zero times while held; on explicit resume call it exactly once without rerunning that story. No reliance on commentary or an inference from the ordinary mid-run case. |
| US-003 | Approach + Interface + Regression design distinguish logger-setup identity from runner-start registration and delivery time. Preserve declared versus legacy exact candidates, no sibling/alias/escaping symlink, real per-story metrics and `story-orchestrator` / `Phase passed: older` with decoys. Directory chronology uses the actual single-feature runs dir, inverse hash/time ordering and newer legacy timestamp-only file; it does not guess registry identity. AC1–18 cover both readers, tie/undated ordering, resume and list display. |
| US-004 | Approach + Regression design require the public bounded GitHub wait, rejected mergeability control, matching/mismatching/moving heads, inline precedence, both unknown-head cases and the unchanged one-shot final lookup. AC1–8 measure verdicts, not helper implementation. |

**Reverse scope check:** 48/48 PRD ACs traced back (map below); no new enum, switch, validation requirement or material obligation without a spec source. All 8/8 root `outOfScope` entries equal the source bullets in order: findings 5–14; historical log rewriting/migration/guessing; CI policy/timing; mid-story cancellation/queue redesign/blocked-story resume; old live trees/global lock recovery; US-003 CLI surface; US-004 other CI paths; release/packages/config/network tests. Zero missing, merged, contradictory or orphan exclusions. Both `US-00N only:` prefixes survive. Compared all four descriptions’ In/Out clauses and all criteria: e.g. US-004 AC7 tests *unchanged* one-shot behavior; US-003 AC16–18 test directory browsing, not legacy identity guessing. Neither inverts an exclusion. No separate build/static meta-ACs or terminal deletion story; last story remains the GitHub fix, not cleanup.

**Forward references:** no named new exported functions. Re-swept the two specified schema additions (`paused` under `run.status`; optional `logFileName` relative to `eventsDir`) across 48 ACs and four Interface blocks: same spelling and meaning, no near-miss alias. The run-level discriminator and allocation proof have no spec-prescribed new name. Existing identifiers retained, including `runWorkflowFeature`, `buildRunId`, `ctx.startTime`, `registeredAt`, `waitForChecks` and `readChecksOnce`.

## PRD invocation and signature checks

Graph tools were not exposed. Direct checks below are limited to the PRD's call claims and reworded assertions; they distinguish an existing route from the **new behavior the story is meant to implement**. Source paths below are relative to `packages/nax/`.

- **Comparison:** `bin/nax.ts:411` dispatches compare mode; `src/bakeoff/coordinator.ts:47–50,79–92,187` connects the sweep and contestants; `src/bakeoff/contestant.ts:153–186` calls manager `create` and `remove` with project root and derived ID. Thus the pre-sweep conflict, failed-create zero-remove and later successful/stale cleanup assertions observe real boundaries. Each ID derivation takes two strings (`src/worktree/worktree-id.ts:49,61`); `validateStoryId(id)` validates by returning or throwing (`src/prd/validate.ts:24`), not by returning a boolean.
- **Dispatch/hold/resume:** `src/execution/unified-executor.ts:203–208,232–254` has both an already-complete path bypassing story dispatch and post-iteration completion checks. Dispatch actually calls `runIteration` (`unified-executor-dispatch-phases.ts:193`); `iteration-runner.ts:143–144` supplies separate project/package dirs. `queue-check.ts:98–139` consumes commands and marks pending stories skipped on ABORT (`src/prd/index.ts:424–428`). `pipeline-result-handler.ts:324–335` handles ordinary pause. Completion status writes exist in `lifecycle/run-completion-phases.ts:456–511` and `runner-completion.ts:251–253`. `src/commands/resume.ts:161–188` re-enters the runner; `runner.ts:330` → `runner-completion.ts:325` → `workflow-end-report.ts:226` → `end-phase.ts:64–71,112–115` reaches the actual `deps.runWorkflowFeature(input)`. The required hold is a **new guard before that call**, not a claim it already exists. Explicit all-passed resume can reach completion without dispatch. No extra test-only enable flag or invented workflow method.
- **Artifacts:** `bin/run-action.ts:489–507` opens the log; `bin/run-action-execute.ts:163–183` calls the runner. `runner.ts:189` accepts a caller ID; `src/execution/run-id.ts:28` takes `(workdir: string, now: Date)`. `lifecycle/run-setup-init.ts:202` logs `run.start`. `unified-executor.ts:140–146` wires the real registry and emits **`run:started`**; `src/pipeline/subscribers/registry.ts:56–69` writes `meta.json`. Passing the log basename and start instant is the delta, not a claim that the current subscriber already stores both. `src/commands/logs.ts:56,90,95` selects explicit/list/default readers; `src/commands/replay.ts:120,129` consumes discovery and its JSONL path. `src/replay/discovery.ts:20–23,65–78` accepts an omitted query and returns a `DiscoveredRun` with `meta` (including `meta.runId`), not a bare ID. The three rewritten chronology ACs match that shape.
- **CI:** `src/workflow/ci-wait.ts:217–227,476–486` connects the public wait via `pollOnce` to the scripted forge and bracket, then binds the poll to the expected head. `ci-wait-head-bind.ts:29–30,52–69` gates on GitHub + expected head, non-commit polling; handles movement and absent endpoints. `ci-wait.ts:302–305,421` explains mismatch/movement detail at deadline, not just “not green.” `readChecksOnce` also calls `pollOnce` but reaches `verdictForHead` and a final read for a missing poll SHA (`:530–568`). Expected-head GitHub PR fixtures establish the bracket guard; no shared one-shot behavior change required. No PRD-added arity or method mismatch.

## Acceptance mapping

Each destination below is **1-based within `acceptanceCriteria` of the same story**. “Same” means unchanged after removing Markdown backticks, including the mechanism tag. For the ten other rows the note identifies what changed and why the assertion still holds.

### US-001

| Spec AC | PRD AC | Fidelity |
|---|---:|---|
| 1. [unit] Within each of `deriveStoryWorktreeId` and `deriveBakeoffWorktreeId`, `(billing-api, retry-1)` and `(billing, api-retry-1)` yield distinct IDs accepted by `validateStoryId`. Repeat with `(f, a!)` versus `(f, a?)`, whose raw inputs differ before sanitization. | 1 | Same. |
| 2. [integration] While one `run --compare` owns the checkout, an identical competing invocation reports a lock conflict before its stale-branch sweep or any contestant create. | 2 | Same. |
| 3. [integration] Given two competing `WorktreeManager.create` requests for the same ID, the losing request leaves the winner's uncommitted sentinel contents intact in its worktree. | 3 | Same. |
| 4. [integration] A refused `WorktreeManager.create` leaves the winner's unique commit reachable by its original branch at the same SHA. | 4 | Same. |
| 5. [integration] When create refuses an occupied path, `runContestant` makes zero calls to the manager's `remove` method. Include refusal against a seeded legacy tree; changing the derived ID must not let an unconditional cleanup pass just because it targets a different path. | 5 | Same. |
| 6. [integration] A delayed `runContestant` cleanup for an earlier contestant cannot remove the tree of a subsequent owner using the same ID. | 6 | Same. |
| 7. [integration] A successful `run --compare` cleans up its own contestant worktree. | 7 | Same. |
| 8. [integration] After a contestant failure a later `run --compare` can acquire the released outer lock. | 8 | Same. |
| 9. [integration] With a live legacy `nax/bakeoff-f-agent` tree for feature f and profile agent, `run --compare` leaves its dirty sentinel and original branch tip untouched through preflight and contestant cleanup. Seed the old name literally, not via the changed encoder. | 9 | Same. |

### US-002

| Spec AC | PRD AC | Fidelity |
|---|---:|---|
| 1. [integration] When an operator writes `PAUSE` at the run root during a package story, the in-flight story is allowed to finish. | 1 | Makes successful completion observable as passed; PAUSE does not interrupt. |
| 2. [integration] With two independent package stories remaining, a root `PAUSE` causes zero further implementer calls in that invocation. | 2 | Same. |
| 3. [integration] After completion and finish-status reconciliation return from an operator `PAUSE`, read both the project and feature status.json files: each has `run.status` equal to `paused`. | 3 | Same. |
| 4. [integration] Untouched stories after `PAUSE` remain eligible for a later resumed run. | 4 | Names persisted pending state of the independent stories and retains later selection eligibility. |
| 5. [integration] Once the root `PAUSE` has taken effect, the consumed command does not pause the subsequent resume again. | 5 | Same. |
| 6. [integration] A non-operator story-level `pause` result still allows selection of another independent story. | 6 | Same. |
| 7. [integration] `ABORT` retains its existing skip-pending behavior rather than adopting pause/resume semantics. | 7 | Specifies persisted skipped status for pending work on ABORT; not PAUSE semantics. |
| 8. [integration] Operator `PAUSE` returns from completion without calling the feature-workflow entry `runWorkflowFeature` (which owns finalization and publication). | 8 | Same. |
| 9. [integration] An `INJECT relative.json` in the root queue adds the valid, uniquely identified story stored only in the selected package’s relative.json to the PRD. | 9 | Same. |
| 10. [integration] In a one-story run, queue root `PAUSE` before the fake implementer returns success: the final PRD retains the story as passed. | 10 | Same. |
| 11. [integration] At that final-story boundary, the persisted `run.status` is `paused` in both status files even though no stories remain to dispatch. | 11 | Same. |
| 12. [integration] At that boundary, `runWorkflowFeature` is not invoked before explicit resume. | 12 | Same. |
| 13. [integration] Resuming the held, all-passed PRD invokes `runWorkflowFeature` once without rerunning the passed story. | 13 | Same. |

### US-003

| Spec AC | PRD AC | Fidelity |
|---|---:|---|
| 1. [integration] For an ordinary `nax run`, advance the clock between logger setup and runner start. The log filename stem and its `run.start` data.runId each equal `buildRunId` for the resolved workdir and logger-setup instant, including milliseconds. | 1 | Same. |
| 2. [integration] Start `executeUnified` with `ctx.logFilePath` set to a full path inside the feature runs directory whose basename differs from `<runId>.jsonl`; after the real registry subscriber drains, `meta.json` contains only that basename in `logFileName`. | 2 | Same. |
| 3. [integration] With two runs of one feature and an exact-ID decoy for the older one, `logs --run <older-id>` renders only the older run's sentinel from its declared file. | 3 | Same. |
| 4. [integration] With those competing logs, `replay <older-id>` reconstructs only the older run's declared-file phase. | 4 | Same. |
| 5. [integration] When the registered file is absent but a sibling log exists, `logs --run <id>` reports the requested log unavailable rather than rendering that sibling. | 5 | Same. |
| 6. [integration] A legacy registry record without `logFileName` still resolves an existing exact `<runId>.jsonl` in both log and replay readers. | 6 | Same. |
| 7. [integration] With a legacy exact-name miss, `replay <id>` reconstructs no phases from a different file in `eventsDir`. | 7 | Same. |
| 8. [integration] With no query, `discoverRun` returns the greater valid `registeredAt` even if that record's workdir hash sorts lower. | 8 | Identifies the later record via returned meta, not a bare timestamp. |
| 9. [integration] For tied `registeredAt` instants (or both undated), `discoverRun` returns the greater run ID. | 9 | Reads the winning ID from meta.runId; both tie cases retained. |
| 10. [integration] An undated legacy entry (missing or unparseable `registeredAt`) does not outrank a dated entry in `discoverRun`. | 10 | Dated winner is returned in meta for a no-query lookup; both invalid date classes retained. |
| 11. [integration] `nax resume` continues to produce a log resolvable by its registered ID. | 11 | Same. |
| 12. [integration] Both readers report unavailable log data for a `logFileName` that is not a single JSONL basename, even with a readable exact-ID decoy. | 12 | Same. |
| 13. [integration] If registration is delayed, `executeUnified` persists `registeredAt` equal to the ISO instant of `ctx.startTime`, not the later wall clock at subscriber delivery. | 13 | Same. |
| 14. [integration] A `logFileName` of `latest.jsonl` yields unavailable log data in both readers rather than following the mutable alias. | 14 | Same. |
| 15. [integration] An escaping symlink under `eventsDir` yields unavailable log data for both readers, including for a legacy exact-name candidate. | 15 | Same. |
| 16. [integration] In the shared feature-directory chronology fixtures, plain `logs` renders the newest run by the timestamp in its filename, not the greatest filename. | 16 | Same. |
| 17. [integration] In the same fixtures `logs --list` lists the newest run first. | 17 | Same. |
| 18. [integration] For hash-prefixed files `logs --list` renders just the timestamp portion of the stem in the Timestamp column. | 18 | Same. |

### US-004

| Spec AC | PRD AC | Fidelity |
|---|---:|---|
| 1. [unit] With expected B, stable bracket reads A/A, passing checks and missing inline `headRefOid`, `waitForChecks` returns `unavailable` with head-mismatch detail at deadline. | 1 | Same. |
| 2. [unit] With the same reads and a rejected mergeability lookup, `waitForChecks` likewise refuses green for B. | 2 | Expands “likewise” into A/A, no inline SHA, rejected lookup and unavailable/mismatch at deadline. |
| 3. [integration] With stable B/B and no inline SHA, a passing `waitForChecks` returns green for expected B. | 3 | Same. |
| 4. [unit] When a green poll already carries a different inline SHA, `waitForChecks` refuses green for the expected SHA. | 4 | Bounds persistent inline mismatch to the wait deadline; no green for the wrong head. |
| 5. [unit] A `waitForChecks` bracket that observes A then B is not a green verdict for either observed head on that poll. | 5 | Ends the clock after the moving poll; checks unavailable/movement for each expected head, not a ban on a later stable green. |
| 6. [unit] A passing poll with neither inline nor readable fallback SHA returns green from `waitForChecks` under the existing unknown-head policy. | 6 | Same. |
| 7. [unit] With expected B, bracket A/A, no inline SHA and final one-shot lookup B, `readChecksOnce` retains its green verdict based on the final lookup. | 7 | Same. |
| 8. [unit] With one unreadable bracket endpoint and no inline SHA, a passing `waitForChecks` poll retains the existing unknown-head outcome. | 8 | Names green as the existing passing/unknown outcome with one unreadable endpoint. |
