# Workflow draft honesty and run-state repair

**Issues:** #2496, #2497 (one bundle, one PR). **Status:** design agreed 2026-10-13, spec for review.
**Base:** main `401846b83`.

The two halves are independent. They share a PR because both make a workflow run's end state honest: #2496 makes a draft say exactly what is left, #2497 makes sure the state nax reports from was not rolled back by the agent.

## 1. Problem

### 1.1 #2496: a ruling defers to a step that has passed

On a workflow-mode run (7/7 stories, gates and CI green) the branch re-review raised a new important finding (B3) in the fix diff. The advisor ruled `defer` ("defer to branch review"), the PR went out as a draft, and B3 stayed open. Root causes (main `401846b83`):

1. **The menu is not staged.** `residualMenu` (`advisor/menus.ts:162-176`) offers `defer` ("real, but defer it to the branch review") at story scope and at branch scope alike. At branch scope nothing runs after `adjudicate` except `final-gates` and `publish` (`workflow/feature-machine.ts:264-272`), so `defer` silently means "leave for a human". The A5 spec maps `park-real-deferred -> defer` at branch adjudication too (`2026-10-12-a5-workflow-mode-design.md:379`).
2. **The branch fix is single-pass.** A defect introduced by the one fix can only be ruled on, never fixed.
3. **The PR body loses the evidence.** `list()` (`workflow/pr-body.ts:43-48`) and `buildAdvisorSection` (`finish/pr/body.ts:147-181`) cap each item at 300 chars. `toWorkflowRuling` (`workflow/advisor-live.ts:39-59`) keeps only text, why and cost, so file, line and suggestion never reach the body.
4. **`result.json` has no verdict.** `featureWorkflow.passed` (`approval.ts:44-47`) ignores rulings and open findings, so a draft can carry `passed: true`. `branch-review.json` findings have no `id` (written at `branch-review.ts:59`, ids assigned later at `feature-machine.ts:147`), so the files do not cross-reference.

### 1.2 #2497: run state is protected only by parsing commands

nax keeps live run state in the work tree (`.nax/features/<f>/prd.json`, `status.json`, the workflow run dir's `result.json` and `ledger.md`, `decisions.jsonl`). The command guard (`nax-agent/src/tools/nax-state-guard.ts`) parses shell and git to refuse commands that would revert, stash, clean or hide them. Five review rounds (#2490, #2493, #2498) closed bypasses and found new ones; its known-gaps list (lines 75-103) is open-ended by nature. The only repair is the #2490 index-flag sweep (`utils/nax-index-flags.ts`), which runs at run end and on crash, only over the workdir it is given, and only clears index flags. Content reverts are never repaired. The owned-paths write deny (`agents/nax-owned-writes.ts:167`) covers `prd.json`, queue files and config, not `status.json`, `result.json`, `ledger.md` or `decisions.jsonl`.

## 2. Goal and scope

**Goals:**
- At branch scope the advisor can only accept a risk or flag a human; a defect the single fix introduced gets one capped second fix.
- A draft PR and `result.json` state every open item in full, in one place a finishing tool can read.
- Any agent action that reverts, deletes, modifies or hides a nax-owned run-state file, whatever the spelling, is repaired within one agent turn and logged with session, step and turn.

**Unchanged:**
- The story-scope residual menu (fix / waive / defer / carry / hold). Defer is valid there: a branch review follows.
- `forcedConfirm` semantics and `isFlaggedRuling`. The ready/draft rules in `readinessReasons`.
- The command guard's rules (frozen, §8).
- `result.json` `schemaVersion` stays 1; all additions are optional fields.

**Out of scope:** simplifying the guard's text backstop (later issue, once repair has run live); protecting the agent's own WIP; damage done before the run starts; renaming advisor actions to the issue's `accept-risk` / `needs-human` (nax keeps `waive` / `hold`).

## 3. Staged advisor menu at branch scope (#2496 part 1)

- `residualMenu` takes a `scope: "story" | "branch"` input. Branch scope offers only `waive` (label: "accept the risk; give the reason it is acceptable to ship") and `hold` (label: "a human must decide before this is marked ready"). `defer` and `carry` are not offered.
- `adjudicateResidual` passes `scope: "branch"` when `storyId === FEATURE_SCOPE` (`workflow/feature-env.ts`). Story callers pass `"story"`.
- The residual prompt (`prompts/builders/advisor-batch-builder.ts:24`) renders the defer guidance only when `defer` is on the menu. Prompt text stays in the builder.
- **Coercion.** If a branch-scope reply still carries `defer`, `toWorkflowRuling` maps it to `hold` with `needsHumanConfirm: true`, logs one `[WARN]` (`{ storyId: "_run", findingId, from: "defer", to: "hold" }`) and writes the ledger line `_run: ruling <id> defer coerced to hold: no later review step`.
- The A5 spec row `park-real-deferred -> defer` is amended to `hold` for branch adjudication.

## 4. One capped second branch fix (#2496 optional item, included by ruling 2026-10-13)

`WorkflowFeatureRecord` gains `fixRounds: number` (0 before any fix). `branchFixStep` increments it.

After `branchReReviewStep`, route back to `branch-fix` instead of `adjudicate` when all hold:
1. every item sent to the re-review was marked addressed (`stillOpen` is empty);
2. the re-review raised at least one new blocking finding (critical or important), and every one has a `file` inside the first fix's diff (`fixBase..head`; a new `env.steps.changedFiles(base)` returns repo-relative paths);
3. `fixRounds < 2`.

Second round:
- Input is only the new blocking findings (no minors, no gate findings). `fixBase` is reset to `head` before the fix.
- The second re-review checks only those findings, then always goes to `adjudicate`. There is no third round.
- New blocking findings from the second re-review are appended to `reviewOpen` (fail closed, as today).
- Log and ledger lines carry the round: `branch fix r2: 1 item(s): B3`, `branch-rereview r2`.
- A finding without `file`, or with a file outside the fix diff, makes the run ineligible; it goes to `adjudicate` as today.

## 5. Evidence and verdict (#2496 parts 2-4)

### 5.1 Finding ids at the source
`assign()` runs before `branch-review.json` is written, so the file carries the same `B<n>` ids as `result.json`. Same for `branch-rereview.json` new findings.

### 5.2 Top-level verdict in `result.json`
`WorkflowResultFile` gains an optional top-level `verdict`, written by `publishStep`:

```ts
interface WorkflowVerdict {
  readonly workflowPassed: boolean;   // featurePassed && openItems.length === 0
  readonly outcome: FeatureOutcome;   // ready | draft | local-only
  readonly reasons: readonly string[];
  readonly openItems: readonly OpenItem[];
}
interface OpenItem {
  readonly id: string;                // B3, or "_run:cv1" for cannot-verify, gate name for gates
  readonly kind: "finding" | "ruling" | "cannot-verify" | "gate";
  readonly severity?: WorkflowSeverity;
  readonly file?: string;
  readonly line?: number;
  readonly issue: string;             // full text, no truncation
  readonly suggestion?: string;
  readonly ruling?: { action: WorkflowRuling["action"]; why: string; decisionId?: string };
}
```

Built by one pure function `buildOpenItems(rec, cannotVerify)` in `workflow/open-items.ts`:
- every `reviewOpen` finding, joined on `findingId` with its ruling. A `waive` without `needsHumanConfirm` closes the item (accepted risk, not open). A `hold` or flagged ruling keeps it open with `kind: "ruling"`. An unruled finding is `kind: "finding"`.
- every branch-level cannot-verify item recorded during this run (the feature machine keeps them on the record as `cannotVerify: string[]`, in addition to the ledger line).
- every failing final gate, with its excerpt from `finalGateFindings`.

`workflowPassed` is the field a finishing tool and the end report read. `featureWorkflow.passed` keeps its current meaning.

### 5.3 PR body: "Before marking ready"
When `openItems` is non-empty, `buildWorkflowPrBody` renders a section above "Advisor decisions":

```
## Before marking ready
- [ ] **B3** (important, spec) `src/x.ts:42` — <issue in full>
      Suggestion: <suggestion in full>
      Advisor: hold — <why>
...
Then: rerun the repo gates, push, and run `gh pr ready`.
```

Each item is escaped (`escapeInline` with no char cap) but not truncated. The 50-row cap still applies, with an "…and N more, see result.json verdict.openItems" line. The existing sections keep their caps.

### 5.4 Resume contract (documented, kept stable)
A finishing tool reads `.nax/features/<f>/workflow/<runId>/result.json`: top-level `verdict`, plus `featureWorkflow.{outcome, reasons, reviewOpen, rulings, finalGates, finalGateFindings}`, and `ledger.md`. The contract goes in a new appendix of the A5 spec (`2026-10-12-a5-workflow-mode-design.md`, "Appendix: finishing contract"), naming these fields as stable within `schemaVersion` 1. No workflow guide exists under `docs/guides/` today.

## 6. Run-state keeper (#2497)

### 6.1 Module
New `src/runstate/` (barrelled): `keeper.ts`, `verify.ts`, `types.ts`. Each under 200 lines.

```ts
type RunStateKind = "prd" | "status" | "workflow-result" | "ledger" | "decisions";
interface RunStateKeeper {
  record(path: string, bytes: Uint8Array | string, kind: RunStateKind, workdir: string): void;
  seed(workdir: string): Promise<void>;
  workdirs(): readonly string[];
  entries(workdir: string): readonly KeptFile[];
}
```

- Owned by the runtime (`NaxRuntime.runState`), one per run. Keyed by absolute path; holds the bytes nax last wrote and a hash.
- **Writers record after their own write:** `savePRD` (`prd/index.ts`), `StatusWriter` (`execution/status-writer.ts`), `crash-writer.ts`, `upsertStoryRecord` / `upsertFeatureRecord` (`workflow/result.ts`), `ensureLedger` / `appendLedger` (`workflow/ledger.ts`), `appendDecision` (`advisor/ledger.ts`). Each reaches the keeper through its existing `_deps` (or an optional parameter where it has none), so writers called outside a run (CLI `nax accept`, plan) work unchanged with no keeper.
- Append-only files record their full content after each append.
- A nax write during a turn (status heartbeat, an advisor decision mid-turn) updates the keeper itself, so it is never flagged.
- **Seed** at run start and on resume: every owned file present under `featureDir(workdir, feature)` and the run dir is read once into the keeper. Parallel pipeline worktrees are seeded when the worker opens its worktree.

### 6.2 Verify and repair
`verifyRunState(keeper, workdir, ctx)` where `ctx = { storyId?, sessionName?, stage, turn?, trigger }` and `trigger` is `turn | pre-commit | pre-read | run-end | crash`:

1. `hiddenNaxPaths(workdir)` once (one `git ls-files -v -z` call).
2. For each kept file under `workdir`: classify `missing` (no file), `modified` (hash differs), `hidden` (index flag set). A file can be both hidden and modified.
3. Repair: `clearNaxIndexFlags` for hidden paths, then atomic-write the kept bytes for missing or modified ones.
4. Report per repaired file: one `logger.warn("runstate", ...)` with `{ storyId, sessionName, stage, turn, trigger, path, damage }`, message like `US-002 implementer turn 3: .nax/features/f/prd.json modified by the agent; restored`. Append a `run-state-repair` entry to the tool-audit sink for the session when one is open, and in workflow mode a ledger line `<storyId>: run-state repaired: <path> (<damage>)`.
5. Return `{ repaired: RepairRecord[] }`. Never throws; a failed restore logs `[FAIL]` and continues.

The ledger line is itself a nax write, so it is recorded in the keeper after the repair, never flagged.

### 6.3 When it runs
- **After every agent turn:** in the `finally` around `adapter.sendTurn` in `SessionManager` (`session/manager.ts:587`). This covers native and ACP and failed turns. The `session-turn` bus event is not used: it fires only on success, and subscribers are not awaited. On ACP a turn is one delegated agent run, which still meets "within one turn".
- **Before every auto-commit:** at the top of `autoCommitIfDirty` (`utils/git.ts:206`) and before the workflow auto-commits (`workflow/implement.ts:70`, `workflow/branch-fix.ts:41`). A reverted PRD is never committed.
- **Before read-back:** at the run's `loadPRD` reload points and `readResult` in the workflow loop, through the runtime (CLI reads outside a run are unaffected).
- **Run end and crash:** replaces the #2490 sweep at `runner.ts:426`, `runner-completion.ts:542` and `crash-signals.ts:154-168` with `verifyRunState` over `keeper.workdirs()`. The crash path keeps the 2000 ms budget. `runner-completion.ts` (578/600 lines) must not grow: the call is a one-line swap.
- When no keeper is present (no runtime), the existing sweep behaviour is kept as the fallback so CLI paths do not regress.

### 6.4 Owned-paths deny
`naxOwnedKind` (`agents/nax-owned-writes.ts:167`) adds `status.json`, `workflow/**/result.json`, `workflow/**/ledger.md` and `decisions.jsonl` under the feature dir, so Write/Edit/Delete tools refuse them up front. Repair remains the guarantee for anything that lands anyway.

## 7. Error handling
- Repair and verify never throw into the run; every failure is a `[WARN]` or `[FAIL]` log line with `storyId` first.
- Coercion of a branch `defer` is a warning, not an error.
- `changedFiles` failing (git error) makes the second fix ineligible, logged, and the run continues to `adjudicate`.
- `buildOpenItems` is pure; missing fields are omitted, never invented.

## 8. Command guard frozen
No rule changes. The header of `nax-state-guard.ts` is rewritten: the guard is a first line that redirects common accidents with a helpful message; the guarantee is detect-and-repair (#2497). The known-gaps list keeps the #2498 entries (string-executing git subcommands, executing env vars, unlisted executing config keys, interpreter string arithmetic, raw-mode expansion-built operands) and points at `src/runstate/`.

## 9. Testing (TDD, tests first per part)

**#2496**
- `menus.test.ts`: branch scope offers only waive and hold; story scope unchanged.
- `advisor-live.test.ts`: branch `defer` coerced to flagged `hold`, warn logged, ledger line written.
- `feature-machine.test.ts`: second fix taken when all three conditions hold; not taken when an item stays open, when a new finding is outside the fix diff, when a finding has no file, or after round 2; second re-review always goes to adjudicate.
- `open-items.test.ts`: join on findingId; waive closes; hold or flagged stays open; cannot-verify and red gates included; `workflowPassed` false whenever an item is open.
- `pr-body.test.ts`: "Before marking ready" renders full text over 300 chars, file:line, suggestion, checklist; absent when no open items.
- `branch-review.test.ts`: written file carries ids.
- `feature-e2e.test.ts`: the B3 scenario (re-review raises a new important finding in the fix diff) ends `ready` after the second fix, or `draft` with a full open item when the second re-review fails.

**#2497**
- `keeper.test.ts`: record, seed, per-workdir entries; a mid-turn nax write is not flagged.
- `run-state-bypass.test.ts` (real git repo via `Bun.spawn`, temp dir, `nax-index-flags.test.ts` style). Each case runs the command, calls `verifyRunState`, asserts bytes restored, flags cleared, one warn with the right damage:
  - `git -c alias.x=stash x`, `git -c alias.x='!git checkout -- .nax' x`
  - `git rebase -x 'git checkout HEAD~1 -- .nax'` on a two-commit repo
  - `GIT_PAGER='sh -c "git checkout HEAD~1 -- .nax"' git log` (with paging forced)
  - `python3 -c` (or `bun -e`) overwriting `prd.json`
  - `rm` of `status.json`
  - checkout with `:(exclude,glob)**/.nax` pathspec
  - `git update-index --skip-worktree` and `--assume-unchanged` on `prd.json`
  - `git stash -u` with only `.nax` dirty
- `session/manager` wiring test: verify runs after a turn that throws.
- `utils/git` wiring test: `autoCommitIfDirty` restores a reverted PRD before committing.
- Existing sweep tests (`nax-index-flags.test.ts`, `crash-signals.test.ts`) keep passing via the fallback.

**Gates:** `bun run check:all` (root and package), `bun run typecheck`, `bun run test:coverage` for the touched packages.

## 10. Acceptance (from the issues)
1. An advisor `defer` at branch scope is not offered, and if returned is coerced to a flagged `hold` with a log line.
2. A defect introduced by the branch fix and confined to its diff gets one second fix pass, never more.
3. A draft PR body lists each open item in full with a promotion checklist.
4. `result.json` carries a top-level `verdict` with `workflowPassed` and `openItems[]`; `branch-review.json` findings have ids.
5. Every bypass in §9's matrix is detected within one turn, repaired, and logged with session, step and turn.
6. The verifier runs on native and ACP, in pipeline and workflow mode, before every auto-commit, and at run end and crash.
7. The guard's known-gaps list references #2497 as the guarantee.
