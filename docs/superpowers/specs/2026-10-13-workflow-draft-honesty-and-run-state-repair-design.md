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
- **Coercion.** If a branch-scope reply still carries `defer`, `toWorkflowRuling` maps it to `hold` with `needsHumanConfirm: true`, sets `coercedFrom: "defer"` on the ruling, and logs one `[WARN]` (`{ storyId: "_run", findingId, from: "defer", to: "hold" }`). The ruling's ledger line ends with `(coerced from defer: no later review step)`.
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
The feature machine writes `branch-review.json` and `branch-rereview.json` itself, through a new `FeatureSink.artifact(name, value)`, after `assign()`, so the files carry the same `B<n>` ids as `result.json`. `runBranchReview` / `runBranchReReview` stop writing them.

### 5.2 Top-level verdict in `result.json`
`WorkflowResultFile` gains an optional top-level `verdict`, written by `publishStep`:

```ts
interface WorkflowVerdict {
  readonly workflowPassed: boolean;   // featurePassed && no open item of kind finding | ruling | gate
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
- every branch-level cannot-verify item recorded during this run (listed for the reader; it does not fail `workflowPassed`, matching `readinessReasons`, which never blocks on it) (the feature machine keeps them on the record as `cannotVerify: string[]`, in addition to the ledger line).
- every failing final gate, with its excerpt from `finalGateFindings`.

`workflowPassed` is the field a finishing tool reads. `featureWorkflow.passed`, the end report and `RunResult.success` keep their current meaning.

### 5.3 PR body: "Before marking ready"
When `openItems` is non-empty and the outcome is not `ready`, `buildWorkflowPrBody` renders a section right after "Stories":

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

Revised 2026-10-13 while planning, after reading the writers and the import graph (see §6.5).

### 6.1 Module
New `src/runstate/`, split so the writers never import git code:
- `src/runstate/store/` (nested barrel, imported by the writers): `classifyRunStatePath`, the `RunStateKeeper` class, the process-wide set of active keepers, and `runStateWrite`. It imports only `@/config/paths`.
- `src/runstate/` (barrel): re-exports the store, plus `verifyKeeper` (repair), `activateRunState` and `repairRunState`.

```ts
type RunStateKind = "prd" | "status" | "workflow-result" | "ledger" | "decisions";
type WriteIntent = { readonly content: string } | { readonly append: string };
function runStateWrite(path: string, intent: WriteIntent, write: () => Promise<void>): Promise<void>;
```

- **One keeper per run, scoped to the run's feature.** `activateRunState({ runId, feature, root })` creates it, seeds it and registers it. The runner deactivates it in its `finally`. A keeper tracks only `<any root>/.nax/features/<its feature>/...` files of a known kind: `prd.json`, `status.json`, `decisions.jsonl`, `workflow/<runId>/result.json`, `workflow/<runId>/ledger.md`. A second nax run on another feature in the same repo is never touched.
- **Writers record the intent before they write.** `runStateWrite` records the full new content (for an append: kept content plus the chunk, reading the file first when the path is not yet tracked). It marks the path in flight, awaits the real write, then clears the mark. The call sites are `atomicWriteText` (`utils/json-file.ts`, covers `savePRD`), `writeStatusFile` (`execution/status-file.ts`, covers heartbeat, feature and crash writes), `writeResult` (`workflow/result.ts`), `ensureLedger` / `appendLedger` (`workflow/ledger.ts`) and `appendDecision` (`advisor/ledger.ts`). With no active keeper, `runStateWrite` just runs the write, so CLI and plan paths are unchanged.
- Recording before the write closes the race with a concurrent verify: a verify that runs mid-write either skips the in-flight path or restores exactly the bytes nax is writing.
- **Seed** at activation: `prd.json`, `status.json` and `decisions.jsonl` under `featureDir(root, feature)`, when present. The workflow run dir files are tracked from nax's first write. Files under a parallel worktree are tracked from nax's first write there. Files nax never writes in this run are not protected.

### 6.2 Verify and repair
`repairRunState(ctx)` with `ctx = { storyId?, sessionName?, stage?, turn?, trigger, workdir? }` and `trigger` one of `turn | pre-commit | run-end | crash`:

1. Serialised by one promise chain, so two sessions ending turns at once never repair concurrently.
2. For each active keeper and each of its roots: one `hiddenNaxPaths(root)` call (`git ls-files -v -z`, exported from `utils/nax-index-flags.ts`).
3. For each tracked file not in flight: classify `missing`, `modified` (bytes differ) or `hidden` (index flag set). Hidden and modified can both apply.
4. Repair: clear the flags (`clearNaxIndexFlags`, scoped to the hidden tracked paths), then write the kept bytes atomically (tmp + rename).
5. Report per repaired file: one `logger.warn("runstate", ...)` with `{ storyId, sessionName, stage, turn, trigger, path, damage }`, message `<storyId> <stage> turn <n>: <rel path> <damage> by the agent; restored`. When the keeper tracks a workflow `ledger.md` under that root, also append `<storyId|_run>: run-state repaired: <rel path> (<damage>)` through `runStateWrite`. The run log (JSONL) and the ledger are the record; the per-session tool-audit sink is not used (it lives in nax-agent and is closed by turn end).
6. Never throws; a failed restore logs `[FAIL]` and continues.
7. **Fallback:** when no keeper is active and `ctx.workdir` is set, run the #2490 `clearNaxIndexFlags(workdir)` sweep, so non-run paths keep today's behaviour.

### 6.3 When it runs
- **After every agent turn:** `SessionManager` gains an `afterTurn(descriptor, turn)` hook (set through `configureRuntime`, called in the `finally` around `adapter.sendTurn`, `session/manager.ts:587`, after a success or a failure, and awaited with errors swallowed). It keeps a per-session turn counter. `createRuntime` wires it to `repairRunState({ trigger: "turn", storyId, sessionName, stage: role, turn })`. This covers native and ACP. The `session-turn` bus event is not used: it fires only on success, and its subscribers are not awaited. On ACP a turn is one delegated agent run, which still meets "within one turn".
- **Before every auto-commit:** `utils/git.ts` gains `registerBeforeAutoCommit(hook)`. `autoCommitIfDirty` awaits the registered hooks after its dry-run check. `activateRunState` registers `repairRunState({ trigger: "pre-commit", ... })` and unregisters on deactivate. Workflow `implement.ts` and `branch-fix.ts` commit through `autoCommitIfDirty`, so they are covered. The inversion keeps `utils/git` free of a `runstate` import (`runstate` reaches `utils/git` through `nax-index-flags`).
- **Before read-back:** not a separate trigger. Agents only act inside a turn, and every turn ends with a repair, so nax always reads repaired state. A background process the agent left running is caught at the next turn or commit.
- **Run end and crash:** the three #2490 sweep calls (`runner.ts:426`, `runner-completion.ts:542`, `crash-signals.ts:166`) become `repairRunState({ trigger: "run-end" | "crash", workdir })`. The crash path keeps the 2000 ms budget. `runner-completion.ts` (578/600 lines) must not grow: each call is a one-line swap.

### 6.4 Owned-paths deny (dropped)
Adding `status.json`, `result.json`, `ledger.md` and `decisions.jsonl` to `naxOwnedKind` was dropped while planning. `naxOwnedKind` also drives the Bash screen, which refuses reads too, so it would add exactly the false positives #2497 warns about. Repair covers these files.

### 6.5 Changes from the first draft
- The writers reach the keeper through `runStateWrite` and a process-wide registry (the `registerToolAuditSink` precedent), not `_deps` threading through about 25 `savePRD` callers.
- The keeper records before the write, not after, to close the race with a concurrent verify.
- A turn repairs every tracked file of every active keeper, not only the session's workdir. A session's workdir may be a package dir, and the files are few.
- There is no pre-read trigger (§6.3), no tool-audit entry (§6.2) and no owned-paths change (§6.4).
- `workflowPassed` (§5.2) is written to `result.json` only. The run's end report and `RunResult.success` keep using `featurePassed`.

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
- `session/manager` wiring test: the afterTurn hook runs after a turn that throws, and its failure never masks the turn's result.
- `utils/git` wiring test: `autoCommitIfDirty` restores a reverted PRD before committing.
- Existing sweep tests (`nax-index-flags.test.ts`, `crash-signals.test.ts`) keep passing via the fallback.

**Gates:** `bun run check:all` (root and package), `bun run typecheck`, `bun run test:coverage` for the touched packages.

## 10. Acceptance (from the issues)
1. An advisor `defer` at branch scope is not offered, and if returned is coerced to a flagged `hold` with a log line.
2. A defect introduced by the branch fix and confined to its diff gets one second fix pass, never more.
3. A draft PR body lists each open item in full with a promotion checklist.
4. `result.json` carries a top-level `verdict` with `workflowPassed` and `openItems[]`; `branch-review.json` findings have ids.
5. Every bypass in §9's matrix is detected within one turn, repaired, and logged with session, step and turn.
6. The repair runs after every turn on native and ACP, in pipeline and workflow mode, before every auto-commit, and at run end and crash.
7. The guard's known-gaps list references #2497 as the guarantee.
