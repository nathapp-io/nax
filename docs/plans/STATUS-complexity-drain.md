# Cognitive-complexity drain - status

The live doc for draining the functions whose Biome cognitive-complexity score is over
**60**, so `biome.json`'s `noExcessiveCognitiveComplexity` cap can drop from **170 to 60**.

Same shape as `STATUS-test-consolidation-drain.md` and its siblings: **section 0 is the
live state and is re-measured, never carried forward. Section 9 is append-only.**

Written to be executed **one batch per fresh session**, by an implementer with no memory of
earlier sessions. Everything a session needs is in this file and in the branch's history:
§S says how to start, §4 says which batch is next, §9 says what earlier batches learned.

---

## S. Start here - every session

All batches run on **one branch, `chore/complexity-ratchet`**, in the main nax checkout,
**one batch at a time**. Never run two batch sessions concurrently: they share the
working tree and the baseline file.

1. **Orient.**
   ```
   git branch --show-current     # must be chore/complexity-ratchet
   git status --short            # must be clean
   git log --oneline -5
   ```
   Wrong branch: `git switch chore/complexity-ratchet`. **Dirty tree: stop and ask the
   user.** It is either another session's work or an abandoned batch; do not discard it
   yourself.
2. **Read** §2 (rules), then the last three §9 entries (what earlier batches learned).
3. **Bring in main**, if it has moved - see §7. Do this only at the start of a batch.
4. **Re-measure** and confirm §4's status column matches reality:
   ```
   bun scripts/check-complexity.ts --list | awk '$1 > 60'
   ```
   A batch marked `done` whose function still scores over 60, or a `todo` function that
   is gone: trust the measurement, fix the table, note it in §9.
5. **Pick** the first batch in §4 whose status is `todo`, in table order. Find its function
   **by name** (`grep -n "<name>" <file>`); the line numbers in §4 drift after every batch.
6. **Mark it** `in progress` in §4 (uncommitted - it lands with the batch).
7. Do the batch: §2 rules, §3 techniques, §5 checklist.
8. **Close out** in the batch's final commit: set the status to `done <date>`, append the
   §9 entry, and refresh §0. (A commit cannot name its own SHA; §9 entries cite the
   previous batch's commits, and `git log --grep "refactor: <function>"` finds any batch.)

A batch is sized to finish in one session. If it cannot, follow §8 - never leave a
half-refactored tree for the next session.

---

## 0. Current state - measured 2026-09-27 (chore/complexity-ratchet, post-C3-commit, batch C3 complete)

```
bun scripts/check-complexity.ts --list        (strict limit 20)
  over 20    229 functions in 201 files   <- recorded in scripts/baselines/complexity-baseline.json
  over 60     2     (1 src, 1 scripts)   <- THIS DRAIN (only C4 generateCommand/main left)
  worst       99   src/cli/generate.ts generateCommand
biome.json cap: 170
batches: 24 of 25 done (P0, A1-A13, B1-B7, C1, C2, C3)
```

Refresh this block at the end of every batch:
```
bun scripts/check-complexity.ts --list | awk '$1 > 20' | wc -l
bun scripts/check-complexity.ts --list | awk '$1 > 60'
```

---

## 1. Goal, and what "done" means

- **Done** = zero functions over 60, and `biome.json` `maxAllowedComplexity` set to 60 in
  the final batch's commit. Opening the PR for the branch is then the user's call.
- **Not the goal:** getting any function to 20. The ratchet (`check:complexity`) already
  holds *new* code to 20. This drain is about the 29 functions where complexity is
  concentrated - most of them sit in the files with the most fix commits.
- After 60, the next milestone is 40 (38 more functions). Decide on it after this drain's
  §9 log shows what a refactor actually cost; do not start it by default.

## 2. Rules for every batch (each one exists because a gate will catch you)

1. **Behaviour-preserving only.** A batch changes structure, never behaviour. If you find
   a bug while refactoring, record it in §9 and file it; do not fix it inside the batch.
2. **Characterise before you cut.** Functions marked `test: none` in §4 have no mirror test
   file at the heuristic path. Before refactoring, find what exercises them
   (`grep -rn <functionName> test/`). If nothing pins the branches you are moving, add
   characterisation tests first, in their own commit, green against the *unrefactored* code.
3. **Extracted helpers must score <= 20.** `check:complexity` treats a helper split out of
   a baselined function as new code: an extra over-20 function in a baselined file is
   "grown", and one in a new file is "added". If a helper genuinely cannot get under 20,
   hand-edit the baseline in the same commit and justify it in the §9 entry. The file's
   total must still go down.
4. **File-size gate: extract to a sibling file, not in place.** 13 of the 29 files are
   within 100 lines of the 600-line limit, and `unified-executor.ts` (704) and `bin/nax.ts`
   (1948) are grandfathered and may not grow by one line. Splitting a function into helpers
   in the same file usually adds lines. Run `bun x biome check --write <file>` and **then**
   `wc -l` - Biome re-wraps, so the pre-format count is wrong.
5. **Lock the gain in.** After the refactor, `bun run check:complexity` fails with
   "baseline is stale" until you run `bun run check:complexity:update`. Commit the baseline
   change in the same commit as the refactor.
6. **Every commit is green.** The pre-commit hook runs `typecheck` + `check:all`; never
   bypass it with `--no-verify`. A red tree is never committed, so a fresh session always
   starts from a working branch.
7. **Commits per batch:** optional `test: characterise <function>` commit, then one
   `refactor: <function> complexity <before> -> <after>` commit carrying the refactor, the
   baseline update, and this doc's §0 / §4 / §9 changes.

## 3. Techniques, by shape

| Shape | Typical offender | What works |
|:------|:-----------------|:-----------|
| Field-by-field validator | `validateStory`, `validateConfig`, `coerceVerdict`, `parseFrontmatter` | Table-driven checks (`[field, predicate, message][]`) or the existing zod schema; one small function per field group |
| Line/char parser, big `if`/`switch` chain | `parseAcpxJsonLine`, `lexBashCommand`, `parseTestFailuresDetailed` | Dispatch map from event type/char class to a handler; early `continue`/`return` instead of nesting |
| Orchestrator / state machine | `executeUnified`, `runNativeTurn`, `ExecutionPlan.run`, `runFixCycle`, `handleRunCompletion` | Extract named phase functions that each take and return an explicit state object; the top function reads as a list of phases |
| Policy decision tree | `pathsBranch`, `resolveCodingToolSupport`, `decideStageAction` | Guard clauses first, then a decision table; name each branch's predicate |
| CLI action | `bin/nax.ts` action, `generateCommand`, `displayFeatureDetails` | One function per option group / output section; the action just sequences them |

Avoid the fake fix: helpers that take 6+ positional parameters, or pass a mutable bag in
and out, lower the score and make the code worse. The repo rule is <= 3 positional params,
options object beyond that (`docs/architecture/` function-design section).

## 4. The batches

25 batches, run in table order. **Status** is the only column a session edits:
`todo` -> `in progress` -> `done <date>`, or `skipped: <reason>` (see §6).

Scores, lines and `file:line` were measured 2026-09-27 and drift; find functions by name.
Churn and fix counts are **per file**, last 90 days, so treat them as a strong hint, not
proof. `test` = a mirror test file exists at `test/unit/<path>`.

### Pilot - calibrate the process on a pure, stable function

| Batch | Status | Score | Function | File:line | Lines | Churn / fix | test |
|:--|:--|---:|:--|:--|---:|:--|:--|
| P0 | done 2026-09-27 | 170 | `validateStory` | `src/prd/schema-story.ts:68` | 525 | 4 / 0 | none |

Pure, no I/O, zero fix commits, and the single worst score. Record in §9 how long it took
and what the helpers scored; use that to size the rest (see §6).

### Wave A - hot and defect-prone (one function per batch)

| Batch | Status | Score | Function | File:line | Lines | Churn / fix | test |
|:--|:--|---:|:--|:--|---:|:--|:--|
| A1 | done 2026-09-27 | 165 | `executeUnified` | `src/execution/unified-executor.ts:60` | 704 (size-gated) | 30 / 25 | none |
| A2 | done 2026-09-27 | 97 | `runNativeTurn` | `src/agents/native/session/turn-loop.ts:72` | 484 | 42 / 18 | none |
| A3 | done 2026-09-27 | 101 | `run` (ExecutionPlan) | `src/execution/story-orchestrator/execution-plan.ts:70` | 596 | 20 / 16 | none |
| A4 | done 2026-09-27 | 107 | CLI `run` action | `bin/nax.ts:240` | 1948 -> 1609 (size-gated) | 37 / 21 | none |
| A5 | done 2026-09-27 | 93 | hop callback | `src/operations/build-hop-callback.ts:191` | 599 | 33 / 19 | yes |
| A6 | done 2026-09-27 | 91 | `callOpDispatch` | `src/operations/call.ts:80` | 591 | 33 / 17 | yes |
| A7 | done 2026-09-27 | 74 | `resolveCodingToolSupport` | `src/agents/coding-tool-support.ts:312` | 601 -> 391 (size-gated) | 44 / 18 | yes |
| A8 | done 2026-09-27 | 127 | `pathsBranch` | `src/tools/policy.ts:429` | 600 -> 332 (at cap, may not grow) | 26 / 16 | yes |
| A9 | done 2026-09-27 | 71 | `handleRunCompletion` | `src/execution/lifecycle/run-completion.ts:111` | 563 -> 220 | 22 / 18 | none |
| A10 | done 2026-09-27 | 83 | `runFixCycle` | `src/findings/cycle.ts:72` | 544 -> 149 | 16 / 12 | yes |
| A11 | done 2026-09-27 | 70 | `runNonBlockingFix` | `src/execution/non-blocking-fix.ts:230` | 492 -> 261 | 17 / 13 | yes |
| A12 | done 2026-09-27 | 73 | `collectNeighbors` | `src/context/engine/providers/code-neighbor.ts:264` | 498 -> 375 | 17 / 11 | yes |
| A13 | done 2026-09-27 | 99 | `callTool` | `src/tools/runtime.ts:318` | 557 -> 479 | 31 / 8 | yes |

Ordered by fix commits, then by how central the function is to a run. A1 goes first
because it has the worst ratio (25 of 30 commits are fixes) and sits on every story's path
- but its file is size-gated at 704, so the batch must *also* bring the file down. A1 and
A4 are the two most likely to need more than one session; if so, split them per §8.

### Wave B - moderate churn (one function per batch)

| Batch | Status | Score | Function | File:line | Lines | Churn / fix | test |
|:--|:--|---:|:--|:--|---:|:--|:--|
| B1 | done 2026-09-27 | 96 | `decideStageAction` | `src/execution/post-run.ts:275` | 534 -> 321 | 14 / 7 | none |
| B2 | done 2026-09-27 | 76 | `sendTurn` | `src/agents/acp/adapter.ts:239` | 454 -> 252 | 15 / 7 | yes |
| B3 | done 2026-09-27 | 155 | `parseAcpxJsonLine` | `src/agents/acp/parser.ts:88` | 388 | 6 / 5 | yes |
| B4 | done 2026-09-27 | 73 | `runDeferredRegression` | `src/execution/lifecycle/run-regression.ts:205` | 587 | 10 / 6 | yes |
| B5 | done 2026-09-27 | 63 | `runParallelBatch` | `src/execution/parallel-batch.ts:122` | 417 -> 235 | 9 / 5 | yes |
| B6 | done 2026-09-27 | 66 | `displayFeatureDetails` | `src/cli/status-features.ts:329` | 503 -> 415 | 6 / 4 | yes |
| B7 | done 2026-09-27 | 69 | `runSession` | `src/interaction/ask-link.ts:216` | 559 -> 402 | 5 / 1 | yes |

### Wave C - stable, mostly pure (grouped)

| Batch | Status | Score | Function | File:line | Lines | Churn / fix | test |
|:--|:--|---:|:--|:--|---:|:--|:--|
| C1 | done 2026-09-27 | 110 | `validateConfig` | `src/config/validate.ts:30` | 175 | 4 / 0 | yes |
| C1 | done 2026-09-27 | 78 | `deepMergeConfig` | `src/config/merger.ts:41` | 173 | 2 / 2 | none |
| C2 | done 2026-09-27 | 75 | `parseFrontmatter` | `src/context/rules/rules-frontmatter.ts:110` | 293 -> 323 | 5 / 2 | yes |
| C2 | done 2026-09-27 | 72 | `coerceVerdict` | `src/tdd/verdict-reader.ts:98` | 319 -> 393 | 4 / 4 | none |
| C2 | done 2026-09-27 | 64 | `parseTestFailuresDetailed` | `src/test-runners/ac-parser.ts:50` | 141 -> 151 | 4 / 3 | none |
| C3 | done 2026-09-27 | 93 | `lexBashCommand` | `src/permissions/bash-lex.ts:78` | 248 -> 340 | 3 / 2 | yes |
| C4 | in progress | 99 | `generateCommand` | `src/cli/generate.ts:49` | 267 | 1 / 1 | none |
| C4 | in progress | 79 | `main` | `scripts/report-test-consolidation.ts:293` | 485 | 3 / 1 | none |

A grouped batch is one session; each function in it still gets its own `refactor:` commit.
C3 is alone because `lexBashCommand` is security-relevant (it feeds the permission
decision): run the command-safety corpus eval (`scripts/command-safety-eval.ts`) before and
after, and record both results in §9.

The final batch to reach `done` also sets `biome.json` `maxAllowedComplexity` to 60.

## 5. Per-batch checklist

```
bun scripts/check-complexity.ts --list | grep <file>     # before: note the score
# (characterisation tests first, own commit, if §2.2 applies)
# refactor
bun x biome check --write <touched files> && wc -l <touched files>
bun run check:complexity          # expect "baseline is stale"
bun run check:complexity:update   # lowers only; refuses if anything grew
bun run typecheck
bun run test
bun run check:all
bun run test:coverage             # NOT in check:all; per-file floor applies to new sibling files
# update §0, §4 status, §9 entry in this doc; commit
```

The §9 entry records: batch ID, function, score before -> after, helper scores, file lines
before -> after, time taken (sessions), anything surprising, and anything the next batch
should know.

## 6. When to stop, skip, or re-plan

- A batch needs a behaviour change to get under 60: stop, revert the refactor, mark it
  `skipped: needs behaviour change (#issue)`, file the issue, move on.
- A function's score only drops by moving complexity into helpers that fail §2.3 and §3's
  parameter rule: it is not ready. Mark it `skipped: <why>`, note it in §9.
- The pilot takes more than roughly two sessions: stop after P0 and re-plan Waves A-C with
  the user before continuing.

## 7. Bringing in main

`main` does **not** have the ratchet until this branch merges, so commits landing there can
add over-20 functions that this branch's gate will reject after a merge.

At the start of a batch, clean tree only:
```
git fetch origin
git log --oneline HEAD..origin/main | wc -l      # 0: skip the rest
git merge origin/main                            # merge, never rebase: history is shared across sessions
bun run check:complexity
```

- **Passes:** done.
- **Reports "added" or "grown"** for files the merge touched (and only those): that is
  main's new code, not this drain's regression. Hand-edit the baseline to add exactly those
  scores (`--update-baseline` will refuse, by design), run `bun run check:all`, and commit
  as `chore: recount complexity baseline after merging main`. List the files in a §9 entry.
  This is the one sanctioned raise, per `.nax/rules/test-ratchets.md` ("a deliberate,
  reviewed recount").
- **Merge conflict in `scripts/baselines/complexity-baseline.json`:** do not resolve it with
  `--update-baseline`. Take the lower score at each rank per file (a file absent from one
  side means none), then prove the tree meets it with `bun run check:complexity`.

## 8. When a batch will not finish in this session

Batches are never handed over half-done: the next session has no memory of your plan, and
a half-moved function is the hardest state to reason about.

1. Keep anything that is green on its own - usually the characterisation tests. Commit it.
2. Discard the unfinished refactor: `git restore <files>` and remove new sibling files you
   created. Check `git status --short` is clean.
3. Leave the batch `todo` in §4. If it is too big for one session, split it in the table
   (e.g. `A1a` extract the setup phase, `A1b` the escalation loop), each piece a batch that
   leaves the function lower and the tree green.
4. Append a §9 entry: what you tried, what you learned, what the next attempt should do
   first. Commit the doc.

## 9. Log (append-only)

### 9.0 - 2026-09-27, ratchet landed (`11ba0ef9a`, hardened `9dd73572d`)

`scripts/check-complexity.ts` runs the rule at 20 against a per-file baseline
(`scripts/baselines/complexity-baseline.json`, 255 functions / 221 files). `biome.json`
cap 176 -> 170. `9dd73572d` made the gate reject biome runs it cannot vouch for (parse
errors, summary mismatch, unexpected exit codes) and added end-to-end tests.
Next: P0.

### 9.1 - 2026-09-27, P0 done - `validateStory` 170 -> 0 (one session)

Field-by-field validator, exactly the shape §3's table predicted. One session, as the pilot
hoped: characterisation tests first (own commit, `test: characterise validateStory before
complexity drain`), then the refactor.

**Technique:** extracted every field's validation into its own function in a new sibling
file, `src/prd/schema-story-fields.ts` (417 lines) — not in `schema-story.ts` itself, since
that file was already 525 lines against the 600-line gate (§2.4). `schema-story.ts` is now
104 lines: unpack `raw`, call each extractor in the original field order, assemble the
`UserStory` literal. `normalizeStoryId` and `validateStory` are the only two symbols another
file (`schema.ts`) imports, so the sibling file's other exports (`extractId`,
`extractTitle`, ... 14 extractors, plus the local `normalizeComplexity`/`schemaError`
helpers) stay private to the pair.

**Helper scores:** all 14 extractors landed under 20 on the first pass — no baseline
hand-edit needed (§2.3 never triggered). The two largest, `extractTestStrategy` (BUG-26's
auto-downgrade branch) and `extractContextFiles`/`extractExpectedFiles`/`extractModifiedFiles`
(each doing the same relative-path-no-traversal check), still read as one coherent
responsibility each — no further split was tempting.

**One shared helper worth naming:** `checkRelativeNoTraversal(path, index, field)` factors
the identical absolute-path / `..`-traversal check duplicated three times in the original
(`contextFiles`, `expectedFiles`, `modifiedFiles`) into one function all three extractors
call. Not in §3's table because it's a cross-cutting duplication removal, not a per-field
extraction — worth checking for in any future field-by-field validator batch.

**File lines:** `schema-story.ts` 525 -> 104. `schema-story-fields.ts` new, 417 (well under
600, no near-limit follow-up needed).

**Baseline:** `check:complexity` reported only "improved" for `src/prd/schema-story.ts`
(never "added"/"grown") — none of the new helpers exceeded 20, so
`check:complexity:update` was a pure lower: 255 -> 254 functions, 221 -> 220 files (the file
dropped out of the over-20 baseline entirely, since every remaining function in it scores
under 20).

**Nothing surprising.** `bun run test:coverage` stayed green with no new file below the
per-file floor - the field's behaviour was already well covered indirectly via
`schema.test.ts` / `validatePlanOutput`, and the new characterisation file added direct
coverage on top.

**For the next batch:** the technique in §3's "Field-by-field validator" row worked exactly
as documented, including the sibling-file move for a near-the-limit source file (§2.4). Wave
C (`validateConfig`, `parseFrontmatter`, `coerceVerdict`, `parseTestFailuresDetailed`) is the
next shape match - expect the same pattern to apply directly. Wave A's orchestrators
(`executeUnified`, `runNativeTurn`, ...) are a different shape (state-machine, not
field-by-field) and will need the "named phase functions" technique instead - do not assume
P0's timing (one session) generalises to those.

### 9.2 - 2026-09-27, A1 done - `executeUnified` 165 -> 39 (one session)

The first orchestrator/state-machine batch, matching §3's "extract named phase functions
that each take and return an explicit state object" prediction. One session - contrary to
§4's own warning that A1 was one of the two batches most likely to need a split (§8). Read
the whole 704-line function first, worked out the shape, then wrote it in one pass; no
half-finished intermediate state needed leaving behind.

**Technique:** the while-loop's mutable locals (`prd`, `prdDirty`, `totalCost`,
`storiesCompleted`, `lastStoryId`, `warningSent`) became one `LoopState` object
(`unified-executor-dispatch-phases.ts`). Each dispatch shape is a function taking
`{ ctx, state, ... }` and returning a `DispatchStep` — `{ action: "continue" | "return" |
"fallthrough", state, exitReason? }`. `executeUnified` itself shrank to sequencing: reload
state if dirty, check completion, build `dispatchParams`, call `runParallelDispatch` (falls
through to sequential when `batch.length === 0`), then `runSequentialDispatch`. Every
`return buildResult(...)` in the original became `return buildResult(step.exitReason)` after
assigning `state = step.state` - the exit-reason strings themselves never changed, so this is
traceable line-for-line against the pre-refactor version in git history.

**The DI trap this batch exists to record:** `_unifiedExecutorDeps` (the test-injection seam
11 test files reassign — `runParallelBatch`, `runIteration`, `selectIndependentBatch`,
`preIterationTierCheck`) has to stay defined in `unified-executor.ts`, because
`src/execution/index.ts` re-exports it by reference for tests to mutate. Importing it INTO
the new phase files would cycle straight back to `unified-executor.ts`. Fix: the phase
functions take a `deps` parameter (`ParallelDispatchDeps` / `SequentialDispatchDeps`), and
`executeUnified` passes `_unifiedExecutorDeps.X` at each call site inside the loop - since
that's a fresh property read every iteration, a test's reassignment before the run starts is
still picked up. Getting this wrong would have silently broken the mock seam without any
type error to catch it - watch for the same shape (a `_xDeps` object with a barrel
re-export) in any future orchestrator batch.

**File-size gate, three-way split:** `unified-executor.ts` (704, size-gated) dropped to 280.
The extracted logic didn't fit in one sibling file - the first attempt
(`unified-executor-dispatch-phases.ts`, all three dispatch shapes) landed at 625 lines,
over the 600 cap for a NEW file (only grandfathered files may exceed it, and a brand-new
file is never grandfathered). Split it again: the two parallel-batch shapes
(`runManyStoryParallelBatch`, `runSingleStoryInBatch`, `runParallelDispatch`, plus their
private helpers) moved to `unified-executor-parallel-dispatch.ts` (440 lines);
`runSequentialDispatch` plus the shared `LoopState`/`DispatchStep`/`DispatchPhaseParams`
types and two small shared helpers (`closeStoryIfTerminal`, `runIterationDelay`) stayed in
`unified-executor-dispatch-phases.ts` (220 lines). Both comfortably under 600 - budget one
extra line-count check (`wc -l` after `biome check --write`, per §5) before assuming a single
sibling file will hold an orchestrator's whole dispatch logic.

**Helper scores:** `runManyStoryParallelBatch` alone scored 21 on the first pass (one over
20/§2.3) - the many-story branch's own for-loops and nested session-closing ifs still added
up even after being pulled out of `executeUnified`. Fix: extracted the
`batchResult.failed`-handling loop (the call into `handlePipelineFailure`) into its own
`handleParallelBatchFailures` helper, which also reads better on its own. Second pass: every
function in both new files scored under 20 - no baseline hand-edit needed.

**Source-order tests are the sharpest edge of this technique.** 7 of the ~2340 execution unit
tests failed after the split - all of them asserted the literal presence/ordering of strings
(`"cost-limit"`, `"story:started"`, `"handlePipelineFailure"`, `"batchResult.failed"`) inside
`unified-executor.ts`'s raw source text (`unified-executor-signature.test.ts`,
`unified-executor-results.test.ts`, `unified-executor-failure.test.ts` - all pre-existing,
from the original US-003 "unify executors" work). None were behavioural failures - the other
~2340 tests exercising the same ACs at runtime (mocking `_unifiedExecutorDeps` and asserting
on results) stayed green throughout. Fixed by repointing each `readSrc(...)` /
`Bun.file(...)` call at whichever new file the asserted code actually lives in now. Any
future batch that moves code between files should `grep -rl` the touched function/string
names across `test/` before declaring done - a green `bun test <targeted dir>` run is what
surfaces these, not typecheck or `check:all`.

**Nothing else surprising.** `bun run test:coverage` stayed green, same per-file floor count
as before (1 file below floor, unrelated to this batch). `check:import-cycles` stayed at 0 -
the DI-parameter approach above is exactly what kept it that way.

**For the next batch:** A4 (`bin/nax.ts` CLI `run` action, also size-gated) is the other
batch §4 flagged as likely needing a split - expect the same three concerns in order:
(1) does `_deps`-style test injection exist for this function, and if so does it live in a
file the extraction would need to import back from; (2) will one sibling file hold everything,
or does it need splitting again to stay under 600; (3) grep test/ for source-order assertions
on the function/file being moved, before calling the batch done.

### 9.3 - 2026-09-27, A2 done - `runNativeTurn` 97 -> 16 (one session)

Second orchestrator/state-machine batch. No `_deps`-style test seam here (unlike A1) - the
DI question from A1's write-up resolved to "no" on the first check, which is worth recording
as a passing case, not just a trap. Two-pass split, same as A1: the first extraction
(`runRoundTripLoop` alone in a new sibling file) still scored 50, so it split again into
three phase functions.

**Technique:** `runNativeTurn`'s while(true){while(true){...}} became three functions in a
new sibling file, `turn-loop-round-trip.ts` (393 lines): `maybeCompact` (the once-per-round-trip
compaction check), `runModelRoundTrip` (the model call, usage/anchor bookkeeping, and the
`after_response` dispatch - returns the tool calls or `undefined` for a clean exit), and
`dispatchToolBatch` (answers the tool calls, decides continue/break/throw). `runRoundTripLoop`
itself is now four lines of sequencing calling the three in order. `runTurnEndPhase` (the
`before_turn_end` dispatch + followUp continuation decision) is the fourth exported function,
unchanged from the first pass. `turn-loop.ts` drops to 278 lines: setup (transcript load,
event registry, `before_turn` dispatch, seed, tools) plus a four-line outer `while(true)` and
the error/completion tail.

**A real regression, caught by the existing suite, not by review.** The first version of
`runRoundTripLoop` used local `let messages`/`lastUsage`/etc. and returned a fresh
`TurnLoopState` object at the end - direct copy of A1's `LoopState` pattern. That pattern is
wrong here: A1's dispatch functions never throw mid-update, but this loop's
`batch.cancelled` path throws INTENTIONALLY, deliberately mid-loop, specifically so the
catch block's best-effort `saveTranscript` can persist whatever the tool batch already
produced (US-002, AC2/AC3). Returning a new object only at a clean return loses every
update since the LAST return the moment a throw skips it - exactly the synthetic
cancelled-tool-call messages the design depends on saving. 3 of 594 native tests failed
(`turn-loop.test.ts` "keeps the work already done when a later round trip throws",
`turn-loop-cancel.test.ts` AC2/AC3) - transcripts missing the assistant message and the
synthetic tool results. Fix: `runRoundTripLoop` now takes and MUTATES its `TurnLoopState`
argument in place (`state.messages = ...`, never `messages = ...` then return), so a throw
mid-loop still leaves the caller's object (the same reference) fully up to date. Documented
at length in the file's header comment - this is the one shape difference from A1's pattern
that matters, and it will recur in any orchestrator batch with an intentional mid-loop throw
whose catch block reads the loop's working state.

**`spinStopped` / `spinWarned` were two plain `let`s, one of them mutated by a closure set up
ONCE in setup** (`onSpinStop: () => { spinWarned = true; }`, registered before either
extracted function is ever called). Splitting the loop body out cannot split that closure's
target too. Fix: both flags became one `SpinFlags` object (`{ stopped, warned }`) created in
setup and threaded by reference into every extracted call - same shared-mutable-state
semantics as the original two `let`s, addressed through an object instead of two closed-over
bindings. Same category of fix as the state-mutation one above: a closure or a throw crossing
a function boundary both defeat "return a new value," and the fix in both cases is a shared
mutable object instead.

**Helper scores:** first pass put the WHOLE round-trip loop in one function at 50 (well over
20/§2.3). Second pass split it into the three phases above; the largest, `runModelRoundTrip`,
landed at 18. No baseline hand-edit needed either pass - once under 20, done.

**File-size gate:** `turn-loop.ts` was 483 lines going in (not size-gated, no baseline entry)
- comfortably clear of 600 even before this batch, so no near-limit follow-up like A1's. The
new sibling file landed at 393; no further split needed on that axis.

**Nothing else surprising.** `bun run test:coverage` stayed green, no new file below the
per-file floor. `check:import-cycles` stayed at 0.

**For the next batch:** A3 (`ExecutionPlan.run`, `src/execution/story-orchestrator/execution-plan.ts`)
is the next Wave A orchestrator. Check for the mutate-in-place trap FIRST this time, before
writing a return-a-new-object version: does any branch throw partway through a loop whose
state a catch block downstream reads? If yes, design the state object as mutate-in-place from
the start rather than discovering it via a failing test. Also check for closures set up once
in setup and read/written across loop iterations (the `SpinFlags` shape) - grep the function
for `() =>` closures capturing a `let` before assuming a clean state-object split.

### 9.4 - 2026-09-27, A3 done - `ExecutionPlan.run` 101 -> 0 (one session)

Third orchestrator batch, but a different shape from A1/A2: `run()` is a linear sequence of
five stages (resume hydration, canonical phase loop, rectification, two conditional resume
loops, ADR-024 non-blocking fix, verdict aggregation), not a `while(true)` with a
continuation decision. No throw-mid-loop trap, no `let`-closure trap (A2's two write-ups)
applied here — every `catch` in this file rethrows immediately, nothing downstream reads
loop state across a throw boundary. Checked both FIRST this time per A2's own note, and both
came back "no" cleanly rather than being found by a failing test.

**Technique:** extracted the six stages into a class-external `PlanParams` (`ctx`, `state`,
`isThreeSession` — bundled because they never change once `ExecutionPlan` is constructed)
plus a `PhaseTracking` (`phaseCosts`, `phaseOutputs` — the SAME two Records threaded through
every stage, mutated in place by `runPhase`, exactly as the original single function did:
nothing here ever reassigns either). `ExecutionPlan.run()` is now 8 sequential calls plus 3
guard `if`s — `phaseNames()` and the constructor stay on the class; every extraction is a
free function taking `PlanParams` explicitly rather than a private method, since a class
body can't itself be split across files.

**File-size gate, three-way split — same shape as A1, worse ratio.** The source file
(`execution-plan.ts`, 596 lines) was 4 lines from the 600 cap going in — the tightest margin
of any batch so far. First extraction (`execution-plan-phases.ts`, all six stages) landed at
684 lines, well over the 600 cap for a new file. Split again along the natural seam: verdict
aggregation (`buildStoryOrchestratorResult` + its private log helper, the largest and most
self-contained stage at ~225 lines) moved to `execution-plan-verdict.ts` (228 lines);
`execution-plan-phases.ts` dropped to 474. `execution-plan.ts` itself is now 98 lines. Same
lesson as A1's write-up: budget the `wc -l` check after `biome check --write` (§5) before
assuming one sibling file holds an orchestrator's whole body — for a linear multi-stage
function this looks like it should fit, and did not.

**A real bug caught while writing the extraction, not by a test.** Moving the verdict logic
into its own function, the `failedPhases` computation was rewritten as a plain
`!phasePassed(...)` filter and only caught on review-before-running: the original filter was
`if (verifierPassedSsot && name === gateName) return false; return !phasePassed(...)` — the
verifier-SSOT carve-out that exempts the full-suite gate from the failed-phases LIST, not
just from the `success` boolean. Dropping it would have kept `success: true` correct but
started listing the gate as a "failed phase" in the summary log for every verifier-carve-out
story — a silent log-only regression no functional test would catch (the field feeds
`docs/plans/STATUS-*` telemetry reads, not a return-value assertion). Restored before commit
by threading `gateName` and `verifierPassedSsot` into the log helper's own input type.
Worth naming as a category: a linear aggregation function's last stage (build a return value
+ a log) is exactly where a mechanical copy-paste of "the same filter, twice, with different
outputs" silently drops one branch's copy when only one of the two outputs is checked by
this session's own re-reading. Diff the extracted body against the original line-for-line
before moving on, not just against the passing test suite.

**Helper scores:** every extracted function landed under 20 on the first pass across all
three files - no second split needed inside any one function (unlike A2's `runRoundTripLoop`,
which needed two passes). The five-stage sequential shape apparently splits more cleanly than
a `while(true)` loop's tangled continue/break/throw paths - consistent with A1 (also clean on
the first pass) vs A2 (needed two).

**Nothing else surprising.** 474 tests across the story-orchestrator + related pipeline/nbf
suites stayed green throughout (151 in `test/unit/execution/story-orchestrator/` + 323 more
across pipeline stages, resume, nbf, and rectification-exhaustion tests). `test:coverage`
stayed green, same 1-file-below-floor count as before. `check:import-cycles` stayed at 0.

**For the next batch:** A4 (`bin/nax.ts` CLI `run` action, 1948 lines, size-gated and may not
grow by even one line) is next in table order and is the OTHER batch §4 flagged as likely
needing a split. Unlike A1-A3, its extractions cannot land back in the same file at all — every
extracted line is pure gain against the size gate, never a wash. Check first: does `bin/nax.ts`
have its own `_deps`-style test seam (A1's trap), any closures spanning a loop or an
intentional mid-loop throw whose catch reads loop state (A2's trap), and grep test/ for
CLI-source-order assertions (A1's fix) before writing the first line of the extraction.

### 9.5 - 2026-09-27, A4 done - CLI `run` action 107 -> 15 (one session)

The first CLI-action batch, matching §3's "one function per option group / output section; the
action just sequences them" prediction. One session, despite §4 flagging it (with A1) as likely
needing two. All three §9.2/§9.4 pre-flight questions were checked BEFORE writing any code and
all three had clean answers — writing them down here because A4 is the template for B6/C4
(the other CLI-action rows):

**(1) `_deps` seam: none, and one would have cycled.** `bin/nax.ts` has no `_deps` object at all
(every earlier batch's question resolved "no" instantly). But there IS an import-back trap of a
different shape: `warnIfPlanDegraded` was a top-level helper in `bin/nax.ts` used by BOTH the
run action and the `plan` command. Extracting the plan phase therefore forced the helper's
definition out of `bin/nax.ts` too (a sibling importing it back would cycle — same shape as
A1's `_unifiedExecutorDeps` trap, arrived at from the other direction). It now lives in the
sibling and `bin/nax.ts` imports it back. Rule of thumb for CLI batches: any symbol a moved
block calls that other commands ALSO call must move out first, never be imported back.

**(2) Source-order tests: 3 files pin `bin/nax.ts` as text — but only 3, and they pin code this
batch deliberately kept inline.** `test/unit/cli/bin-nax-parse-async.test.ts` (BUG-15: the
`loadConfig(naxDir ?? undefined, cliOverrides)` try/catch, every `loadPRD(prdPath)` wrapped),
`bin-nax-parse-async` ENH-47 (`join(runsDir, "latest.jsonl")` + `unlinkSync`/`symlinkSync`
within 600 chars, and the `node:fs` import line), `test/unit/cli/init.test.ts` (init delegation),
`plan-decompose-ac-repair.test.ts` (plan wiring). Rather than repointing them, the extraction
kept each pinned block inline in `bin/nax.ts` — the loadConfig try/catch, the TUI's loadPRD
try/catch (only the `renderTui` call moved), and the whole symlink block. Zero test edits. If a
future CLI batch wants those blocks moved, the tests must move with them (A1's repointing
pattern) — the sibling files' header comments say so.

**(3) Characterisation first, via the spawn precedent.** The run action had no mirror test
(`test: none`), but `test/integration/cli/cli-run-max-iterations.test.ts` already spawns
`bun bin/nax.ts run` for pre-config gates, which sanctions the same for the rest. New
`test/integration/cli/cli-run-preflight.test.ts` (11 tests, own commit
`test: characterise nax run preflight gates before complexity drain`, green against the
unrefactored binary): every pre-config gate's exit code + stderr, PLUS two gate-ORDER tests
(`-m 0 --plan` must fail with the max-iterations message; `--parallel 0 --schedule never`
with the parallel message). The order tests are the ones that would catch a scramble the
per-gate tests cannot. All 11 still pass against the refactored binary.

**Technique:** the ~478-line action body became 15 sequencing calls into two sibling files,
`bin/run-action.ts` (474: preflight gates, plan phase, logging/init, config overrides) and
`bin/run-action-execute.ts` (209: TUI mount, schedule wait, bake-off hand-off, the run() call,
headless summary). `bin/nax.ts` is 1948 -> 1609 (size gate: never grew; every extracted line
was pure gain). Helpers take explicit options-object params; commander's inferred `options`
is typed by an explicit `RunActionOptions` interface (two fields must be NON-optional to match
commander's defaults: `dir: string`, `dryRun: boolean` — typecheck catches this if a future
batch guesses wrong). The action's residual complexity is 15; it is no longer the worst
function in `bin/` (pre-existing `printHumanReadable` scores 20, exactly at the strict limit,
compliant and untouched).

**No A2 traps:** no closures capture `let`s across the extracted boundaries (the one closure
shape, `onSigint`, is created and consumed entirely inside `waitForScheduledRun`), and every
`catch` in the action either exits immediately or is the plan phase's own catch which wraps
only its own phase — nothing downstream reads loop state across a throw. The mutate-in-place
question was checked first per A2's note and answered "no" cleanly.

**Helper scores:** `validateBakeoffPreflight` 18 (the largest — the bake-off gate's own
nested ifs), `maybeRunPlanPhase` 11, everything else <= 10 across both files. First pass, no
second split needed inside any helper — consistent with A1/A3 (linear/sequential shapes split
cleanly) versus A2 (a `while(true)` needed two passes). No baseline hand-edit: `check:complexity`
reported only "improved" for `bin/nax.ts`, and `check:complexity:update` was a pure lower
(252 -> 251 functions, 218 -> 217 files — `bin/nax.ts` left the baseline entirely).

**File-size gate, one unplanned split:** the first sibling landed at 658 lines — over the
600-line cap a NEW file is held to (the discipline, not `check:file-sizes`, which only scans
`src/` and `test/`; `bin/` is out of its scope, which is also why 1948-line `bin/nax.ts` was
never grandfathered by the gate — the size rule here is this doc's §2.4). Split at the natural
seam (preflight/setup vs execute/summary). Lesson repeated from A1/A3: budget the `wc -l`
after `biome check --write` before assuming one sibling file suffices.

**Behaviour verified three ways, not two:** the characterisation suite (exit codes + stderr
per gate, and gate order), the pre-existing spawn-based integration tests (parallel,
max-iterations, profile flag) and BUG-15/ENH-47 source tests — all green — plus a
message/exit-code fingerprint diff of the old action vs the new action + siblings: 19/19
`exit(1)` sites, 3/3 `exit(0)` sites, every console message 1:1 (the only textual deltas were
variable renames: `finalPrd` -> the extracted function's `prd` parameter).

**One latent quirk found and recorded, not fixed (§2.1):** `--compare ""` (empty string) is
falsy, so the entire bake-off block is skipped and the run proceeds as a normal single-agent
run — a user passing an empty `--compare` gets no error. Pinned by a characterisation test so
the behaviour is at least now deliberate-looking; changing it needs its own issue.

**Nothing else surprising.** `bun run typecheck`, `bun run test` (all phases), `bun run
check:all` (all 35 scripts, including `check:import-cycles` at 0 and `check:file-sizes`), and
`bun run test:coverage` all green.

**For the next batch:** A5 (`hop callback`, `src/operations/build-hop-callback.ts:191`, 93,
599 lines, has tests) is back to a Wave-A orchestrator in a size-gated-adjacent file (599 of
600 — same tight margin as A3). Expect the A3 playbook: check the mutate-in-place and closure
traps first, extract phase functions to a sibling, and budget for the sibling file itself
needing a split. The new lesson for CLI-action rows (B6 `displayFeatureDetails`, C4
`generateCommand`): grep for source-text tests on the target file BEFORE extracting — if any
pin a block, either keep that block inline or move the assertion to the sibling in the same
commit.

### 9.6 - 2026-09-27, A5 done - hop callback 93 -> 2 (one session)

The Wave-A orchestrator §9.5 handed over, in the file it flagged as one line from the
size gate. One session. All three A1/A3 pre-flight questions were answered BEFORE writing
code, and one of them (the `_deps` seam) had the answer "yes, and it must not move".

**The `_deps` seam exists here, unlike A2-A4.** `_buildHopCallbackDeps` (6 reassignable
members; all four test files + `build-hop-callback-tier.test.ts` reassign its properties)
stayed in `build-hop-callback.ts`, and the phases receive it BY REFERENCE as
`input.deps`. That is enough: tests reassign the object's PROPERTIES between
`buildHopCallback()` and invoking the closure, and every phase reads `deps.X` at call
time. The A1 failure mode (importing the seam INTO the sibling, cycling back) was avoided
the same way; the only thing the siblings import from `build-hop-callback.ts` is
`import type` (erased at runtime, and `check-import-cycles` excludes type-only edges by
its own design - verified in the script before relying on it). `check:import-cycles`
stayed 0.

**A2's two traps: one real, one clean.** `preAttemptGitRefPromise` + `priorHopStartedAt`
are closure-scoped ACROSS closure invocations, and `composeHopPrompt` mutates both - so
they became one `HopClosureState` created once in the factory and mutated IN PLACE
(A2's rule). No throw crosses a state boundary: the only intentional throws live inside
`dispatchHopTurn`, which owns its own `timedOut` local across its try/catch/finally. No
closure set up once in setup and mutated across iterations (the `SpinFlags` shape) exists
- `send`/`openFresh` are created and consumed within a single invocation.

**`endpoint` was a closure side effect; now it is a return value.** The original assigned
a closure-scoped `endpoint` variable inside `openFresh` that only the success return ever
read - and it stays undefined exactly when a stale-retry reuses a warm handle.
`openFresh`/`acquireSessionHandle` now return `{ handle, endpoint }`, which makes the
"defined only when a session was opened" rule explicit (and testable - see below).

**Characterisation first** (own commit `test: characterise hop callback unpinned branches
before complexity drain`, 9 tests, green against the unrefactored closure): the
`CODING_TOOL_ROOT_MISSING` -> failed-AgentResult conversion (#1794), the rebuild-manifest
write's three arms (happy payload / no rebuildInfo / throwing swallow), timedOut-
overrides-keepOpen in the finally, and the `endpoint`/`dispatched` fields the fallback
loop reads (nax#1965 / US-001). None of the four was pinned anywhere in the three mirror
files or the integration suites. Two ratchet encounters along the way, both worth knowing
for future characterisation commits: (1) the pre-commit hook caught two genuine type
errors (wrong `HopKind` import path; helper signature misuse) - it works, do not treat
its failures as friction; (2) the test-escape-hatch ratchet FAILS when a NEW test file
adds even one `as T` cast (looseCast grows). The fixture cast
`as AgentRunOptions["modelDef"]` was removable outright (`ModelDef.provider` is a plain
string) - fix the fixture, not the ratchet.

**Technique:** the ~420-line closure became six named phases whose boundaries are the
comment-block seams the original already had: `composeHopPrompt` (elapsed bookkeeping,
once-only pre-attempt git-ref capture, swap rebuild + manifest write + handoff rewrite,
timeout-retry composition) -> `resolveHopTooling` (pull-tool runtime, preamble,
codingSupport with the #1794 early-return arm, diff-access substitution, interaction
handler) -> `prepareHopSession` (session name, transcript owner, pinned-modelDef
narrowing, `openSessionRequest`, `openFresh`) -> `acquireSessionHandle` (stale-retry
reuse / cancelled / cache-miss) -> `recordSwapHandoff` -> `dispatchHopTurn` (send
closure, hopBody, classifyThrownTurn, settleHopSession). `buildHopCallback` itself is now
setup + a six-call sequence scoring 2.

**Helper scores (first pass, all <= 20 - no second split, no baseline hand-edit):**
`composeHopPrompt` 18, `resolveHopTooling` 15, `send` 12, `classifyThrownTurn` 7,
`acquireSessionHandle` 6, `openSessionRequest` 6, `settleHopSession` 6, `dispatchHopTurn`
4, `prepareHopSession` 4, `turnResultToAgentResult` 3, `recordSwapHandoff` 3;
`buildHopCallback` 2 and its closure 2. Consistent with A1/A3/A4: phases split cleanly on
the first pass once the seam map is right.

**File-size gate, the split AGAIN:** `build-hop-callback.ts` 598 -> 197 (strictly
smaller, as the gate demands). But the single sibling holding all six phases measured
647 lines after `biome check --write` - over the 600 new-file cap, the FOURTH batch in a
row to need an unplanned second file (A1, A3, A4, now A5). Split at the natural seam:
`build-hop-callback-hop.ts` (479: compose/resolve/prepare/acquire/handoff + the shared
`HopInvocation`/`HopTooling`/`HopOutcome`/`HopClosureState` types) and
`build-hop-callback-dispatch.ts` (195: `dispatchHopTurn` + `classifyThrownTurn` +
`settleHopSession`). Treat "one sibling file" as a hypothesis, never a plan: for a
closure this size, budget two files from the start.

**One lint nuance recorded because it will recur:** `noMisusedPromises` (nursery, error)
fires on `maybePromise ? await maybePromise : undefined` in the NEW files but did not
fire on the byte-identical shape inside the old closure - not reproducible in isolation
(three probes of the exact original shape all fired). Rather than suppress, the check was
restructured to a local + `!== undefined` comparison, semantically identical (a Promise
object is always truthy) and shape-clean. Prefer that restructure over a biome-ignore;
there is no precedent for suppressing this rule in `src/`.

**Nothing else surprising.** 83 hop-callback unit tests green before and after; full
suite green (all phases); `check:all` green (import-cycles 0, file-sizes green);
`test:coverage` green with the below-floor count IMPROVING 2 -> 1 (new sibling files are
well covered via the existing suites + characterisation file - the coverage baseline can
be lowered at some future batch, not this one's job). `check:complexity:update` was a
pure lower: 251 -> 250 functions, 217 -> 216 files (`build-hop-callback.ts` left the
over-20 baseline entirely). One stale comment fixed in passing (`hop-endpoint.ts` header
still claimed build-hop-callback.ts was at the hard limit).

**For the next batch:** A6 `callOpDispatch` (`src/operations/call.ts:80`, 91, 591 lines,
test: yes) is the next Wave-A orchestrator and a sibling of this file - it imports
`buildHopCallback` from `./build-hop-callback`, whose public surface (barrel exports,
`_buildHopCallbackDeps`, `BuildHopCallbackContext`) is unchanged by A5, so A6 starts
clean. Pre-flight per this batch: call.ts HAS a `_callOpDeps` object with a
`buildHopCallback` seam (check whether moving `callOpDispatch` forces that object to
move - the A1 trap in reverse); check for closures/throws crossing the extraction
boundary; 591 lines means the extraction CANNOT land in `call.ts` itself, and budget two
sibling files. New lesson for any characterisation commit: new test files must not add
`as T` casts (the looseCast ratchet counts per file).

### 9.7 - 2026-09-27, A6 done - `callOpDispatch` 91 -> 2 (one session)

The Wave-A orchestrator §9.6 handed over, with its pre-flight questions all answered
BEFORE writing code. One session, including a 7-test characterisation commit first
(`test: characterise callOpDispatch unpinned branches before complexity drain`, green
against the unrefactored dispatch): complete-kind CALL_OP_ABORTED before retry and
during retry sleep, complete-kind MAX_COMPLETE_RETRY_ATTEMPTS exhaustion (21 attempts),
completeOptions.sessionName forwarding (both arms of the computeAcpHandle rule),
ctx.storyScratchDirs forwarding into hopCtx, and the run-kind bare parse-rethrow
(original error propagates untouched when no retry/fallback/recover/lastRetryTurn
engaged). Everything else was already pinned by the nine call* mirror suites.
New-file ratchet discipline held: zero `as T` casts (looseCast stayed 1474).

**The `_deps` seam exists, and the A1 trap applied in reverse exactly as §9.6
predicted.** `_callOpDeps` (sleep / buildHopCallback / readFileOutput — all three
properties reassigned by seven test files) stayed defined in `call.ts` because
`src/operations/index.ts` re-exports it by reference. The phase functions take it BY
REFERENCE as `params.deps` (the `CallOpDeps` interface in the prologue sibling) and
read `deps.X` at call time, so test reassignments keep landing. `check:import-cycles`
stayed 0.

**A2's traps: checked first, both clean.** The run branch's three closure `let`s
(`retryFallback`, `maxRetriesExceeded`, `lastRetryTurn`) became one `RunRetryState`
object created once per dispatch and MUTATED IN PLACE by `sendWithParseRetry` from
deep inside the hop — designed mutate-in-place from the start this time, per §9.3's
note; the "two sendWithParseRetry calls have independent retry state" test pins the
reset semantics. No closure set up once in setup and mutated across iterations (the
SpinFlags shape); no catch reads loop state across an intentional mid-loop throw (the
abort throws propagate out of callOpDispatch; nothing catches them locally).

**Technique:** the ~506-line body became a three-file phase split around a shared
prologue — `call-dispatch-prologue.ts` (140 lines: `DispatchPrologue` +
`buildDispatchPrologue` 8, the `CallOpDeps` type, and the three shared throw helpers
`throwNoDispatch` / `throwAborted` / `throwRetryBudgetExhausted`, which also factored
the genuinely duplicated zero-dispatch and fallback-validation literals),
`call-dispatch-complete.ts` (163: `dispatchCompleteOp` 11, `decideCompleteRetry` 7,
`buildCompleteOptions` + its `modelDefFor` arrow 4 each), `call-dispatch-run.ts` (529:
`dispatchRunOp` 6, `buildHopContext` 6, `createRunSenders` holding
`sendWithParseRetry` 20 / `sendWithFileOutput` 2 / `effectiveHopBody` 2,
`handleRunEmptyOutput` 5, `parseRunOutcome` 4, `handleRunParseFailure` 6, plus
`attachOutcomeAdapterFailure` moved here from call.ts and re-exported so its import
path is unchanged). `callOpDispatch` itself scores 2, `callOp` 3. Verified with a
string-literal fingerprint diff of the original body against the three siblings:
every error code, error message, and log message is 1:1 — the only textual deltas are
the shared helpers now assembling `callOp[op.name]: <message>` from verbatim parts,
and `(${typeof retryFallback})` -> `(${typeof fallback})` in the invalid-fallback
message (renamed variable, identical runtime output).

**Helper scores:** largest is `sendWithParseRetry` at 20 — exactly AT the strict
limit, compliant per §2.3 (same as A4's `printHumanReadable` at 20), and it is one
coherent per-turn retry loop rather than a candidate for a fake split. Everything
else <= 11. No baseline hand-edit (§2.3 never triggered).

**File-size gate: the "budget two sibling files" rule did not fire for once —
because the split was planned in from the start.** `call.ts` 591 -> 72; the siblings
measured 140 / 163 / 529 after `bun x biome check --write`, all under 600. The
difference vs A1/A3/A4/A5's first-attempt overruns: each op-kind branch got its OWN
file and the shared prologue a third, instead of one file holding every phase of the
function. For a two-branch dispatch function, one file per branch is the natural
seam; plan it that way from the first line.

**One near-miss worth naming (A3's diff-the-original lesson, verified here):** the
complete-retry warn log uses `agentName: ctx.agentName` while the shouldRetry CONTEXT
one line above uses `dispatchAgent`, and the complete branch records
`resolved.modelTier` (not effectiveTier) — asymmetric on purpose in the original. A
mechanical "cleanup" unifying either would have been a silent behaviour change the
suite would not catch. Both preserved exactly.

**Nothing else surprising.** 22043 tests across all phases green (the nine call*
mirror suites exercise the moved paths directly, plus the 7 characterisation tests);
`check:all` green (35 scripts, import-cycles 0, file-sizes green); `test:coverage`
green, below-floor count 1 vs baseline 2 (the improvement A5 noted stands;
lowering the baseline is a future batch's job). `check:complexity:update` was a pure
lower: 250 -> 249 functions, 216 -> 215 files (`call.ts` left the over-20 baseline
entirely — every function in it now scores under 20).

**For the next batch:** A7 `resolveCodingToolSupport` (`src/agents/coding-tool-support.ts:307`,
74, 601 lines, test: yes) — §3's "policy decision tree" row, the first of that shape
in Wave A. Its file is ONE LINE OVER the 600 cap going in, so like A3/A6 the
extraction cannot land in the same file at all. Pre-flight per this batch: (1) check
for a `_deps`-style seam re-exported through a barrel; (2) the decision-tree shape
wants guard clauses first, then a named-predicate decision table — NOT named phase
functions; (3) grep test/ for source-text assertions on the file before extracting;
(4) still budget the sibling for a split, since moving the function's body out means
the sibling carries nearly all 601 lines' worth of logic.

### 9.8 - 2026-09-27, A7 done - `resolveCodingToolSupport` 74 -> 11 (one session)

The first "policy decision tree" batch, the shape §3's table predicted. One session.
Pre-flight questions all answered BEFORE writing code: (1) `_codingToolSupportDeps`
(loadConfigForPackage) EXISTS and is reassigned by two test files
(`coding-tool-support.test.ts` "load failure" test, `one-connection-per-worktree.test.ts`
via `Object.assign`) — it stayed defined in `coding-tool-support.ts` and reaches
`loadPackageEffectiveConfig` BY REFERENCE, read at call time; there is no barrel
re-export to cycle through. (2) A2's traps both clean: no closure captures a `let`
across the extraction boundary, and the function's one try/catch owns its local
scope entirely — nothing downstream reads state across a throw. (3) No source-text
test pins `coding-tool-support.ts` — grep found only comments mentioning the file
(`coding-tool-bash.test.ts` header, `acceptance-fix.test.ts`, `bash-deny-suite.test.ts`).
Zero test edits in the refactor commit.

**Characterisation first** (own commit `test: characterise resolveCodingToolSupport
unpinned branches before complexity drain`, 4 tests, green against the unrefactored
function). The mirror suites pin nearly everything; four branches nothing covered:
(a) a provider-only op whose only provider THROWS must log the `[provider] dropped`
warn AND still return undefined (the warn loop + the empty-union guard after an R15
op goes unreal); (b) the fully-empty union (`declaredTools: []`, no providers) ->
undefined; (c) a runtime config whose `stripEnvVars` is not an array (reachable only
through RULING F2's type lie) must strip nothing, not throw; (d) a command entry
whose value is neither string nor array is dropped from the declared-command map.
Checked while writing (d): `QualityCommandSpec = string | string[]`, so the filter
admits every VALID spec — the junk branch is defensive, not a bug (§2.1 clean). The
main mirror file sits at exactly 800 lines, so the tests went in a new sibling,
`coding-tool-support-dispatch-edges.test.ts` — zero `as T` casts (Object.assign for
the F2-junk configs), looseCast stayed 1474.

**Technique:** guard clauses and branch predicates became named functions in a new
sibling, `coding-tool-support-resolve.ts` (412 lines): `hasUsablePackageDir` (the
5-condition package/project guard — duplicated VERBATIM in the original's load guard
and its packageWorkdir spread; P0's "one shared helper worth naming" showed up here,
now called from both), `loadPackageEffectiveConfig` 6, `extractDispatchConfigFields`
4 (the WidenedDispatchConfig read — all members optional, so `NaxConfig | AgentManagerConfig`
assigns WITHOUT the original's widened-literal cast), `declaredCommandsFrom` 1,
`resolveCommandCwd` 3, `resolveDispatchAuditDir` 4, `buildLedgerHeader` 4,
`resolvePackageNameForDispatch` 3, `resolveProviderContribution` 10 (Mcp partition +
the R12 admits arm + the empty fallback), `unionDeclaredTools` 2,
`warnDroppedProviders` 1, `resolveDispatchLauncher` 9, `optionalDispatchArgs` 8
(8 option-forwarding conditional spreads), `resolvedDispatchArgs` 8 (8 resolved-value
conditional spreads). `resolveCodingToolSupport` itself stays in coding-tool-support.ts
as the sequencer — public surface unchanged — and scores 11; `buildCodingToolSupport`
is untouched at 38 (pre-existing; within reach of the 40-milestone discussion).

**The final args literal split by key class:** every conditional-spread key went into
`optionalDispatchArgs` (from `options`) or `resolvedDispatchArgs` (from earlier
steps); the 14 unconditional keys stay in the literal in the sequencer. Keys are
unique across the three parts, so the merged object is identical regardless of
spread order (verified with a string-literal fingerprint diff of the old body vs the
new pair: empty delta; and a per-key presence check: 1:1).

**File-size gate, single sibling held for once:** `coding-tool-support.ts` measured
600 lines at batch start (the doc's 601 had drifted — Biome had re-wrapped under A6's
gates), exactly AT the 600 cap and NOT in the file-sizes baseline, so it could not
grow by one line; it is now 391. The sibling landed at 412 after `biome check --write`
— the per-branch + partial-args split planned from the first line (A6's lesson) is
why the "budget two sibling files" rule did not need to fire.

**One NEW gate shape, worth naming for every future batch that MOVES code between
files:** `check:no-silent-naxconfig-cast` allow-lists `as unknown as NaxConfig` PER
FILE. The F2 cast is exempted in `coding-tool-support.ts` by name — moving the
byte-identical cast to the sibling tripped the guard mid-`check:all`. Fixed per the
guard's own documented procedure: swapped the allow-list entry to the new file with
the ruling text (the old exclusion is gone; main no longer casts). Lesson:
`grep -Rn "grep -vE" scripts/` for per-file guard allow-lists (naxconfig-cast,
rules-drift, etc.) covering the file being emptied, BEFORE the first `git mv`-style
move — they fail only at `check:all`, after everything else is green.

**One self-inflicted near-miss:** replacing the body by line number AFTER editing the
imports (same step) shifted the cut point by the 5 lines the import edit added and
silently dropped `_codingToolSupportDeps` from the file. `tsc` caught it on the next
command (TS2304), restored with a normal edit. Lesson: cut by content marker, never
by line number, once anything above the cut has been edited in the same session.

**Nothing else surprising.** `bun run typecheck`, `bun run test` (all phases),
`bun run check:all` (35 scripts; `check:import-cycles` 0 — the sibling imports
coding-tool-support.ts TYPE-ONLY, which the cycle checker excludes, verified in the
script per §9.6), and `bun run test:coverage` all green; below-floor count 1 vs
baseline 2 (the standing improvement, not lowered here). `check:complexity:update`
was a pure lower: 249 -> 248 functions, 215 -> 215 files — the file stays baselined
at `[38]` because `buildCodingToolSupport` is still over 20.

**For the next batch:** A8 `pathsBranch` (`src/tools/policy.ts:429`, 127 — the worst
SRC function now that parser.ts's 155 is the only one above it), 601 lines, test: yes
— same "policy decision tree" shape as A7, same one-line-over-the-cap file situation.
Pre-flight, in order: (1) `grep -Rn "grep -vE" scripts/` for per-file guard
allow-lists naming `tools/policy.ts` (this batch's naxconfig-cast surprise
generalises), plus the usual `_deps`-seam and source-text-test greps; (2) decision
table: name each branch's predicate, split conditional spreads/args by key class;
(3) budget the sibling split anyway. Also worth noting for the post-drain milestone
discussion: with the over-60 set down to 21, `buildCodingToolSupport` (38) and
friends are already close enough to 20 that the 40-milestone may be cheaper than §1
assumed.

### 9.9 - 2026-09-27, A8 done - `pathsBranch` 127 -> 8 (one session)

The second "policy decision tree" batch (§9.8's hand-over), and the last function over
100 outside `parser.ts`. One session. Pre-flight all answered BEFORE writing code:
(1) no per-file guard allow-list names `tools/policy.ts` (`grep -Rn "grep -vE" scripts/`
finds only the naxconfig-cast list; policy.ts is not on it, and the moved code has no
casts); (2) NO `_deps`-style seam — the barrel (`src/tools/index.ts`) re-exports only
`compileToolPolicy`, `resolveWithin`, and type `ToolPolicyOptions` from policy.ts, so
nothing tests mutate through policy.ts; (3) no source-text tests pin the file (grep
found comments only); (4) file measured 600 lines at start (the doc's 601 had drifted,
same as A7) — AT the cap, so the extraction could not land in place.

**Characterisation first** (own commit `test: characterise pathsBranch unpinned branches
before complexity drain`, 13 tests, green against the unrefactored branch). The mirror
suites (`policy.test.ts` 793 lines, `policy-confine-to.test.ts`, `git-interception.test.ts`)
pin the allow/deny/breach flows and every confinement AC, but NOTHING pinned: the five
input-shape guard denials (`"field" must be a string path`, `... or an array of string
paths`, `... must be an array of string paths`, `... must be an array of string refs`,
`... entries must be strings`); the `"HEAD:"` empty-path-half continue (pinned
discriminatingly under a restrictive glob grant, which would deny if the empty half were
resolved); the confineTo root-ESCAPE refusal (message + breach:false, plus a guard-ORDER
test); the listPathFields array-of-strings arm; and the two glob predicates' asymmetry
(see below). `policy.test.ts` had only 7 lines of headroom under the 800-line test cap,
so the tests went in a new sibling, `policy-paths-branch-edges.test.ts` — zero `as T`
casts, looseCast stayed 1474. One test-design discovery: an UNconditional deny rule is
intercepted in `check()` before `pathsBranch` ever runs, so the guard-order test uses a
SCOPED deny rule (which fires inside the per-path loops) to prove the confineTo guard
precedes them.

**The load-bearing quirk this batch exists to record:** the four field-kind loops use
TWO DIFFERENT glob predicates. `pathFields` and `listPathFields` check
`!grant.unconditional && !matchesAny(globs, rel)`; `arrayPathFields` and `refPathFields`
check `restrictPaths && !matchesAny(globs, rel)` where `restrictPaths` additionally
requires `globs.length > 0`. Under a verb-only grant (conditional, no path globs), string
path fields are DENIED while array/ref paths stay bounded by the root alone. This is
pinned behaviour ("a verb-only grant leaves paths bounded by the root alone", mirror line
222), not obviously intentional for the string loops — recorded as a quirk, NOT unified
(§2.1). The split is preserved as two named frame fields (`enforcePathGlobs` /
`restrictPaths`) with a module-comment explaining it, and both sides now have
characterisation tests.

**Technique:** guard clauses + named predicates in a new sibling,
`src/tools/policy-paths-branch.ts` (399 lines): `entersGitMetadata`, `resolveWithin`
(re-exported from policy.ts, so `glob.ts`/`package-managers.ts`/`scratchpad.ts`/barrel
imports are untouched), `outOfRootReason`, and `pathMatchers` moved VERBATIM (all used
only by `pathsBranch`); then `stripConfinePrefix` (the confined-prefix removal, now a
named pure function), `repoRelative`, a `PathCheckFrame` (per-policy ctx + the call +
walk scratch incl. the `resolvedPaths` array, mutated in place per A2's rule), the shared
`checkPathSegment` (resolve -> breach deny -> applyPathRules -> glob -> record; the two
things that actually differ between loops — the denial's subject spelling and the glob
predicate — are its named parameters), and the four handlers `runPathFields` /
`runListPathFields` / `runArrayPathFields` / `runRefPathFields`. The sibling imports
NOTHING from policy.ts (no cycle; `check:import-cycles` 0) — the collaborators that stay
closure-bound in policy.ts (`deny`, `askVerdict`, `applyPathRules` byte-identical at 13,
plus `resolvedRoot`) arrive by reference in `PathsBranchContext`, read at call time.
`pathsBranch` is now: confineTo guard -> frame -> four sequential handler calls -> final
ask/allow ternary. `compileToolPolicy` itself dropped to 4. Verified with a
template-literal fingerprint diff old vs new: every type-guard literal, breach message
(incl. the ref loop's `"${field}" entry "${value}"` + `candidatePath` split between
subject and outOfRootTarget), the `true` breach flag, the four "is not granted" messages
(now one shared helper), and the confineTo escape message are 1:1.

**Helper scores:** `runRefPathFields` 20 — exactly AT the strict limit, compliant per
§2.3 (same as A6's `sendWithParseRetry`), and a coherent single loop, not a fake-split
candidate; `runListPathFields` 17, `runArrayPathFields` 14, `pathsBranch` 8,
`runPathFields` 7, `checkPathSegment` 4, `resolveWithin` 5, `outOfRootReason` 5,
`stripConfinePrefix` 4, everything else <= 2. No baseline hand-edit (§2.3 never
triggered).

**File-size gate, single sibling held:** `policy.ts` 600 -> 332; the sibling landed at
399 after `bun x biome check --write` — under 600 with room, so for the first time since
A1 the "budget two sibling files" rule never came close to firing. The difference is that
this extraction MOVES four whole self-contained helpers (~120 lines of the 600) instead
of rehousing an entire function body; the moved-helper pattern is worth trying first in
any batch whose target function has private single-consumer helpers.

**One inverted edit caught in seconds, worth naming:** a removal Edit was submitted with
old/new swapped, silently RE-ADDING the moved blocks; the next edit's old_string no
longer matched and the mistake surfaced immediately. Nothing reached a commit — but the
general lesson stands: after any multi-step sequence of content-marker edits on one file,
`git diff --stat` BEFORE the next step, not after.

**Nothing else surprising.** `bun run typecheck`, `bun run test` (all phases; the eight
policy/interception/edges suites alone are 233 tests), `bun run check:all` (35 scripts;
import-cycles 0, file-sizes green, looseCast 1474), and `bun run test:coverage` all
green; below-floor count 1 vs baseline 2 (the standing A5 improvement, still not
lowered). `check:complexity:update` was a pure lower: 248 -> 247 functions, 215 -> 215
files — policy.ts stays baselined at `[29, 23]` (`argvBranch`/`verbBranch`, untouched,
out of this batch's scope).

**For the next batch:** A9 `handleRunCompletion`
(`src/execution/lifecycle/run-completion.ts:111`, 71, 563 lines, `test: none`) — back to
the Wave-A orchestrator shape, with NO mirror test file, so §2.2's "find what exercises
it" sweep is the first job and the characterisation commit will be bigger than A7/A8's.
Pre-flight per this batch: (1) grep test/ for source-text assertions on run-completion.ts
before planning the split; (2) check for a `_deps`-style seam and barrel re-exports;
(3) 563 lines + extraction means the sibling split must be planned from the first line
(A6's one-file-per-branch seam); (4) the post-drain milestone note from §9.8 stands —
over-60 is now 20, and `buildCodingToolSupport` (38) et al. remain within reach of the
40-milestone discussion.

### 9.10 - 2026-09-27, A9 done - `handleRunCompletion` 71 -> 1 (one session)

The Wave-A orchestrator §9.9 handed over, §2.2's sweep done first as instructed. One
session. Pre-flight all answered BEFORE writing code: (1) NO source-text tests pin
run-completion.ts — grep found comments only, so the refactor commit edited zero tests;
(2) `_runCompletionDeps` EXISTS (4 members) and is re-exported through
`src/execution/lifecycle/index.ts` and the outer barrel — it stayed defined in
run-completion.ts, and each phase receives it BY REFERENCE under a narrow per-phase
interface (`RegressionGateDeps`, `TeardownDeps`, `PurgeDeps`), reading `deps.X` at call
time; the siblings import run-completion.ts TYPE-ONLY (a runtime import would cycle back
to the seam — the A1 trap; `check:import-cycles` stayed 0); (3) A2's traps both clean,
checked first: the one intentional throw (the regression gate's catch) rethrows out of
handleRunCompletion entirely after emitting the failed phase event — nothing downstream
reads state across it — and no closures capture `let`s (straight-line function, no
SpinFlags shape). The in-place mutations (RL-004 story marking into `prd`, #679 rows
into `allStoryMetrics`) cross phase boundaries as object/array references, not `let`
rebindings, so mutate-in-place held without even needing the A2 discipline engaged.

**Characterisation first** (own commit `test: characterise handleRunCompletion unpinned
branches before complexity drain`, 16 tests, green against the unrefactored function).
Seven run-completion* mirror suites plus lifecycle-completion, rl002 and dry-run pin most
branches; NOTHING pinned: the regression-gate throw path (the failed
postrun:phase:completed is emitted, then the SAME error object is rethrown),
`on-final-regression-fail` (both arms: fires with hooksConfig, silent without),
`skipRegression: true`, the `isSequential === false` storyMetrics-withholding
(#1527/#1528) plus the sequential projection shape, the AC-20 scratch-purge half (the
manifest half was pinned; projectDir resolution, the archive flag, and the info/warn
logs were not), `pluginProviderCache.disposeAll()`, the saveRunMetrics payload shape,
the stalled/aborted final-status arms (EXEC-1), and AC-25's contextCostUsd (log-only).
Three behaviours were DISCOVERED while writing the pins and pinned as-is (§2.1):
(a) `context.v2.session` carries a schema DEFAULT (retentionDays 7), so the scratch
purge always runs under a validated config — the `if (sessionCfg?.retentionDays)` false
arm is unreachable through config, defensive only; (b) `storiesFailed` mirrors
`finalCounts.failed` (status-based), not "stories that did not pass"; (c) applyBackfill
runs BEFORE saveRunMetrics, so the saved payload's `stories` is the live, backfilled
array — `totalStories` counts synthetic rectification rows the caller never passed.
New-file ratchet discipline held: zero `as T` casts, looseCast stayed 1474. Two gates
caught real things mid-flight, both worth knowing for future characterisation commits:
the pre-commit hook's `check:test-mocks` forbids a local `function makeConfig(` in NEW
test files (legacy files are skip-listed — the wrapper needed a different name), and the
escape-hatch ratchet counts `[] as StoryMetrics[]` (typed the literal instead).

**Technique:** the ~450-line body became eight named phases across two siblings, cut at
the comment seams the original already had. `run-completion-regression.ts` (305):
`runRegressionGate` 4 (guards + orchestration), `executeRegressionGate` 4 (postrun
phase events, the `deps.runDeferredRegression` call with its throw-emit-rethrow catch,
pass/fail surfacing), `markRegressionFailedStories` 3 (RL-004/#1292, comment moved
verbatim), `mergeRegressionStoryMetrics` 16 (#679 fold-in — the largest helper, one
coherent loop, not a fake-split candidate). `run-completion-phases.ts` (395):
`consumeDeferredReview` 3 (#1146 G2), `snapshotCostsAndBackfill` 2 (Bug 909 totals +
the nax#1721 backfill call), `teardownRunSessions` 1 (ADR-020 §D3/PERF-1),
`emitRunCompletedAndSaveMetrics` 3 (RL-002 event + drain + best-effort save),
`purgeStaleRunArtifacts` 12 (the two fail-open halves, AC-20 + US-002),
`logRunCompletion` 3 (+2 for the AC-25 reduce callback), `writeFinalStatus` 10 (the
EXEC-1 ternary chain). `handleRunCompletion` itself scores 1: destructure, eight phase
calls in the original execution order, return literal. `durationMs`/`runCompletedAt`
stayed computed in the sequencer exactly where the original computed them (after
backfill, before teardown) so the timing semantics do not shift by a single phase.

**File-size gate, single sibling held — planned from the first line (A6's lesson).**
run-completion.ts measured 562 going in (the doc's 563 had drifted by one, same as
A7/A8) and is now 220. The seam was chosen before writing: the regression gate is one
file, everything after the gate is the other; 305 + 395 after `bun x biome check
--write`, both under 600 — the first Wave-A batch where the "budget two sibling files"
rule resolved without an unplanned split, because the split WAS the plan.

**Verification beyond the suite:** a literal fingerprint diff of the original body
against the new trio — every string literal of length >= 4 (event types, status names,
log/error messages, hook names) appears verbatim; zero missing. 536 tests across the
completion-adjacent suites green (the seven lifecycle suites, rl002, dry-run, four
runner-completion files), then the full suite.

**Nothing else surprising.** `bun run typecheck`, `bun run test` (all phases),
`bun run check:all` (35 scripts; import-cycles 0, file-sizes green, looseCast 1474),
and `bun run test:coverage` all green; below-floor count 1 vs baseline 2 (the standing
A5 improvement). `check:complexity:update` was a pure lower: 247 -> 246 functions,
215 -> 214 files (`run-completion.ts` left the over-20 baseline entirely —
`handleRunCompletion` is now 1). One small doc-convention note: `--list | awk '$1 > 20'`
counts the trailing `Total ...` row (string "Total" compares above "20"), so the §0
`wc -l` command over-states the function count by one; §0 now records the script's own
total line instead.

**For the next batch:** A10 `runFixCycle` (`src/findings/cycle.ts:72`, 83, 544 lines,
test: yes) — the next Wave-A orchestrator and the shape most likely to hit A2's
mutate-in-place trap for real: a fix CYCLE is exactly where an intentional mid-loop
throw whose catch reads loop state lives (the loop exists to record failed attempts).
Check that FIRST, before writing a return-a-new-object version. Then: (1) find its
`_deps`-style seam if any (`grep -n "_deps\|Deps" src/findings/cycle.ts`) and check
whether any barrel re-exports it; (2) 544 lines + extraction means the sibling split is
planned from the first line (A6's seam rule; A9's gate/post-gate cut is the template);
(3) A10 has mirror tests, so no characterisation commit is expected — but grep the
mirror suites for which branches they pin before trusting them; (4) the over-60 set is
down to 19 and every remaining Wave-A function has mirror tests — the remaining
characterisation-first work in this drain is likely zero.

### 9.11 - 2026-09-27, A10 done - `runFixCycle` 83 -> 20 (one session)

The Wave-A orchestrator §9.10 handed over, and its first check (the A2 mutate-in-place
trap) was exactly where the batch's one real design decision lived. One session, no
characterisation commit — the pre-flight confirmed §9.10's suspicion that the mirrors
pin everything. Pre-flight, all answered BEFORE writing code: (1) `_cycleDeps` EXISTS
(`callOp?`/`now`, exported from cycle.ts and re-exported through `src/findings/index.ts`)
but NO test reassigns it — the only references in `src/` + `test/` are cycle.ts and the
barrel itself; it stayed in cycle.ts (the barrel re-exports it by reference, so it could
not move anyway — A1's trap shape). The reason no test mutates it is structural: the
function's own `_deps` parameter (callOp/now/logger/declineBacking) is the seam the six
mirror suites actually use, so the module-level object is a fallback, never the entry
point. (2) NO source-text tests pin cycle.ts — grep found comments only
(`_cycle-fixtures.ts` header, `classify-outcome.test.ts` AC8). The refactor commit
edited zero tests. (3) Per-file guard allow-lists: only `check-no-silent-naxconfig-cast`
keeps one, and cycle.ts has no `as NaxConfig` casts (its `ops.callOp as unknown as
CallOpFn` is not tracked) — A7's surprise did not recur. (4) The dynamic
`await import("@/operations")` (line 86 of the original) exists to keep a static
`@/operations` edge out of this module — the import-cycles drain depends on it — so it
stayed in the sequencer's prologue and the phases receive the RESOLVED values
(`doCallOp`, `newCallId`, `now`) inside a `CycleFrame`.

**A2's traps, checked first — one shaped the design, one was clean.** No intentional
mid-loop throw crosses an extraction boundary: `dispatchGroup`'s throws propagate out of
`runFixCycle` unchanged (#1948, pinned), and the two try/catches (lite-validate, full
validate) are entirely phase-local — each catch handles its own error and exits within
its own phase. BUT the loop-carried `let`s (`totalCostUsd`, `unresolvedDetail`) are read
by the `finish` closure on every failing exit, and `unresolvedDetail` is SET mid-iteration
(give-up phase) then read on a LATER iteration's exit — exactly the cross-iteration
closure-over-a-`let` shape (SpinFlags' category). So the state was designed mutate-in-place
from the first line, per §9.3: one `CycleLoopState` (`totalCostUsd`, `unresolvedDetail?`,
`declines`) threaded by reference through every phase, never returned as a fresh object;
the original `finish` closure became `finishExit(state, result)` reading
`state.unresolvedDetail` at call time, with its "deliberately NOT applied to the two
resolved exits" rule preserved verbatim (both resolved returns bypass it, pinned by
cycle-retirement's "carries the UNRESOLVED reason onto the later exit" suite).

**No characterisation commit — the mirrors pin every branch.** Verified by name before
trusting them: no-strategy + orphan warn (cycle.test.ts + cycle-retirement "genuine
routing gap"), per-strategy cap + exhaustedStrategy, total cap, bail-when + BOTH #1530
`inheritedIterations` arms (cycle-prior-iterations 296/321), no-dispatch US-003 AC1/AC2/AC5
+ all three boundaries (cycle-no-dispatch), agent-gave-up incl. #1369 cost
(cycle.test.ts), #1654 fall-through all five arms (cycle-retirement 297-407), partial
give-up fall-through-to-validate (cycle-retirement "one strategy gives up" suite),
lite-validate resolved/short-circuit/throw + companion continue + warn fields
(cycle.test.ts AC2-AC13 + #1369 cost tests), validator retry/recovery, BUG-38
full-validate short-circuit, US-006 sibling carry. 249 findings tests green unchanged.

**Technique:** the ~470-line body became a prologue + sequencer plus three siblings cut
at the comment-block seams the original already had. `cycle-loop.ts` (113) holds the
shared vocabulary: `CycleFrame` (cycle/ctx/logger/logCtx/doCallOp/newCallId/now — fixed
for the cycle's lifetime, A3's PlanParams pattern), `CycleLoopState`, `DispatchedIteration`
(group/uncappedActive/findingsBefore/fixesApplied/startedAt — built once by the sequencer
after dispatch, shared by the three post-dispatch phases), `finishExit`, `buildHistory`
(the `priorIterations ? [...] : iterations` concat that appeared twice verbatim).
`cycle-gates.ts` (210) holds everything before the dispatch: `earlyResolvedExit`,
`selectIterationStrategies` (the four gates in the original order, each failing exit its
own named function — `noStrategyExit`/`exhaustedExit`/`totalCapExit`/`bailWhenExit` — so
the selection function itself reads as a guard chain), `firstBailCondition` (the
bailWhen loop). `cycle-execute.ts` (416) holds everything after: `handleGiveUps`
(the #1369/#1384/#1654 block, doc comment moved verbatim), `liteValidateIfExhausted`
(the terminal-exhausted branch incl. its throw arm), `validateRecordAndDecide`
(full validate with retries + classify/record + the resolved/short-circuit terminal
decision). `runFixCycle` itself is now: resolve deps, build frame + state, then the
`for(;;)` reading as eight phase calls with continue/return verdicts
(`GateSelection`/`GiveUpVerdict`/`LiteVerdict`/`TerminalVerdict` discriminated unions).
Phases apply `finishExit` themselves at the exact sites the monolith called `finish`;
the sequencer finishes only the no-dispatch result.

**Helper scores (biome at maxAllowedComplexity=1, so every function is visible):**
`runFixCycle` 20 — exactly AT the strict limit, compliant per §2.3 (third time: A6's
`sendWithParseRetry`, A8's `runRefPathFields`); the residual is the loop's own
continue/return control flow plus the prologue's `??` override chains, which cannot move
(`_cycleDeps` must stay in cycle.ts for the barrel). `validateRecordAndDecide` 10,
`liteValidateIfExhausted` 8, `handleGiveUps` 6, `selectIterationStrategies` 4,
`firstBailCondition` 4, `earlyResolvedExit`/`bailWhenExit`/`buildHistory` 2,
`noStrategyExit`/`exhaustedExit`/`totalCapExit`/`finishExit`/`normalizeValidateResult` 1.
No baseline hand-edit (§2.3 never triggered) — `check:complexity` reported only
"improved" for cycle.ts, and `check:complexity:update` was a pure lower: 246 -> 245
functions, 214 -> 213 files (`cycle.ts` left the over-20 baseline entirely — every
function in all four files scores <= 20).

**File-size gate, three siblings planned from the first line and no overrun:**
`cycle.ts` 543 -> 149 (doc said 544; one line of drift, same as A7-A9). Siblings
measured AFTER `bun x biome check --write`: 113 + 210 + 416. The difference vs
A1/A3/A4/A5's unplanned second files: the three-way cut was chosen up front
(gates / shared vocabulary / post-dispatch), each file holding one phase band.
One biome nit fixed in passing: an unused `Logger` type import in cycle-execute.ts
(the phases get the logger from `frame`, not the parameter list).

**Verification beyond the suite:** a literal fingerprint diff of the original file
against the four new files — all 100 string literals of length >= 4 (exit reasons, log
messages, log field keys) appear verbatim, zero missing. The one intentional
textual relocation: the validator-error log spelled `{ storyId, packageDir, cycleName }`
as outer locals in the original and reads them off `logCtx` now — same keys, same
order, same values. `recordIteration` calls pass `logCtx` where the monolith built a
fresh `{ storyId, packageDir, cycleName }` literal — identical shape, and `logCtx` is
never mutated.

**Nothing else surprising.** `bun run typecheck`, `bun run test` (all phases; 249
findings tests green unchanged), `bun run check:all` (35 scripts; import-cycles 0 —
no sibling imports cycle.ts, and the only cross-sibling edges are leaves importing
`cycle-loop.ts`; file-sizes green; looseCast 1474), and `bun run test:coverage` all
green; below-floor count 1 vs baseline 2 (the standing A5 improvement, not lowered
here).

**For the next batch:** A11 `runNonBlockingFix` (`src/execution/non-blocking-fix.ts:230`,
70, 492 lines, test: yes) — another Wave-A orchestrator, one file further from the
600-line cap than A10 was. Pre-flight per this batch: (1) the mutate-in-place and
closure-over-`let` checks FIRST (A2's traps; A10's `finish`-closure-reads-loop-state
shape is the thing to look for — any exit-decoration helper reading a `let` the loop
mutates means a `CycleLoopState`-style state object); (2) `_deps`-style seam +
barrel re-export check (`grep -rn "_deps\|Deps" src/execution/non-blocking-fix.ts`
and the `src/execution` barrels); (3) grep test/ for source-text assertions on the
file (A10 again found none — every batch since A1 has; the check costs one grep);
(4) A10 confirms the characterisation-first work in Wave A is zero — every remaining
Wave-A row has mirror tests that pin their branches. Post-drain note: over-60 is down
to 18 (17 src + 1 scripts), Wave A has three rows left (A11-A13).

### 9.12 - 2026-09-27, A11 done - `runNonBlockingFix` 70 -> 6 (one session)

The Wave-A orchestrator §9.11 handed over — and, contrary to §9.11's expectation that
characterisation-first work in Wave A was zero, the mirrors left exactly two outputs
unpinned, so the batch DID open with a (small) characterisation commit. One session.
Pre-flight, all answered BEFORE writing code: (1) A2's traps both clean, checked first —
the function has NO loop at all (guard-chain + keep-gauntlet, not a state machine), the
one try/catch whose catch reads working state (`runRectify` → `exhausted = true`) is
entirely prologue-local and rethrows nothing, no closure captures a `let` (no SpinFlags
shape), and the in-place restore of `args.phaseOutputs`/`args.phaseCosts` (the A2-class
shared-mutable state) crosses the extraction boundary as object references inside the
frame, so mutate-in-place held without special machinery; (2) the `_deps` seam question
resolved "the seam is the PARAMETER": `runNonBlockingFix(args, overrides)` merges
`{ ...DEFAULT_DEPS, ...overrides }` into a local at entry — no module-level mutable
object for THIS function, so nothing can cycle. The `_nonBlockingFixDeps` object that
looks like the seam is `nbf-source-diff.ts`'s (spawn/resolveTestFilePatterns for the
git helpers), re-exported through non-blocking-fix.ts line 96-102 and mutated by two
test files — that module and its re-export were untouched, and the re-export MUST stay
(`nbf-keep-gate.test.ts` imports it from `@/execution/non-blocking-fix`). The barrel
(`src/execution/index.ts`) re-exports only `runNonBlockingFix` by value. (3) NO
source-text tests pin the file — grep found none (fifth batch in a row). (4) File
measured 491 lines going in (doc said 492 — one line of drift, sixth batch running).

**Characterisation first anyway** (own commit `test: characterise runNonBlockingFix
unpinned log payloads before complexity drain`, 3 tests, green against the unrefactored
function). The eight mirror suites pin nearly everything — but two LOG outputs had no
assertion: the rejection log's `acIndex`/`file` fields on a contradiction verdict (the
AC9 boundary test passes a verdict WITH `acIndex` but asserts only `kind`/`cause`, and
no test verdict ever sets `file`, so that branch never even executed with a defined
value), and the keep log's payload ("best-effort fix kept" — unasserted anywhere; the
blocked-worktree WARN message likewise). Pinned in a new sibling,
`non-blocking-fix-log-data.test.ts` (157 lines — the main mirror is at 765, too tight
for additions). Zero `as T` casts: `withInfoSpy`'s `mock.calls` tuples carry the real
`Logger["warn"]` parameters, so `call?.[2]` is already
`Record<string, unknown> | undefined` and the scoped-review tests'
`as unknown as` dance is unnecessary in new files.

**Technique:** the guard-chain + keep-gauntlet shape split into a sequencer plus ONE
new sibling, `non-blocking-fix-phases.ts` (358 lines) — no second file needed, because
~130 lines of the source moved only as comments/types while the monolith's two private
helpers (`restoreToSnapshot`, `logGateRegression`) moved wholesale. `NbfFrame` (A3's
PlanParams pattern) holds what is fixed after the rollback point exists: `args`, `deps`
(the entry-merged `{ ...DEFAULT_DEPS, ...overrides }`), `logger`, `restoreRef`,
both snapshots, `flakeTriage`. `beginNbfPass` (snapshots → capture try/catch →
flakeTriage → rectify try/catch) returns a `BeginPassOutcome` discriminated union —
`not-ran` / `exhausted` / `pass`, each carrying the frame where one exists;
`resolveKeepGates` runs the gauntlet (gate regression → `enforceSourceDiffCap` →
`reviewKeptPass`, each gate logging its own verdict and restoring through the shared
`restoreToSnapshot(frame)`, falling through as `null` to keep); `finishExhausted` is
the #1382-parity tail. `reviewRejectionData` factors the verdict-data literal out of
the rejection log call. Every long comment moved verbatim with its code. The
sequencer's residual reads as: two entry guards, one prologue dispatch, keep/restore
branch, commit + keep log.

**Helper scores (biome at maxAllowedComplexity=1):** `reviewRejectionData` 11 (the
nested fail/cause/acIndex/file construction — nesting increments, not branch count),
`enforceSourceDiffCap` 9, `beginNbfPass` 8, `runNonBlockingFix` 6,
`actionableAdvisoryFindings` 6 (untouched), `reviewKeptPass` 5,
`nonBlockingExtraPhases` 3 (untouched), `restoreToSnapshot` 3, `resolveKeepGates` 2,
`logGateRegression`/`finishExhausted` 1. Everything ≤ 20 — no baseline hand-edit
(§2.3 never triggered; sixth batch running). `restoreToSnapshot`'s signature also
collapsed from 6 positional params to 1 (the frame) — a §3 parameter-rule violation
the monolith carried since before the drain, fixed for free by the move.

**File-size gate, single sibling held:** `non-blocking-fix.ts` 491 -> 261 (strictly
smaller, well clear of the cap going in, so unlike A1/A3/A4/A5 nothing forced a
split); the sibling landed at 358 after `bun x biome check --write`. No
per-file guard allow-list names the file (the A7 `check-no-silent-naxconfig-cast`
sweep came back clean — the file has no `as NaxConfig` casts).

**Verification beyond the suite:** a literal fingerprint diff of the original file
against the pair — all 58 double-quoted string literals of length >= 4 (log messages,
log field keys, phase kinds) appear verbatim, zero missing. (One tooling note for the
next batch: extracting string literals from a file full of apostrophe-bearing comments
with a naive regex yields bogus "missing" entries — quote-class must match the file's
actual literal style, here all double-quoted.) The only textual deltas are comments.

**Nothing else surprising.** `bun run typecheck`, `bun run test` (all phases; 137
tests across the ten nbf suites, 134 pre-existing + 3 characterisation),
`bun run check:all` (35 scripts; import-cycles 0 — the sibling imports
non-blocking-fix.ts TYPE-ONLY, the runtime edge is sequencer → phases only;
file-sizes green; looseCast 1474, zero new casts), and `bun run test:coverage` all
green; below-floor count 1 vs baseline 2 (the standing A5 improvement, not lowered
here). `check:complexity:update` was a pure lower: 245 -> 244 functions,
213 -> 212 files (`non-blocking-fix.ts` left the over-20 baseline entirely — every
function in both files scores ≤ 20).

**For the next batch:** A12 `collectNeighbors`
(`src/context/engine/providers/code-neighbor.ts:264`, 73, 498 lines, test: yes) — the
first batch outside `src/execution/`+`src/findings/` since A8, a context-provider in
`src/context/`. Pre-flight per this batch: (1) the usual trap sweep FIRST —
mutate-in-place/closure-over-`let` (A2), `_deps`-style seam + whether
`src/context/index.ts` or a barrel re-exports anything mutable (A1), source-text
tests (none found five batches running, but the grep costs one command); (2) check
for per-file guard allow-lists naming the file (`grep -Rn "grep -vE" scripts/` — A7's
surprise generalises to any file move); (3) 498 lines + extraction means plan the
sibling split from the first line (A6's one-file-per-branch seam); (4) the mirrors
pin most branches, but A11 proves "test: yes" is not "nothing to characterise" —
audit the log payloads and data-literal construction specifically, which is where
both A3 (failedPhases) and A11 (acIndex/file) found their unpinned output. Post-drain
note: over-60 is down to 17 (16 src + 1 scripts); Wave A has two rows left
(A12, A13); `nbf-source-diff.ts`'s `createMeasureSourceDiff` inner closure scores 29
— within reach of the 40-milestone discussion, out of this drain's scope.

### 9.13 - 2026-09-27, A12 done - `collectNeighbors` 73 -> 4 (one session)

The first batch outside `src/execution/`+`src/findings/` since A8, and the shape turned
out to be the A3/A9 linear multi-stage family (forward deps -> reverse deps -> slot
merge -> sibling hint), NOT the `while(true)` state machine A1/A2 were. One session,
including a small characterisation commit — §9.12's warning that "test: yes" is not
"nothing to characterise" held, but only barely: the three code-neighbor* mirrors pin
almost everything. Pre-flight, all answered BEFORE writing code: (1) A2's traps both
clean — the function has NO try/catch at all (nothing throws across any boundary) and
no closure captures a `let` (the one closure, the `candidates.find((c, i) => ...)`
predicate, captures nothing mutable). One subtlety shaped the reverse phase instead:
`anyTruncated` is recorded only for scanned dirs VISITED before the labeled
`break outer`, so it could NOT be replaced by a `scannedDirs.some(...)` after the
loop — the phase returns `{ neighbors, anyTruncated }` with the flag set at the same
position inside the loop. (2) The `_deps` seam exists AND is barrel re-exported
(`src/context/engine/index.ts:65` re-exports `_codeNeighborDeps` — A1's trap shape,
first time since A9). Resolved stronger than the type-only back-import A5/A9 used:
the sibling imports NOTHING from code-neighbor.ts at all — the deps arrive BY
REFERENCE on every phase input (`deps: _codeNeighborDeps` at each call, properties
read at call time so test reassignments land) and are typed by a structural
`PhaseDeps extends ReadCachedDeps` defined in the sibling, so the cycle question
never even arises. (3) No source-text tests pin the file (sixth batch running). (4)
No per-file guard allow-list names the file (`grep -Rn "grep -vE" scripts/` — A7's
sweep, clean here). (5) File measured 498 going in (the doc's number, no drift for
once — first batch where §4's count was exact).

**Characterisation first** (own commit `test: characterise collectNeighbors unpinned
branches before complexity drain`, 5 tests, green against the unrefactored function,
in a new sibling `code-neighbor-collect-edges.test.ts` — the main mirror sits at 745,
too tight for additions; zero `as T` casts, looseCast stayed 1474). The mirror audit
found MORE pinned than expected — the forward self-import guard is ALREADY discriminated
by the "self-reference" test's second half (`src/a.ts` importing `"./a"`), which cut a
sixth candidate test. What nothing pinned: (a) a forward import resolving OUTSIDE the
workdir (`resolveImport` -> null -> continue), with a normal sibling import still
landing; (b) a missing own file collecting no forward deps even when readFile has
content behind the mock (the mirrors' setupDeps returns "" for missing files, so their
"regardless of disk existence" test cannot catch the `fileExists` guard being dropped);
(c) an oversized own file (`readCached` -> null — the mirror's oversized test asserts
read/stat counts, and its readFile returns ""); (d) the includes() quick-check quirk:
a directory import (`"."`) whose content never spells the base name is NOT discovered
as a reverse dep; (e) the AC5 exact-match arm — a scanned file spelled exactly as the
package's relative path survives the `startsWith(packagePrefix)` filter that drops
everything else outside it. (d) and (e) are recorded quirks, pinned as-is per §2.1;
both are now named in the sequencer's doc comment. One test-design lesson from (e)'s
first run: my fileExists mock made the colocated test candidate "exist", so #526
first-existing-wins correctly picked it over the mirrored hint I meant to assert —
a mirrored-fallback test must make the colocated candidates absent too.

**Technique:** the ~120-line body became a sequencer plus four phases in a new sibling,
`code-neighbor-phases.ts` (307 lines): `collectForwardNeighbors` (the own-file
import parse), `collectReverseNeighbors` (the labeled nested loop; its two extracted
predicates `isOutsidePackageScope` and `importsOwnPath` keep the loop reading flat —
the original's nested `if (content?.includes(...)) { for ... }` became a short-circuit
`&&`, so candidates lacking the base name are still never parsed), `mergeNeighborSlots`
(the #1611 min-reverse-slots merge, comment moved verbatim), and
`resolveSiblingTestHint` (the ADR-009 selection order, comment moved verbatim).
`parseImportSpecifiers`, `resolveImport`, `packageScopeRelative`, `MAX_NEIGHBORS_PER_FILE`,
and the `ScannedDir` interface moved wholesale (single-consumer private symbols, A8's
moved-helper pattern). `collectNeighbors` stays in code-neighbor.ts as the sequencer
(public surface unchanged) and scores 4; the #1611/#526/nax#2074 comment blocks moved
with their code. Bonus §3-rule fix for free (A11's precedent): the original's
7-positional-parameter signature collapsed to one `CollectNeighborsInput` options
object, so the fetch call site now reads as named fields.

**Helper scores (biome probe at maxAllowedComplexity=1, the gate's own meter):**
`collectReverseNeighbors` 19 — the largest, one coherent labeled nested loop, not a
fake-split candidate (compliant per §2.3, fourth batch at-or-near the line: A6's
`sendWithParseRetry` and A8's `runRefPathFields` and A10's `runFixCycle` all landed
20); `collectForwardNeighbors` 15, `resolveSiblingTestHint` 10, `parseImportSpecifiers`
9, `importsOwnPath` 6, `mergeNeighborSlots` 6, `collectNeighbors` 4,
`packageScopeRelative` 4, `resolveImport` 3, `isOutsidePackageScope` 2. No baseline
hand-edit (§2.3 never triggered, seventh batch running) — `check:complexity` reported
only "improved" for code-neighbor.ts, and `check:complexity:update` was a pure lower:
244 -> 243 functions, 212 -> 211 files (`code-neighbor.ts` left the over-20 baseline
entirely; `fetch` was measured at 13 — untouched, under 20).

**File-size gate, single sibling held:** `code-neighbor.ts` 498 -> 375 (strictly
smaller); the sibling landed at 307 after `bun x biome check --write` — under 600
with room, because the extraction moved ~100 lines of pre-existing helpers rather
than rehousing the whole function body (A8's observation, second occurrence). The
"budget two sibling files" rule never came close to firing.

**Verification beyond the suite:** a literal fingerprint diff of the original file
against the pair — all 69 quoted string literals of length >= 4 appear verbatim (or
with template `${...}` placeholders stripped for the two `${base}`-style template
literals), zero missing. The only non-literal textual delta is the nested-if ->
short-circuit `&&` in the reverse loop noted above, whose evaluation order is
provably identical.

**One tooling note for the next batch:** measuring helper scores needs a probe config
(`maxAllowedComplexity: 1`) — writing it to /tmp BREAKS plugin loading (biome resolves
plugin paths relative to the config file's directory); put `biome.probe.json` in the
repo root and delete it after.

**Nothing else surprising.** 1273 context-engine tests green (67 files, incl. the 5
new characterisation tests and the three mirror suites unchanged), `bun run typecheck`,
`bun run test` (all phases), `bun run check:all` (35 scripts; import-cycles 0, file-
sizes green, looseCast 1474), and `bun run test:coverage` all green; below-floor count
1 vs baseline 2 (the standing A5 improvement, not lowered here).

**For the next batch:** A13 `callTool` (`src/tools/runtime.ts:318`, 99, 557 lines,
test: yes) — the LAST Wave A row, and the worst score left in `src/` after
`parser.ts` (155, B3) and `validate.ts` (110, C1). Pre-flight per this batch: (1) the
usual trap sweep — `src/tools/` is A8 territory, so check for a `_deps`-style seam
re-exported through `src/tools/index.ts` (policy.ts had none, but runtime.ts is the
dispatcher the barrel exists for); (2) A2's mutate-in-place/closure checks FIRST —
a tool dispatcher is exactly where result-mutation across an extraction boundary
lives; (3) grep test/ for source-text assertions on runtime.ts; (4) 557 lines means
the sibling split is planned from the first line (A6's one-file-per-branch seam);
(5) expect zero characterisation work per §9.10's rule of thumb, but audit log
payloads and data-literal construction specifically (A3/A11/A12's hunting ground).
Post-drain note: over-60 is down to 16 (15 src + 1 scripts); after A13, Wave A is
done and the worst remaining function outside scripts/ is B3's `parseAcpxJsonLine`
(155).

### 9.14 - 2026-09-27, A13 done - `callTool` 99 -> 7 (one session) - Wave A complete

The last Wave A row, and the first batch whose target is a method on a returned
object literal (`callTool` is one of two closures `createCodingToolRuntime`
returns, nested three deep in the factory). The 99 was mostly NESTING INCREMENTS:
the probe at `maxAllowedComplexity: 1` attributed the file's scores per function
node (`callTool` 99, `log` 40, `runTool` 24, `logCall` 7 - the nested bodies
measure separately), but every branch inside `callTool` sat three nesting levels
down, so each conditional spread and ternary cost 3-4 points. Moving the branch
bodies into FREE functions collapses the nesting, which is why the residual is 7.
One session, including a 7-test characterisation commit - §9.13's warning held
again: "test: yes" was not "nothing to characterise".

**Pre-flight, all answered BEFORE writing code:** (1) the `_deps` seam exists AND
is barrel re-exported - `_codingToolDeps` (`{ getLogger }`, runtime.ts:69,
re-exported by `src/tools/index.ts:41`) is reassigned by FIVE test files through
`@/tools` (runtime.test.ts, both command-shadow files, coding-tool-support.test.ts,
build-hop-callback-diff-access.test.ts). It stayed in runtime.ts; the sibling
imports NOTHING from it at runtime - the closure-bound collaborators (`logCall`,
`runTool`) arrive BY REFERENCE as helper parameters and runtime.ts imports the
sibling's four functions (A5/A6/A12 by-reference pattern; `check:import-cycles`
0). (2) A2's traps all clean, checked first: `callTool` has NO loop; the factory's
one cross-call `let` (`advertisedNames`, written by `advertised()`) is only READ
by the deny branch, and the helper receives it as a value at helper-CALL time -
exactly the original read point, so test-set advertised sets still land. No
closure captures a `let` across an extraction boundary (`logCall`/`runTool` stay
closures and are passed by reference); no throw crosses a boundary (runTool's
try/catch is self-contained; an ask-resolver rejection is caught INSIDE
`resolveAskOutcome` and returned as an error outcome, never propagated). (3) NO
source-text tests pin runtime.ts - the five grep hits are all comments (seventh
batch running). (4) No per-file guard allow-list names tools/runtime.ts (A7's
sweep, clean here). (5) File measured 556 going in (doc said 557 - one line of
drift, seventh batch running).

**Characterisation first** (own commit `test: characterise callTool unpinned
branches before complexity drain`, 7 tests, green against the unrefactored
function, new file `runtime-calltool-edges.test.ts` - the main mirror sits at
744, too tight for additions; zero `as T` casts, looseCast stayed 1474). The six
runtime* mirrors pin nearly everything (outcomes, log levels, ask-cancel
AC1/AC11/AC12, tap settle contract, sandbox rows, AC15 signals). What nothing
pinned: (a) the ask REQUEST's `command` field - the `typeof
input[commandField] === "string"` arm and its not-a-string/not-declared inverse
(approval-audit tests exercise the interaction path, never `callTool`); (b) the
`unshowable` propagation from askSummary into the request (raw command still
forwarded - pinned as-is, the masking is summary-only by design); (c) the deny
branch's redirect SELECTION end-to-end, all three arms (command / argv / verb)
plus the `-- ` join onto the policy reason - sandbox-wiring deliberately asserts
only `toStartWith`; (d) the containment-breach WARN record
(`stage: "tools"`, message, tool/reason/root payload) - asserted nowhere. Two
test-design discoveries: (1) "Bash" is NOT a registry builtin - it is assembled
per provider - so the command-field paths needed a `commandField` stub tool via
`extraTools` (the argv paths' RunCommand-stub precedent); (2) the breach warn
calls the module-level `getSafeLogger()` import DIRECTLY, not the
`_codingToolDeps` seam - the only way in is the GLOBAL logger
(`resetLogger`/`initLogger`/`addSink`), the first tools test to need that. The
asymmetry is now pinned behaviour: seam-stubbing `_codingToolDeps.getLogger`
never intercepts the warn.

**Technique:** the ~236-line body became a sequencer plus four free functions in
a new sibling, `src/tools/runtime-calltool.ts` (254 lines): `resolvePolicyIdentity`
2 (the argv/Exec identity computation, comment moved verbatim),
`openCallShadowTap` 11 (the P5 tap construction), `resolveAskOutcome` 15 (the
whole ask branch incl. the resolver try/catch, AC11 aborted recheck and both
approval arms), `resolveDenialOutcome` 12 (breach warn + the command/argv/verb
redirect selection). `callTool` stays in runtime.ts as the sequencer - unknown-tool
guard, identity, `policy.check`, tap, then the two helper calls around the
unchanged `logCall`/`runTool` closures - and scores 7. `log` (40) and `runTool`
(24) are UNTOUCHED: separate baseline entries, same scope as A8 leaving
`argvBranch`/`verbBranch` baselined. The helpers type their verdict parameter as
`Extract<PolicyVerdict, { allowed: false }>` - the original narrowing
(`if (!verdict.allowed)`) does not survive a function boundary, so the denied arm
is the faithful encoding. One near-miss from a careless `sed` hitting all three
`verdict:` params: the TAP helper receives the FULL union (it runs before the
branches) - `tsc` caught it instantly.

**Helper scores (biome probe at maxAllowedComplexity=1, repo-root probe config
per §9.13's tooling note, deleted after):** `resolveAskOutcome` 15,
`resolveDenialOutcome` 12, `openCallShadowTap` 11, `resolvePolicyIdentity` 2;
`callTool` 7; every pre-existing function unchanged (`log` 40, `runTool` 24,
`logCall` 7, `advertised` 8, `record` arrows 8/5). All extracted helpers <= 20 -
no baseline hand-edit (§2.3 never triggered, eighth batch running).
`check:complexity` reported only "improved" for runtime.ts, and
`check:complexity:update` was a pure lower: 243 -> 242 functions, 211 -> 211
files - runtime.ts STAYS baselined at `[40, 24]` because `log` and `runTool` are
still over 20, and the new sibling entered nothing.

**File-size gate, single sibling held:** `runtime.ts` 556 -> 479 (strictly
smaller; the extraction moved only the two branch bodies - `log`/`runTool`/
`logCall`/`shapeToolResult` stay closures in the factory because they bind
`sink`/`opts`/`tap`); the sibling landed at 254 after `bun x biome check
--write` - under 600 with room. The barrel (`src/tools/index.ts`) needed zero
edits: everything it re-exports from runtime.ts is unchanged.

**Verification beyond the suite:** a literal fingerprint diff of the original
callTool body against the pair - all 12 double-quoted literals of length >= 4
appear verbatim, plus all 4 template literals' fixed parts
(`unknown tool "`, the three ` -- ` reason joins incl. `ASK_CANCELLED_REASON`),
zero missing. Every log payload key, error message and ask-request field is 1:1.

**Nothing else surprising.** `bun run typecheck`, `bun run test` (all phases;
1329 tools-directory tests incl. the 7 characterisation tests), `bun run
check:all` (35 scripts; import-cycles 0, file-sizes green, looseCast 1474 - the
two `as` casts moved verbatim with their code), and `bun run test:coverage` all
green; below-floor count 1 vs baseline 2 (the standing A5 improvement, not
lowered here).

**For the next batch:** Wave A is DONE. B1 `decideStageAction`
(`src/execution/post-run.ts:275`, 96, 534 lines) opens Wave B - and it is
`test: NONE`, so §2.2's "find what exercises it" sweep is the first job and the
characterisation commit will be bigger than A11-A13's (A9's 16-test precedent is
the template; its file `post-run.ts` is in `src/execution/`, where A9/A10/A11
all found seams - check `src/execution/index.ts` and any barrel re-exports
BEFORE planning the split). The shape is §3's "policy decision tree" (A7/A8
playbook): guard clauses first, named branch predicates, split conditional
spreads by key class. Then the usual order: A2's mutate-in-place/closure traps,
source-text-test grep, per-file guard allow-list sweep (`grep -Rn "grep -vE"
scripts/`), and budget the sibling split from the first line. Post-drain note:
over-60 is down to 15 (14 src + 1 scripts); worst remaining anywhere is B3's
`parseAcpxJsonLine` (155), and the 40-milestone discussion from §9.8 still
stands.

### 9.15 - 2026-09-27, B1 done - `decideStageAction` 96 -> 10 (one session)

The first Wave B batch, the third "policy decision tree" (§3's row; A7/A8
playbook), and the batch that proved §4's `test` column means only "a mirror
file exists at the heuristic path" - NOT "unexercised". One session.

**§2.2's sweep found real coverage despite `test: none`.** Three suites drive
`decideStageAction` directly (`post-run-decide-action.test.ts`,
`post-run-inspection.test.ts`'s TDD-rollback sections,
`post-run-inspection-exhaustion.test.ts`) plus the oscillation breaker's AC4-AC12
section in `rectification-oscillation-circuit-breaker.test.ts` (which pins the
breaker pause, its reason text, the fail-open arms, and even the notify
send/throw) and `post-run-rollforward.test.ts` (AC12-AC14). What NOTHING pinned,
characterised in the own commit `test: characterise decideStageAction unpinned
branches before complexity drain` (9 tests, green against the unrefactored
function, new file `post-run-decide-action-edges.test.ts`, zero cast
expressions): (a) the recurrence-breaker RETURN wiring - `maybeHandleRecurrenceBreaker`
has direct unit tests and the e2e harness explicitly stops short of
`decideStageAction` (its header says so), so no test proved the sequencer
consults the breaker and returns its verdict; (b) breaker ORDER (oscillation
consulted before recurrence - pinned with a both-trip test); (c) the oscillation
pause notify PAYLOAD (AC11 pins only `type === "notify"`; now also summary/
detail/fallback/featureName derivation); (d) the `&& opts.initialRef` half of
the TDD rollback guard; (e) TDD success skipping `autoCommitIfDirty`; (f) the
`ctx.interaction` and `isTriggerEnabled` halves of the merge-conflict guard;
(g) the `?? "unknown"` human-review pause reason; (h) the `category=` segment of
the generic failure reason (reachable only via a fabricated inspection).

**Pre-flight, all answered BEFORE writing code:** (1) `_postRunDeps` exists AND
is barrel re-exported (`src/execution/index.ts:101`) - A1's trap shape, first
since A9. It stayed defined in post-run.ts; handlers receive it BY REFERENCE on
a `DecideFrame` (`{ ctx, planResult, inspection, opts, deps }`) and read
`deps.X` at call time, so test property reassignments still land. The sibling
imports post-run.ts TYPE-ONLY - including `_postRunDeps` itself, typed as
`typeof _postRunDeps`, so the deps type is zero-maintenance
(`check:import-cycles` stayed 0). (2) A2's traps both clean, checked first: a
guard chain with no loop-carried state across boundaries (`collectFailedPhases`'
loop is self-contained), every try/catch self-contained, no closures over
`let`s. (3) NO source-text tests pin the file - all grep hits are comments
(eighth batch running). (4) No per-file guard allow-list names post-run.ts
(A7's sweep, clean).

**Technique:** named predicates + one handler per branch, in a new sibling
`src/execution/post-run-decide-action.ts` (439 lines). Predicates: `hasRectificationExhaustion`,
`isTddFailure`, `shouldRollbackTddFailure` (moved wholesale - single-consumer
private helper, A8's pattern). Handlers in original branch order:
`routeRectificationExhaustion` (the three exits + TDD-rollback fall-through,
returning `null` to fall through), `selfVerificationEscalation`,
`pauseForReason`, `routeTddFailureBranch` (rollback + human-review +
`routeTddFailure`), `failOnMergeConflict` (guard split into three sequential
guard clauses - detect, interaction, trigger - same short-circuit order),
`escalateFailedSession` (+ `collectFailedPhases`, `buildFailureReason`),
`autoCommitIfNeeded`, `persistRollForward`; shared `cleanupSessionOnFailure`
shim re-created in the sibling (binds `deps.failAndClose` - the impl module
takes the callable as a param precisely to avoid importing post-run.ts).
`decideStageAction` itself stays in post-run.ts as the sequencer - prologue
side-effect write (`ctx.tddFailureCategory`), then the decision table reading
as guard clauses in the original order - and scores 10.

**Helper scores (probe at maxAllowedComplexity=1, repo-root probe config per
§9.13, deleted after):** `routeRectificationExhaustion` 19 (the original
exhaustion block verbatim, one coherent unit, not a fake-split candidate),
`collectFailedPhases` 13, `decideStageAction` 10, `routeTddFailureBranch` 9,
`escalateFailedSession` 6, `oscillationPause` 6, `persistRollForward` 2,
`failOnMergeConflict` 4, `buildFailureReason` 4, everything else <= 1. Untouched:
`applyPostRunInspection` 38, `extractPauseReason` 8. No baseline hand-edit
(§2.3 never triggered, ninth batch running) - `check:complexity:update` was a
pure lower: 242 -> 241 functions, 211 files unchanged (post-run.ts STAYS
baselined at `[38]` for `applyPostRunInspection`, exactly as A8 left argv/verb
and A13 left log/runTool).

**File-size gate, single sibling held:** `post-run.ts` 534 -> 321 (strictly
smaller; both counts after `bun x biome check --write`). The sibling landed at
439 - under 600 with room, because the moved mass is one ~260-line function
body plus ~35 lines of moved helpers, not a whole file's logic. The
"budget two sibling files" rule never came close to firing for a single-function
extraction of this size.

**One TDZ near-miss worth naming:** the first draft factored the sources-set
expression into a module helper named `findingSources` while KEEPING the
original's local `const findingSources = [...].filter(...)` in the handler -
same function scope, so the earlier call site resolves to the local's TDZ and
throws at runtime (tsc flags it as use-before-declaration). Renamed the helper
`collectFindingSources`; the original local became `findingSourceNames` (its
log-field KEY `findingSources` unchanged, so runtime output is identical - the
one textual delta, A6's renamed-variable precedent). Lesson: when factoring an
expression out of a function whose local survives, never give the helper the
local's name.

**One ratchet gotcha NEW to this batch:** the escape-hatch ratchet's looseCast
counter is a TEXT regex (`as` + capitalised word) and it matches COMMENTS -
this batch's first characterisation draft wrote the words "as T casts" in the
new test file's header comment and grew the counter. Reworded the prose.
Rule for every future test file: never spell the cast shape in comments, even
to say you avoided it.

**Verification beyond the suite:** literal fingerprint diff of the original
body (git HEAD, lines of the old function) against the pair - all 37 unique
double-quoted string literals of length >= 4 AND all 14 template literals'
fixed parts appear verbatim, zero missing; every log message, escalation/fail
reason, notify payload field and error code is 1:1. 123 tests across the 11
post-run/recurrence/oscillation suites green (114 pre-existing + 9
characterisation), then the full suite.

**Nothing else surprising.** `bun run typecheck` (both tsconfigs), `bun run
test` (all phases), `bun run check:all` (35 scripts; import-cycles 0,
file-sizes green, looseCast 1474), and `bun run test:coverage` all green;
below-floor count 1 vs baseline 2 (the standing A5 improvement, not lowered
here).

**For the next batch:** B2 `sendTurn` (`src/agents/acp/adapter.ts:239`, 76,
455 lines, test: yes) - first `src/agents/acp/` batch. Pre-flight per this
batch: (1) the acp adapter almost certainly has a `_deps`-style seam - check
`src/agents/acp/index.ts` and any barrel re-exports before planning (A1's
trap); the by-reference-frame pattern above (or A5/A6's) is the known-good
answer; (2) A2's mutate-in-place check FIRST - a turn sender is exactly where
per-turn state an intentional mid-loop throw reads lives; (3) grep test/ for
source-text assertions on adapter.ts; (4) 455 lines + extraction - plan the
sibling split from the first line; (5) audit log payloads and data-literal
construction specifically (A3/A11/B1's hunting ground). Post-drain note:
over-60 is down to 14 (13 src + 1 scripts); worst remaining anywhere is B3's
`parseAcpxJsonLine` (155); the 40-milestone discussion from §9.8 still stands.

### 9.16 - 2026-09-27, B2 done - `sendTurn` 76 -> 1 (one session)

The first `src/agents/acp/` batch and the first `while`-bound turn loop since
A2. One session, including a 5-test characterisation commit - §9.12/§9.13's
warning held a third time: "test: yes" was not "nothing to characterise".

**Pre-flight, all answered BEFORE writing code:** (1) the `_deps` seam
(`_acpAdapterDeps`, defined in `adapter-lifecycle.ts`, re-exported through
adapter.ts AND the `src/agents/acp/index.ts` barrel) is A1's shape but
harmless here: `sendTurn` reads NOTHING off it - its collaborators
(`runSessionPrompt`, `ensureAcpSession`, `warnWallClockTimeout`,
`raceWithAbort`, `buildTurnResult`, `extract*`) are direct value imports from
the `adapter-lifecycle` / `adapter-output` leaves, and the tests' interception
point is `_acpAdapterDeps.createClient` (the client/session objects). The new
sibling imports those leaves DIRECTLY - nothing imports adapter.ts at all, so
the A1 cycle cannot arise (`check:import-cycles` 0). (2) A2's traps both
clean, checked first: no intentional mid-loop throw whose catch reads loop
state (the loop's two try/catches are iteration-local; `runSessionPrompt`
rejections propagate OUT of sendTurn untouched; the SessionTurnError throw
happens AFTER the loop), no closure set up once capturing a `let` (the
setTimeout closures are iteration-local). The handle's `_session` swap is a
PUBLIC mutable field (documented on the class for exactly this recovery), so
the frame carries `impl` by reference and mutate-in-place holds. (3)
Source-text tests: ONE exists - `test/unit/agents/adapter-cleanup.test.ts`
reads adapter.ts raw, but all four assertions are NEGATIVE (`not.toContain`
on Phase-4-removed symbols the refactor never touches), so it stayed green
unmoved - first batch since A1 to find a source-text test, first where
nothing needed repointing. (4) No per-file guard allow-list names the file
(`grep -Rn "grep -vE" scripts/`); `check:adapter-no-config-import` is
unthreatened (the sibling imports nothing config-shaped). (5) File measured
454 going in (doc said 455 - one line of drift, eighth batch running).

**Characterisation first** (own commit `test: characterise sendTurn unpinned
branches before complexity drain`, 5 tests, green against the unrefactored
method, new file `test/unit/agents/acp/adapter-send-turn-edges.test.ts` -
phase-a sat at 752 of the 800 test cap, too tight for additions; zero cast
expressions, looseCast stayed 1474; log asserts use the `initLogger`/
`addSink` pattern from coding-tool-support-dispatch-edges). The ~20 phase-a
tests plus the rate-card suite pin the main flows; what NOTHING pinned:
(a) the loop-top `turnDeadline.expired()` branch - the deadline expiring
BETWEEN iterations (a slow interaction handler consuming the budget), which
is a different arm from `runSessionPrompt`'s in-flight timeout the mirrors
use, plus its `warnWallClockTimeout` call; (b) the "Interaction budget spent"
warn and its payload, together with the DEFAULT `maxInteractions` of 10 (the
exhaustion test passes an explicit 3 and asserts only the round-trip count);
(c) NO_SESSION recovery whose re-establishment itself throws - the warn plus
the documented "fall through to error throw" arm surfacing the dead turn's
stopReason:"error" as SessionTurnError (the existing double-NO_SESSION test
exercises the `sessionRecreated` guard, not the catch); (d) the
externally-cancelled SessionTurnError message variant and the `retryable`
field; (e) the pre-aborted zero-cost row's `pricingSource` (US-002). One
defensive branch is UNREACHABLE through the collaborator contract and was
left untested (noted, not pinned): `if (!lastResponse) break` - `runSessionPrompt`
returns a null response only on its own timeout/abort arms, which break
earlier.

**Technique:** the ~206-line body became a three-call sequencer plus one new
sibling, `src/agents/acp/adapter-send-turn.ts` (364 lines after
`bun x biome check --write`): `buildSendTurnFrame` (impl/mapper/opts/card/
deadline/maxInteractions - A3's PlanParams pattern) + `initialSendTurnState`
+ `zeroCostAbortedResult` + `runTurnLoop`, with the loop phases private to
the sibling: `beginTurnIteration` (deadline check, counter, round-trip,
timeout/abort/null-response arms - returns a break/response verdict),
`recoverNoSession` (the ADR-019 block, comment moved verbatim; returns
"re-queued" to continue), `accumulateUsage`, `awaitInteractionReply` (the
TWO near-identical Promise.race blocks factored into one helper; the two
warn messages are assembled from the same prefix plus a per-call suffix, "
 for context-tool: " vs ": " - runtime-identical), `handleContextToolCall`
(BUG-18 comment verbatim), `handleQuestion` (#1226 exchange capture),
`processResponseInteractions` (the isEndTurn classification),
`maybeWarnBudgetSpent`, `throwIfTurnFailed` (BUG-57 SessionTurnError
construction). `sendTurn` itself is now: cast, frame, pre-abort guard,
`runTurnLoop(frame, initialSendTurnState(prompt))` - and scores 1. The
state object is mutated IN PLACE everywhere (designed that way from the
first line per §9.3); nothing returns a fresh state. `INTERACTION_TIMEOUT_MS`
moved with its only consumers (the constant appears once in the sibling
now); adapter.ts's sendTurn-only imports were pruned (`addTokenUsage`,
`estimateCostUsd`, `createTurnDeadline`, `SessionTurnError`, `TokenUsage`,
`runSessionPrompt`, `warnWallClockTimeout`, the adapter-output four) while
every re-export block (barrel surface) is untouched - the barrel
(`src/agents/acp/index.ts`) needed zero edits.

**Helper scores (probe at maxAllowedComplexity=1, repo-root probe config per
§9.13, deleted after):** `processResponseInteractions` 11 (ternary-verdict
nesting, still one coherent classification), `openSession` 11 (untouched,
pre-existing), `awaitInteractionReply` 7, `runTurnLoop` 7,
`beginTurnIteration` 5, `recoverNoSession` 5, `throwIfTurnFailed` 4,
`accumulateUsage` 3, `handleContextToolCall` 3, `handleQuestion` 2,
`maybeWarnBudgetSpent` 2; `sendTurn` 1; frame/state builders and the
pre-abort literal <= 1. Everything <= 20 - no baseline hand-edit (§2.3 never
triggered, tenth batch running). `check:complexity` reported only "improved"
for adapter.ts, and `check:complexity:update` was a pure lower: 241 -> 240
functions, 211 -> 210 files (`adapter.ts` left the over-20 baseline entirely
- even `openSession` sits at 11).

**File-size gate, single sibling held:** `adapter.ts` 454 -> 252 (strictly
smaller, both counts after `bun x biome check --write`); the sibling landed
at 364 - under 600 with room, because the moved mass is one ~206-line method
plus its comments, and the two iterated interaction races share one helper
instead of being duplicated. The "budget two sibling files" rule never came
close to firing.

**Verification beyond the suite:** literal fingerprint check of the original
body (git HEAD) against the pair - all 27 distinct string/template-literal
fixed parts (log messages, the abort message, stop-reason strings, the
SessionTurnError message variants, state-transition markers) appear
verbatim, zero missing. The two intentional textual deltas, both
runtime-identical: the NO_SESSION guard inverted into an early-return
(`exitCode !== 4 || sessionRecreated` returning false vs
`exitCode === 4 && !sessionRecreated` entering the block - same
short-circuit order), and the two interaction-failure warns now assemble
`failed` + suffix + message from verbatim parts. One tooling repeat of
A11's note: a naive regex literal-scan over a file mixing `"..."` and
backticks yields bogus multi-line "missing" entries - the explicit-literal
check above is the form that works. 412 tests across the 24 acp suites
(incl. the 5 new characterisation tests and the adapter-cleanup source-text
suite) green unchanged, then the full suite.

**Nothing else surprising.** `bun run typecheck` (both tsconfigs), `bun run
test` (all phases), `bun run check:all` (35 scripts; import-cycles 0,
file-sizes green, looseCast 1474, `check:adapter-no-config-import` green),
and `bun run test:coverage` all green; below-floor count 1 vs baseline 2
(the standing A5 improvement, not lowered here).

**For the next batch:** B3 `parseAcpxJsonLine`
(`src/agents/acp/parser.ts:88`, 155 - the worst score anywhere) - §3's
"line/char parser, big if/switch chain" row, the shape that wants a dispatch
map from event type/char class to a handler. Pre-flight per this batch:
(1) parser.ts is a leaf (nothing imports adapter.ts FROM it), but check
whether the acp barrel or spawn-client files re-export anything mutable from
it (A1's trap); (2) A2's traps matter less here (a pure parser should have
no loop-carried mutable state), but check for accumulator arrays mutated
across a labelled-break boundary (A12's `anyTruncated` shape); (3) grep
test/ for source-text assertions on parser.ts; (4) 388 lines means the
extraction MIGHT fit in place, but the moved-handler pattern (A8) is worth
trying first - parser dispatch handlers are usually self-contained; (5) the
mirror suite is parser.test.ts - audit which line/event shapes it pins
before trusting it. Post-drain note:
over-60 is down to 13 (12 src + 1 scripts); after B3 the worst is C1's
`validateConfig` (110); the 40-milestone discussion from §9.8 still stands.

### 9.17 - 2026-09-27, B3 done - `parseAcpxJsonLine` 155 -> 7 (one session)

The worst-scoring function anywhere, and the first "line/char parser, big
if/switch chain" batch - §3's row predicts a dispatch map from event type to a
handler, which is what landed. One session, including a 21-test
characterisation commit - §9.12/§9.13/§9.16's warning held a fourth time:
"test: yes" was not "nothing to characterise".

**Pre-flight, all answered BEFORE writing code:** (1) parser.ts has NO
`_deps`-style seam at all - the acp barrel (`src/agents/acp/index.ts`) re-exports
the four parser functions BY VALUE plus two types, and no test mutates anything
on the module - A1's trap resolved "no" on the first check (like A2). (2) A2's
traps: the accumulator `state` is MUTATED IN PLACE by every branch and that is
the contract, so handlers take `state` and mutate it (never build a fresh one) -
the natural pattern here, designed in from the first line per §9.3. No loops, no
closures over `let`s; the one try/catch is the sequencer's own legacy-text
fallback and stayed in the sequencer. (3) NO source-text tests pin parser.ts -
grep found comments only in `parse-agent-error.test.ts` and
`cost/calculate.test.ts` (ninth batch running). (4) No per-file guard
allow-list names the file (`grep -Rn "grep -vE" scripts/`);
`check:adapter-no-config-import` unthreatened (the sibling imports nothing
config-shaped). (5) File measured 388 going in - the doc's number, exact, second
batch in a row (A12 was the first).

**Characterisation first** (own commit `test: characterise parseAcpxJsonLine
unpinned branches before complexity drain`, 21 tests, new file
`test/unit/agents/acp/parser-line-edges.test.ts`; zero cast expressions,
looseCast stayed 1474). The two mirror suites (parser.test.ts, activity-emission)
plus spawn-client's BUG-1 pin a LOT of this parser. What NOTHING pinned:
(a) the first-JSON-line fallback purge - an unparseable banner stashes itself as
fallback text, and the FIRST valid NDJSON line must drop that stash (only the
stash arm was pinned, never the purge); (b) the catch-guard's third arm - an
unparseable line after JSON has been seen but with text still EMPTY is not
stashed (`!state.text && !state.sawJsonLine`, not merely `!state.text`);
(c) drift-guard `??=` semantics - a drift line never overwrites an error an
earlier line captured - and BOTH drift log payload shapes (method present /
absent; pinned via the `initLogger`/`addSink` global-logger pattern -
`getSafeLogger()` is a module-level read, not a seam); (d) `agent_message_chunk`
with non-text content emits nothing; (e) an unknown `sessionUpdate` value and a
session/update without `params.update` fall through to result/error handling;
(f) the POSITIVE `update.used` fallback - only its Infinity-rejection was pinned
by BUG-12 - including a non-object `_meta` still falling back; (g) snake_case
`stop_reason` capture and the both-spellings precedence (snake wins - it is
assigned second); (h) the JSON-RPC 2.0 error branch's diagnostics: non-string
message stringifies the whole error object, the `[acpxCode/detailCode]`
two-code suffix, first-error-wins with a later `retryable: true` ignored; (i)
legacy STRING error capture and its never-overwrites (`??=`) counterpart; (j)
legacy non-string `result`/`content`/`text` values change nothing; (k) legacy
`stopReason`/`stop_reason` capture; (l) `extractToolName`'s whitespace-only
fall-through to the nested `tool.name`, and the no-usable-name activity with
`toolName: undefined`.

**Technique:** sequencer + dispatch map, in a new sibling
`src/agents/acp/parser-line-handlers.ts` (340 lines after `bun x biome check
--write`). `parseAcpxJsonLine` stays in parser.ts as the sequencer - parse,
sawJsonLine purge, `isProtocolDrift`/`reportProtocolDrift`, then
`event.jsonrpc === "2.0" ? handleJsonRpcEvent : handleLegacyLine` with the
legacy-text catch fallback inline - and scores 7. The sibling holds: the
drift-guard pair (BUG-53 comment moved verbatim); `handleJsonRpcEvent`
(session/update guard, then the result+error appliers - the original's
SEQUENTIAL-not-else-if structure preserved: an unrecognized update still falls
through to result/error handling); a `Record` dispatch map on
`update.sessionUpdate` (`agent_message_chunk` / `agent_thought_chunk` /
`usage_update` / `tool_call`+`tool_call_update` sharing one handler);
`handleLegacyLine` plus one applier per field group (the result/content/text
else-if chain with its mutual-exclusion comment, cumulative usage BUG-10,
usage BUG-59/BUG-54, stop reason, error); `decorateAcpxError` - the
suffix/retryable `data` block that was byte-identical between the two error
branches (P0's "shared helper worth naming" pattern); `asFiniteNumber` and
`extractToolName` moved wholesale (single-consumer private helpers, A8's
pattern).

**One design note worth naming: dispatch maps on UNTRUSTED wire data need an
own-property guard.** `SESSION_UPDATE_HANDLERS[update.sessionUpdate]` on a plain
object literal returns inherited `Object.prototype` members for wire keys like
`"constructor"` or `"toString"` - the pre-split if-chain returned undefined for
those, so the naive map would have ADDED a hazard (calling
`Object.prototype.toString` as a handler). `handleSessionUpdate` guards with
`typeof key !== "string"` plus `Object.hasOwn(...)` (the repo's established
dispatch-table pattern). A dispatch map over external input is not a mechanical
table transplant - check the lookup the way you would check any index.

**Typing:** `type ParsedJson = ReturnType<typeof JSON.parse>` - the honest type
for untrusted, arbitrarily shaped wire data. Every access stays a
runtime-guarded dynamic read exactly as before the split, and ZERO new `as`
casts were needed: the existing casts moved verbatim with their code (looseCast
stayed 1474). A structural event interface would have pushed those guards into
new casts without making anything safer.

**Helper scores (probe at maxAllowedComplexity=1, repo-root probe config per
§9.13, deleted after; note the flag is `--config-path=`, biome 2.5.10 rejects
`--config`):** `handleUsageUpdate` 16 (largest - one coherent usage-record
assembly, not a fake-split candidate), `applyJsonRpcResult` 15 (the BUG-54
block verbatim), `parseAcpxJsonLine` 7, `decorateAcpxError` 7,
`extractToolName` 7, `applyLegacyCumulativeUsage` 7, `applyJsonRpcError` 6,
`handleLegacyLine` 6, `asFiniteNumber` 4, `isProtocolDrift` 4,
`handleJsonRpcEvent` 4, `applyLegacyUsage` 3, `parseAcpxJsonOutput` 3,
`applyLegacyError` 3, `handleAgentMessageChunk`/`handleAgentThoughtChunk`/
`applyLegacyStopReason`/`handleSessionUpdate` 2. All <= 20 - no baseline
hand-edit (§2.3 never triggered, eleventh batch running). `check:complexity`
reported only "improved" for parser.ts, and `check:complexity:update` was a
pure lower: 240 -> 239 functions, 210 -> 209 files (parser.ts left the over-20
baseline entirely - every function in both files scores <= 16).

**File-size gate, single sibling held:** parser.ts 388 -> 158 (strictly
smaller); the sibling landed at 340 - under 600 with room, because ~30 lines
moved as whole private helpers and the handlers are individually small (the
A8 moved-helper observation paid off exactly as §9.16 predicted it might for a
parser). One lint catch worth knowing: `noParameterAssign` fired on
`decorateAcpxError`'s `errorMsg` - reassigning it was fine as a local `let`
inside the monolith but not as a parameter; fixed with an internal `let msg`,
semantics identical.

**Verification beyond the suite:** a literal fingerprint diff of the original
file (git show of the pre-refactor commit) against the pair - 19 double-quoted
literals of length >= 4: 16 verbatim plus 3 that now serve as the dispatch
map's (unquoted) property keys, runtime-identical; all 7 template-literal
fixed parts verbatim; zero missing. Every log message, error message, suffix
join, and state-transition string is 1:1. 429 acp unit tests green across the
24 suites (incl. the 21 new characterisation tests), then the full suite.

**Nothing else surprising.** `bun run typecheck` (both tsconfigs), `bun run
test` (all phases), `bun run check:all` (35 scripts; import-cycles 0 - the
sibling imports parser.ts TYPE-ONLY, the A5/A9 pattern; file-sizes green;
looseCast 1474; `check:adapter-no-config-import` green), and `bun run
test:coverage` all green; below-floor count 1 vs baseline 2 (the standing A5
improvement, not lowered here).

**For the next batch:** B4 `runDeferredRegression`
(`src/execution/lifecycle/run-regression.ts:205`, 73, 587 lines, test: yes) -
back in `src/execution/lifecycle/`, where A9 found `_runCompletionDeps`
barrel-re-exported through `src/execution/lifecycle/index.ts` (A1's trap
shape). Pre-flight per this batch: (1) grep for a `_deps`-style seam in
run-regression.ts and check BOTH barrels before planning; (2) A2's traps
first - a deferred regression runner is exactly where an intentional mid-loop
throw whose catch reads loop state lives (A10's `finish`-closure shape); (3)
grep test/ for source-text assertions on the file; (4) 587 lines is 13 under
the cap going in - the extraction CANNOT land in place, and the sibling split
is planned from the first line (A9's gate/post-gate cut is the nearest
template; A10's three-file cut if the first sibling overruns 600); (5) audit
log payloads and data-literal construction specifically (A3/A11/B1's hunting
ground). Post-drain note: over-60 is down to 12 (11 src + 1 scripts); worst
is now C1's `validateConfig` (110); after B4-B7 the 40-milestone discussion
from §9.8 still stands.

### 9.18 - 2026-09-27, B4 done - `runDeferredRegression` 73 -> 5 (one session)

The first Wave-B orchestrator/gate batch, back in `src/execution/lifecycle/`.
One session, including an 8-test characterisation commit - the "test: yes is
not nothing to characterise" warning held for the FIFTH time running (A11,
A12, B1, B2, B3, now B4).

**Pre-flight, all answered BEFORE writing code:** (1) `_regressionDeps` (6
members) is defined in run-regression.ts AND re-exported through BOTH barrels
(`src/execution/lifecycle/index.ts:35` and `src/execution/index.ts:66`) - A1's
trap shape, and FIVE test files reassign its properties. It stayed defined in
run-regression.ts; the sibling imports it TYPE-ONLY (`typeof _regressionDeps`)
and the frame carries the object BY REFERENCE, every `deps.X` read at call
time, so test stubs assigned before the gate runs still land (`check:import-cycles`
0 - the triage sibling already imports `DeferredRegressionResult` type-only,
same pattern). (2) A2's traps, checked first: one shaped the design - the Step-4
confirmation result reads the loop's accumulators (`rectificationAttempts`,
cost/duration/outcome records) AFTER the loop, so `RectificationState` was
designed mutate-in-place from the first line per §9.3, never rebuilt. The
intentional throw (`runFixCycle` rejection) propagates OUT of the whole gate
after the `finally`'s `dispatchAsk.dispose()` - pinned by the dispatch-ask
suite's "disposed even when the fix cycle throws" - and nothing catches it
locally, so no state is read across a throw boundary. No closure captures a
`let` (the validate closure captures per-story consts). (3) NO source-text
tests read run-regression.ts raw - but see the NEW gate shape below, which is
the source-text trap wearing a different coat. (4) File measured 586 going in
(the doc's 587 - one line of drift, ninth batch running). (5) No per-file
guard allow-list names the file.

**A NEW guard shape for the file-move checklist (A7's allow-list surprise,
recurred as a test-pinned construction site):** `check-bash-dispatch-ask`'s
own test ("the real tree") pins `src/execution/lifecycle/run-regression.ts`
as containing a WIRED `CallContext` construction - the `cycleCtx` literal
(`runtime`+`packageView`+`agentName` naming `askResolver`+`commandShadow`, the
#2201 fix). Moving the rectification loop wholesale would have emptied that
file of wired sites and failed `check:all` AFTER everything else was green.
Resolution WITHOUT touching the guard or its test: the `buildStoryCycle`
factory (dispatchAsk build + the wired `cycleCtx` literal + the cycle with
its validate closure) STAYS in run-regression.ts as a closure capturing the
prologue consts, and the sibling's loop receives it BY REFERENCE as
`frame.buildStoryCycle(story, initialFindings)`. The construction site stays
next to `makeFullSuiteRectifyStrategy` - the guard's stated intent - and zero
test edits were needed. Generalised rule for the checklist: `grep -rn
"<file>" test/unit/scripts/` alongside the `grep -Rn "grep -vE" scripts/`
sweep - guards can pin a file through their TESTS, not just their allow-lists.

**Characterisation first** (own commit `test: characterise runDeferredRegression
unpinned branches before complexity drain`, 8 tests, green against the
unrefactored function; lifecycle-execution.test.ts had headroom (368 of 800),
so they joined the existing gate suite rather than a new file - zero cast
expressions, looseCast stayed 1474). The four regression mirrors pin nearly
everything. What NOTHING pinned: (a) BUG-REG-001's crashed-runner gate
(parser yields 0 pass + 0 fail -> accepted as pass; only the source comment
named it); (b) `regression:detected` event emission - NO test anywhere
subscribes for that event type; (c) the attempts `: 1` arm (a zero-iteration
cycle counts one attempt); (d) the mid-loop TIMEOUT-accept arm (early exit,
passedTests 0); (e) the stale-output arm (an output-less mid re-run leaves
`currentTestOutput` untouched for the next story); (f) the final re-run
TIMEOUT-accept arm; (g) the attribution log-payload pair ("Mapped test to
story via gate transition" fields; "Could not safely map..." with and without
`transitionStoryId` - A11's hunting ground); (h) `findResponsibleStoryByTransition`'s
storyId tie-break at equal `completedAt`. One test-infra lesson NEW to this
batch: `initLogger` THROWS `LOGGER_ALREADY_INITIALIZED` when a previous file
in the same `bun test` process left the global logger up - my log test passed
in isolation and in its own directory run, and failed only in the full
execution-tree run. The established guard is `resetLogger()` BEFORE
`initLogger(...)` (acceptance-red-gate.test.ts:227); a green targeted run
does not surface this class of pollution - run the tree.

**Technique:** sequencer + five phases in ONE sibling,
`src/execution/lifecycle/run-regression-phases.ts` (530 lines after
`bun x biome check --write`): `resolveRegressionSetup` 6 (mode guard, config
resolution incl. the verifyOpts literal verbatim, passed-stories guard, the
"Running deferred..." log - biome's cognitive complexity does not count `??`
default chains, which is why the guard-heavy setup scores 6),
`runInitialSuite` 11 (Step 1 + the four guard exits + triage + shortCircuit),
`attributeAffectedStories` 17 (the mapping loop with its conditional warn
payload, plus the no-stories-mapped exit - largest helper, one coherent unit),
`runRectificationLoop` 14, `runFinalVerification` 5, plus `buildRegressionFindings`
moved with its doc comment and `regressionResult` 8 - a builder for the seven
near-identical result literals (P0's "shared helper worth naming"; the
defaults mirror the monolith's early-exit literals field-for-field, and the
quarantineReport key stays conditionally present). `runDeferredRegression`
itself is now: setup guard, buildStoryCycle closure, frame literal, initial
suite, attribution, the `regression:detected` emit loop, rectification loop,
final verification - and scores 5; `buildStoryCycle` 3, its `validate` closure
6, `findResponsibleStoryByTransition` 3 (untouched).

**One §2.3 breach, fixed with the standard second split:** first pass put the
whole success-branch (re-run suite, `midSuccess` decision, early-exit result,
stale-output update) inside `runRectificationLoop` -> 23. Extracted
`checkEarlyExitAfterSuccess` (frame, state, `{story, outcome}` - 3 positional
params per the repo rule); second pass every function in both files <= 17.
No baseline hand-edit needed.

**File-size gate, single sibling held:** run-regression.ts 586 -> 285
(strictly smaller); the sibling landed at 530 after `bun x biome check
--write` - under 600, because the split was planned from the first line
(A6's lesson, finally costing nothing).

**Verification beyond the suite:** literal fingerprint diff of the original
file (git HEAD) against the pair - all 47 double-quoted literals of length
>= 4 verbatim, all 3 template literals' fixed parts verbatim (`Rectifying
story ${...}`, `Story ${...} rectified successfully`, the synthetic-finding
message), zero missing; the 6 additions are structural only (two import
specifiers, the discriminated-union kind tags, one type-level key). 2385
execution-tree tests green (incl. the 8 characterisation tests), then the
full suite (22134 tests).

**Nothing else surprising.** `bun run typecheck` (both tsconfigs), `bun run
test` (all phases), `bun run check:all` (35 scripts; import-cycles 0,
file-sizes green, looseCast 1474, check-bash-dispatch-ask green), and `bun
run test:coverage` all green; below-floor count 1 vs baseline 2 (the standing
A5 improvement, not lowered here). `check:complexity:update` was a pure
lower: 239 -> 238 functions, 209 -> 208 files (`run-regression.ts` left the
over-20 baseline entirely - every function in both files scores <= 17).

**For the next batch:** B5 `runParallelBatch`
(`src/execution/parallel-batch.ts:122`, 63, 417 lines, test: yes) - the
function A1's dispatch phases call into, so check whether parallel-batch.ts
has its OWN `_deps`-style seam and whether `src/execution/index.ts`
re-exports anything mutable from it (A1's write-up shows tests reassign
`runParallelBatch` itself through `_unifiedExecutorDeps`, which is unaffected
by this file's internals - but verify). Pre-flight per this batch: (1) the
usual seam + barrel sweep; (2) A2's traps first - a parallel batch runner is
exactly where per-story state and mid-loop throws live; (3) `grep -rn
"parallel-batch" test/unit/scripts/` for guard tests pinning the file (B4's
new rule), plus the `grep -Rn "grep -vE" scripts/` allow-list sweep; (4) 417
lines + extraction means plan the sibling split from the first line; (5)
audit log payloads specifically (B1/B4's hunting ground). Post-drain note:
over-60 is down to 11 (10 src + 1 scripts); worst is C1's `validateConfig`
(110); Wave B has three rows left (B5-B7), then the grouped Wave C.

### 9.19 - 2026-09-27, B5 done - `runParallelBatch` 63 -> 0 (one session)

The function A1's dispatch phases call into, and the batch where the
"test: yes is not nothing to characterise" warning held for the SIXTH time -
plus a NEW gate interaction: the per-file coverage floor has an opinion about
extractions that §2.4's file-size gate does not. One session.

**Pre-flight, all answered BEFORE writing code:** (1) `_parallelBatchDeps`
(6 members) is defined in parallel-batch.ts and mutated by FOUR test files
(parallel-batch.test.ts, parallel-batch-structure.test.ts, and the two
integration files) - but NOT through a barrel: `src/execution/index.ts`
re-exports NOTHING from parallel-batch.ts; every test imports
`_parallelBatchDeps` and `runParallelBatch` directly from
`@/execution/parallel-batch`. It stayed defined in parallel-batch.ts; the
sibling imports it TYPE-ONLY (`typeof _parallelBatchDeps`) and every phase
receives it BY REFERENCE on its input, each `deps.X` read at call time
(B4's pattern; `check:import-cycles` 0). The OTHER seam relationship - the
one the batch brief flagged - resolved clean: `_unifiedExecutorDeps
.runParallelBatch` (unified-executor.ts:273) is a closure that
dynamic-imports `./parallel-batch` FRESH PER CALL, so any refactor keeping
`runParallelBatch` exported from parallel-batch.ts is invisible to it; the
unified-executor side was not touched and its four seam suites
(fallback-seam, signature, results, failure) stayed green unmoved. (2) A2's
traps all clean, checked first: the function has ZERO `let` bindings (every
accumulator is a `const` Map/array mutated in place - there is nothing for
the SpinFlags shape to capture), no closure set up once crosses a phase
boundary, and no catch reads state across a throw: every catch is
per-story-contained (worktree-create, dep-prep, config allSettled,
rectification) and pushes into shared accumulators, while the two unwrapped
rejections (executeParallelBatch, mergeAll) propagate out of the whole
function. The BatchFrame was designed mutate-in-place from the first line
per §9.3 - which here cost nothing, since the original already worked by
in-place mutation. (3) Source-text tests: TWO pin parallel-batch.ts raw
(`expect(source).toContain('import("./merge-conflict-rectify")')` - unit
parallel-batch.test.ts AC-9 and integration parallel-batch-rectification
.test.ts AC-9), plus the structure suite's whole-tree scans for the
forbidden old module names. All satisfied with ZERO test edits: the pinned
string lives in `_parallelBatchDeps.rectifyConflictedStory`'s dynamic
import, which stayed put with the seam. (4) No per-file guard allow-list
names the file (`grep -Rn "grep -vE" scripts/` clean; the moved
`loadConfigForWorkdir` call keeps its 3 arguments, so the
profile-threading gate stays green wherever it lands - its test-file hit
at check-config-profile-threading.test.ts:87 is a synthetic fixture, not a
raw read). (5) File measured 417 going in - the doc's number, exact.

**Characterisation first** (own commit `test: characterise runParallelBatch
unpinned branches before complexity drain`, 8 tests, green against the
unrefactored function, new file `test/unit/execution/parallel-batch-edges
.test.ts` - the main mirror sits at 767 of the 800 test cap, too tight for
additions; zero `as` expressions, looseCast stayed 1474). The four mirrors
pin the ACs, US-003 identity rules, BUG-36/36 pipelineContextBase, BUG-37
cost folding, BUG-60 dep-prep timing, and BUG-007 config resilience. What
NOTHING pinned: (a) the ENTIRE non-conflict merge-failure branch
(`failureKind: "error"` -> failed, never mergeConflicts, no rectification
bought) including the `?? "merge failed"` fallback - a whole behavioral
branch, the biggest unpinned find since A11; (b) the worktree-create
failure's synthesized result (stoppedAtStage, context under the batch
workdir) and its near-instant duration - the worktree arm of the BUG-60
timing rule, which only ever pinned the dep-prep arm; (c) the dep-prep
failure's worktree CLEANUP: remove called with the composed identity, a
throwing remove swallowed, the "worktree-dependencies" stage name, and
context.workdir pointing at the removed worktree root; (d) per-story config
THREADING - prepareWorktreeDependencies receives the resolved config by
identity (not the root default) and the worker receives the effective-config
map as its 9th argument, plus the empty-map arm forwarding undefined; (e)
the config-load warn payload; (f) the rectification-throw warn under the odd
"[parallel-batch]" bracketed stage spelling. Noted, not pinned - defensive
arms unreachable through the collaborator contract (B2's precedent): the
config rejection always carries storyId (the enrichment lives in the
in-function mapper), and merge/conflict entries can only name pipelinePassed
ids (which come from `stories`).

**THE new thing - the coverage floor is the file-size gate's twin.** After
the extraction was green everywhere else, `bun run test:coverage` FAILED:
moving the covered phase bodies OUT left parallel-batch.ts dominated by the
four real dep bodies in `_parallelBatchDeps` - which NO test executes,
because every mirror stubs them. The file, previously above the per-file
floor and therefore absent from coverage-per-file-baseline.json, became a
"new" below-floor file (94/122 lines = 77.05% vs floor 80) and failed the
gate - the residual's uncovered FRACTION rose even though uncovered COUNT
was unchanged. Fix, chosen to add real value rather than fudge the
baseline: a "real dep defaults" describe in the edges file executing the
seam's built-in implementations that are provably side-effect-free -
createWorktreeManager/createMergeEngine (pure constructors) and
executeParallelBatch with an EMPTY stories array (verified in
parallel-worker.ts first: the loop never runs, allSettled resolves on an
empty set, the empty result is returned - no git, no agents). The file went
94/122 -> 120/122 (98.4%). rectifyConflictedStory's real body stays
uncovered by design - executing it would start an agent session. Rule for
every future extraction batch: budget a `test:coverage` run BEFORE
committing, and when the source file is seam-heavy, check whether the
residual file is dominated by never-executed dep bodies.

**Technique:** sequencer + eight phases in ONE sibling,
`src/execution/parallel-batch-phases.ts`, cut at the numbered-comment seams
the original already had: `createStoryWorktrees` 9 (BUG-05 containment +
AC-2 start times), `resolveStoryConfigs` 8 (PKG-003 allSettled; its inner
mapper scores 5 separately), `prepareStoryDependencies` 12, `executeReady
Stories` 3 (the empty-batch literal verbatim), `mergePassedStories` 19 (the
three-way merge-result classification - largest helper, one coherent unit,
not a fake-split candidate), `buildFailedList` (pure synthesis),
`rectifyMergeConflicts` 8 (builds and returns storyEndTimes), `finalize
BatchResult` 4 (BUG-37 total + durations). `runParallelBatch` itself is a
straight-line prologue (logger, worktreeManager, BatchFrame literal) plus
eight awaited calls returning the assembled literal - probe at
maxAllowedComplexity=1 gives it 0. All helpers <= 19 - no baseline hand-edit
(§2.3 never triggered, twelfth batch running). `check:complexity` reported
only "improved" for parallel-batch.ts, and `check:complexity:update` was a
pure lower: 238 -> 237 functions, 208 -> 207 files (the file left the
over-20 baseline entirely).

**File-size gate, single sibling held:** parallel-batch.ts 417 -> 235
(strictly smaller; both counts after `bun x biome check --write`); the
sibling landed at 457 - under 600 with room. The "budget two sibling files"
rule never came close to firing: 417 lines was the smallest source going in
of any Wave A/B batch, and the seam (60 lines of dynamic-import closures)
stayed behind in the source.

**Verification beyond the suite:** literal fingerprint diff of the original
file against the pair - all 43 quoted/template literals (template
placeholders stripped) appear verbatim, zero missing; all 5 real
`Date.now()` call sites at identical logical positions (a naive grep
overcounts: the sibling's header COMMENT mentions `Date.now()` in prose -
B1's comment-text lesson, reverse direction); `getSafeLogger()` 2/2; dep
call sites 6/6, every one reading the seam at call time. 2698 execution
-tree tests green (230 files, incl. all five parallel-batch suites and the
four unified-executor seam suites), then the full suite (all phases),
`check:all` (35 scripts; import-cycles 0 - the sibling imports
parallel-batch.ts TYPE-ONLY; file-sizes green; looseCast 1474), and
`test:coverage` green after the real-dep tests (below-floor 1 vs baseline
2 - the standing A5 improvement).

**For the next batch:** B6 `displayFeatureDetails`
(`src/cli/status-features.ts:329`, 66, 503 lines, test: yes) - the first
CLI-action batch since A4, §3's "one function per output section" row.
Pre-flight per this batch: (1) A4's CLI lessons apply in full - `bin/`-style
deps seams are rare in `src/cli/`, but grep for one and check whether any
symbol a moved block calls is shared by other commands (§9.5's rule: such a
symbol moves OUT first, never imported back); (2) grep test/ for source
-text assertions on status-features.ts (console-output tests sometimes pin
raw file text); (3) audit console output payloads specifically - the A3/A11
/B1 log-payload hunting ground translates to printed lines here; (4) the
NEW coverage lesson above - status-features.ts may be display-heavy with
its covered mass concentrated in the target function; run `test:coverage`
before committing and check the residual's floor situation; (5) 503 lines +
extraction: plan the sibling from the first line, but expect one file to
hold. Post-drain note: over-60 is down to 10 (9 src + 1 scripts); worst is
C1's `validateConfig` (110); Wave B has two rows left (B6, B7), then the
grouped Wave C - and the 40-milestone discussion from §9.8 still stands.

### 9.20 - 2026-09-27, B6 done - `displayFeatureDetails` 66 -> 4 (one session)

The first CLI-action batch since A4 and §3's "one function per output
section" row, exactly as the table predicted. One session, including a
13-test characterisation commit - the "test: yes is not nothing to
characterise" warning held for the SEVENTH time running (A11, A12, B1, B2,
B3, B4, B5, now B6): the two suites that drive this function pinned the
postRun flows and the crash headline, and left entire branches unpinned.

**Pre-flight, all answered BEFORE writing code:** (1) `_statusFeaturesDeps`
(`projectOutputDir`/`loadConfig`) EXISTS at the top of status-features.ts
and is property-mutated by all three suites that import the module - but it
is NOT the A1 trap: `displayFeatureDetails` reads NOTHING off it (its
collaborators `loadPRD`/`countStories`/`loadStatusFile`/`isPidAlive` are
direct imports), and no barrel re-exports the seam - `src/cli/status.ts`
re-exports only `displayFeatureStatus` + type `FeatureStatusOptions`, and
`status-dispatch.ts` dynamic-imports `displayFeatureStatus`. The seam was
untouched; the public surface did not change. (2) A2's traps all clean,
checked first: the function has ZERO `let` bindings, no closures, no
try/catch at all, and the one loop (stories table) is self-contained -
nothing mutates across any extraction boundary. (3) NO source-text tests
pin status-features.ts - grep across `test/unit/cli/` AND
`test/unit/scripts/` (B4's rule) found comments only (tenth batch running).
(4) No per-file guard allow-list names the file (`grep -Rn "grep -vE"
scripts/` - only the naxconfig-cast list, which does not). (5) File
measured 502 going in (the doc's 503 - one line of drift, tenth batch
running).

**Characterisation first** (own commit `test: characterise
displayFeatureDetails unpinned branches before complexity drain`, 13 tests,
green against the unrefactored function, new file
`test/unit/cli/status-features-details-edges.test.ts` - the mirror sits at
710 of the 800 test cap, too tight for additions; zero cast expressions,
looseCast stayed 1474; the legacy numeric `failedTests` shape is attached
with Object.assign, the A7 precedent). What NOTHING pinned, one test each:
(a) the no-prd.json guard (plan hint + nothing else); (b) the Progress
section's per-count lines INCLUDING the conditional `Skipped:` line
(skipped-count tests existed nowhere); (c) the story-table icon selection
(pass/failed/skipped/pending arms) and the `[complexity/tier/strategy]`
routing suffix; (d) acceptance running + not-run arms; (e) regression
passed-WITHOUT-skip (green + parens timestamp) and running + not-run arms;
(f) the numeric `failedTests` arm (typed `string[]`, so this is the A7
defensive-branch category - pinned as-is per §2.1, not fixed); (g) the
failedACs count suffix `(2 AC(s))`; (h) the trailing last-run block for a
completed run; (i) the EXPLICIT `status: "crashed"` arm's detail lines (the
existing pin drives running+dead-pid only) plus the absent
crashedAt/crashSignal arms; (j) the active-run section's detail lines. On
(j): the existing "Active Run:" pin is `skipInCI` (FULL=1), so the new test
drives it with `pid: process.pid` WITHOUT the skip - the test process's own
PID is alive in any environment, and `isProcessAlive` fails safe for
non-ESRCH probes, so it runs in CI.

**Technique:** sequencer + seven section printers (one per output section)
in ONE new sibling, `src/cli/status-features-details.ts` (165 lines after
`bun x biome check --write`): `displayNoPrdNotice` 1,
`displayRunStatusSection` 18 (active/crashed/no-status arms),
`displayProgressSection` 2, `displayStoriesSection` 12,
`displayPostRunSection` 3 - itself split into `displayAcceptanceStatus` 9
and `displayRegressionStatus` 17, one per phase - and `displayLastRunSection`
1. The split into per-phase printers was made UP FRONT because the combined
postRun block was heading for the high teens; it is also the more honest
reading of §3's row (each phase is its own output section).
`displayFeatureDetails` stays in status-features.ts as the sequencer - the
prd.json guard, the loads, the header line, five section calls plus the
postRun/last-run guards - and scores 4. The sibling imports NOTHING from
status-features.ts: every value arrives as a parameter (the A12
no-back-import pattern at its strongest), `isPidAlive` is imported directly
from the `utils/process-alive` leaf, and all status-file/PRD imports are
type-only (`check:import-cycles` stayed 0 by construction).

**One type-shape lesson:** `displayPostRunSection` takes the `PostRunStatus`
object, not the whole `NaxStatusFile` - `postRun` is optional on the file
type, and the naive whole-status parameter failed typecheck on
`status.postRun.acceptance` inside the helper (the original only compiled
because the `if (status?.postRun)` guard narrowed it inline). The narrow
parameter is also the faithful signature: the block only ever read
`status.postRun`.

**Helper scores (probe at maxAllowedComplexity=1, repo-root probe config as
a FULL COPY of biome.json - `extends` does not exist in biome 2.x and a
probe relying on it is rejected at deserialize; `--config-path=` flag per
§9.17, deleted after):** `displayRunStatusSection` 18, `displayRegression
Status` 17, `displayStoriesSection` 12, `displayAcceptanceStatus` 9,
`displayFeatureDetails` 4, `displayPostRunSection` 3,
`displayProgressSection` 2, `displayNoPrdNotice`/`displayLastRunSection` 1.
All <= 20 - no baseline hand-edit (§2.3 never triggered, thirteenth batch
running). Untouched, out of scope: `displayAllFeatures` 37 (pre-existing;
the file STAYS baselined at `[37]`, exactly as A8 left argv/verb and A13
left log/runTool), `isUsableStatusFile` 18, `getFeatureSummary` 18.
`check:complexity` reported only "improved" for status-features.ts, and
`check:complexity:update` was a pure lower: 237 -> 236 functions, 207 files
unchanged.

**File-size gate, single sibling held:** status-features.ts 502 -> 415
(strictly smaller; both counts after `bun x biome check --write`); the
sibling landed at 165 - under 600 with room, the smallest sibling of any
batch in this drain, because the moved mass is seven printer bodies plus
their comments while the loaders/table/banner logic stayed behind. No §9.19
coverage-floor scare either: `test:coverage` stayed green with the below-
floor count at 1 vs baseline 2 (the standing A5 improvement) - the residual
source keeps `loadStatusFile`/`isUsableStatusFile`/`getFeatureSummary`/
`displayAllFeatures`, all exercised by the existing suites, and the
sibling's section bodies are covered by the mirrors plus the
characterisation file. B5's twin-gate trap did not fire.

**Verification beyond the suite:** literal fingerprint diff of the original
function body against the new pair - all 17 double-quoted literals of
length >= 4 AND all 31 template-literal fixed parts appear verbatim, zero
missing (extraction was a verbatim move; comments relocated with their
code). One asymmetry now PINNED that review could have "cleaned up": the
regression-failed arm renders its timestamp space-separated
(` failed${count} 2026-...`) where the passed arm uses parens
(` passed (2026-...)`) - both preserved exactly.

**Nothing else surprising.** 1188 CLI tests green (incl. the 13
characterisation tests), `bun run typecheck` (both tsconfigs), `bun run
test` (all phases), `bun run check:all` (35 scripts; import-cycles 0,
file-sizes green, looseCast 1474 - the one pre-existing `as` cast moved
verbatim with its code, A13's precedent), and `bun run test:coverage` all
green.

**For the next batch:** B7 `runSession` (`src/interaction/ask-link.ts:291`,
69, 560 lines, test: yes) - the LAST Wave B row, in `src/interaction/`,
untouched by this drain so far. Pre-flight per this batch: (1) grep for a
`_deps`-style seam and check whether `src/interaction/index.ts` or any
barrel re-exports one (A1's trap); ask-link drives interaction channels, so
also check whether the Telegram/CLI/webhook plugins register anything the
extraction would need to import back; (2) A2's traps FIRST - a session
runner is exactly where per-turn state, retry loops, and an intentional
mid-loop throw whose catch persists partial state live (A2/A10's trap
shape); (3) grep test/ for source-text assertions on ask-link.ts, incl.
`test/unit/scripts/` (B4's rule); (4) 560 lines + extraction: the sibling
split is planned from the first line (A6's seam rule; A9's gate/post-gate
and B4's phase cuts are the templates); (5) audit log payloads and
interaction-request literal construction specifically (A3/A11/B1's hunting
ground). Post-drain note: over-60 is down to 9 (8 src + 1 scripts); after
B7 only the grouped Wave C remains - and the 40-milestone discussion from
§9.8 still stands.

### 9.21 - 2026-09-27, B7 done - `runSession` 69 -> 16 (one session)

The last Wave B row, closing the wave. One session, including a 7-test
characterisation commit - the "test: yes is not nothing to characterise"
warning held for the EIGHTH time running (A11, A12, B1-B6, now B7): the
mirror suite is one of the most thorough in the repo (46 tests pinning
allowlist denies, timeout-vs-fallback, AC4-AC10, keepalive, masking, dedupe
keys), and still left whole branches unpinned.

**Pre-flight, all answered BEFORE writing code:** (1) `_askLinkDeps`
(setTimeout/clearTimeout/ASK_KEEPALIVE_MS) EXISTS and is property-swapped by
the mirror suite for a fake clock - but only there, and no barrel re-exports
it (`src/interaction/index.ts` exports only the two factory/entry functions
plus three types). The seam stayed in ask-link.ts together with its only
consumers (`runKeepalive`, `clearKeepalive`, the timer arm in `resolve`);
nothing extracted needed it, so no deps-threading at all. (2) A2's traps,
checked first: the closure state (`activeId`, `queue`, `liveSessions`) is
touched ONLY by code that stays in ask-link.ts - the sequencer's activeId
one-liners, resolve, cancel, pending - so no SpinFlags shape crosses an
extraction boundary. The throw question resolved by design: `runSession`'s
inner catch settles waiters unavailable, and since `Session` is a shared
mutable object every phase already receives BY REFERENCE, mutate-in-place is
the native shape here (the session object IS the loop state; nothing is ever
returned). (3) NO source-text tests pin ask-link.ts - the Bun.file reads in
test/unit/interaction/ target unified-executor.ts and audit JSONL fixtures,
not source (eleventh batch running; B4's `test/unit/scripts/` rule checked
too, zero hits). (4) No per-file guard allow-list names the file (only
naxconfig-cast and permission-mode lists exist). (5) ask-link.ts is NOT in
coverage-per-file-baseline.json - above floor going in - so B5's twin-gate
trap was live; it did not fire (see below). (6) File measured 559 going in
(the doc's 560 - one line of drift, eleventh batch running).

**Characterisation first** (own commit `test: characterise runSession
unpinned branches before complexity drain`, 7 tests, green against the
unrefactored function, new file `test/unit/interaction/ask-link-session-edges
.test.ts` - the mirror sits at 681 of the 800 test cap, 119 headroom, too
tight for comfort; zero cast expressions, looseCast stayed 1474). What
NOTHING pinned, one test each: (a) `pending()` clearing once the prompt
settles (the activeId-reset adversarial hardening had zero assertions) on
both the allow path and after link-level cancel; (b) the cancel path's
`decidedBy: "unavailable"` (SPEC CASE 15 and the cancel tests assert only
`.decision`); (c) `featureName`/`storyId`/`summary` on the dispatched
request when supplied (storyId had NO test coverage at all - both arms: key
present, key absent); (d) the `featureName ?? "unknown"` default; (e) the
detail fallback arms `runs in: unknown` (root-less) and `reason:  <rule>`
(reason-less) plus the `stage:` line - every existing test's request carries
root AND reason; (f) a throwing chain's `decidedBy` (the mirror's throw test
checks decision only); (g) the `session.waiters.size === 0` arm of the
post-race guard - a real "allow" arriving after the sole waiter aborted
settles nobody and releases the serial queue (AC6 covers the second-waiter
case, nobody covered the no-waiters-left case with a non-null response).

**Technique:** sequencer + phases in ONE new sibling,
`src/interaction/ask-link-session.ts` (245 lines after `bun x biome check
--write`). The function-local `Waiter`/`Session` interfaces lifted to module
level in the sibling (type-only back-import; interfaces are erased, so the
lift is behaviour-neutral) - the sibling holds `deny` 1, `makeWaiter` 1,
`canRemember` (sibling-internal), `settleWaiters` 4 (the settle-and-detach
loop, called with `deny("unavailable")` from THREE sites - the no-chain arm,
the catch arm, and `settleAllUnavailable`, which was the same loop a fourth
time: P0's "one shared helper worth naming" again), `removeSettledSession` 3,
`buildApprovalRequest` 8 (the whole InteractionRequest literal; takes an
`ApprovalPromptInput` options object - featureName/storyId/stage/timeoutMs/
onRemember passed through and the builder keeps the `??` defaults and
conditional spreads, so the literal text is verbatim), `decideSessionOutcome`
9 (timeout / allowlist / remember-await; the original's nested if/else
outcome assignment became early returns - value-identical per branch, no
intervening side effects). `runSession` stays in ask-link.ts as the
sequencer: chain guard, AC9 guard, activeId + cancelPrompt setup, the
Promise.race, `decideSessionOutcome` + `settleWaiters`, both finallys.
`resolve`, `attachWaiter` (needs `opts.chain` in its onAbort closure),
`notifyWaiting`, `runKeepalive`, `clearKeepalive`, `cancel`,
`settleAllUnavailable` are untouched. The sibling imports ask-link.ts
TYPE-ONLY (`AskChannelResponse`) - `check:import-cycles` 0.

**One score surprise worth naming: the sequencer's finally nesting.** First
pass left `runSession` at 21 - the prediction was ~11. The delta is nesting
increments, not branches: every `if` inside a try/finally that is itself
inside a try/finally counts at +2/+3, so the inner finally's one-line
activeId guard and the outer finally's liveSessions sweep added ~10 points
between them with zero additional decisions. Fix was the A2 pattern one more
time: `removeSettledSession(liveSessions, session)` extracts the sweep with
the map passed BY REFERENCE (closure state mutated in place, exactly the
SpinFlags lesson - only the reference crosses the boundary, the closure's
own reads in resolve/cancel keep working). `runSession` 21 -> 16, and - the
real prize - every function in ask-link.ts landed under 20 (runKeepalive 19,
resolve 19, the rest smaller), so the file LEFT the over-20 baseline
entirely instead of staying baselined at [21]. Lesson: for a
try/catch/finally-heavy sequencer, budget the finally guards' nesting into
the score prediction.

**Helper scores (probe at maxAllowedComplexity=1, repo-root probe config as
a FULL COPY of biome.json, deleted after - B4's tooling note):**
`decideSessionOutcome` 9, `buildApprovalRequest` 8, `settleWaiters` 4,
`removeSettledSession` 3, `deny`/`makeWaiter` 1; untouched residents:
`runKeepalive` 19, `resolve` 19 (its inner `onAbort` closure 15),
`attachWaiter` 9, `notifyWaiting` 7, `settleAllUnavailable` 13 -> 5 (the
dedupe), `cancel` 3, `clearKeepalive` 2, `runSession` 69 -> 16. All <= 20 -
no baseline hand-edit (§2.3 never triggered, fourteenth batch running).
`check:complexity` reported only "improved" for ask-link.ts, and
`check:complexity:update` was a pure lower: 236 -> 235 functions,
207 -> 206 files (ask-link.ts left the over-20 baseline entirely;
ask-link-session.ts added nothing).

**File-size gate, single sibling held:** ask-link.ts 559 -> 402 (strictly
smaller; both counts after `bun x biome check --write`); the sibling landed
at 245 - under 600 with room. The moved mass is the types (lifted, ~60
lines with their comments), the request literal, the outcome decision, and
the settle loops; the queue/session bookkeeping stayed behind. One type
note: `AskLinkOutcome` is NOT re-exported by ask-link.ts (it is imported
there from `@/permissions`), so the sibling takes it from the same source -
type-only edges only, both verified.

**One migration slip caught by the suite + tsc, worth the minute it cost:**
`maskedFooter` is used by BOTH the prompt builder AND `resolve` (the
footer-length precheck before the MAX_COMMAND_CHARS denial) - the first cut
moved it without exporting it back, and `typecheck` plus the "Review Focus
4" mirror test caught it immediately. The sibling exports it; ask-link.ts
imports it back. No cycle: the import direction ask-link -> sibling is the
only runtime edge.

**Verification beyond the suite:** literal fingerprint diff of the original
file against the pair - all 37 double-quoted literals AND all 53
template-literal fixed parts (placeholders stripped) appear verbatim, zero
missing; `Date.now()` 1 -> 1 (createdAt in the builder, same logical
position); the settle loops were byte-identical across their four original
occurrences before dedupe (checked line-by-line before unifying); the outer
finally's statement ORDER is unchanged (settled -> cancelPrompt -> activeId
-> sweep -> clearKeepalive).

**Nothing else surprising.** 320 interaction tests green (incl. the 7
characterisation tests), `bun run test` all phases, `bun run typecheck`
(both tsconfigs), `bun run check:all` (35 scripts; import-cycles 0,
file-sizes green, looseCast 1474, 'as unknown as' 0), and `bun run
test:coverage` all green - below-floor count 1 vs baseline 2 (the standing
A5 improvement). B5's twin-gate trap did NOT fire: the residual ask-link.ts
keeps resolve/attachWaiter/keepalive/the sequencer, all executed by the
mirror suites, and the sibling's phase bodies are covered by the mirrors
plus the characterisation file.

**For the next batch:** only the grouped Wave C remains. C1 is next in
table order and is TWO functions: `validateConfig` (110 - the worst score
left in the repo, `src/config/validate.ts`, 175 lines, test: yes) and
`deepMergeConfig` (78, `src/config/merger.ts`, 173 lines, test: none), each
getting its own `refactor:` commit in one session. `validateConfig` is
P0's exact shape - field-by-field validator, expect the table-driven /
one-extractor-per-field-group playbook to apply directly (P0's §9.1 is the
manual; note its shared `checkRelativeNoTraversal` trick). `deepMergeConfig`
is `test: none`: run §2.2's grep BEFORE anything else, and expect to write
its characterisation from scratch. Also from C1's row: `merger.ts` and
`validate.ts` are small files (173/175 lines) - in-place helpers are
affordable there if the 600-line gate allows, but still prefer the sibling
when it reads better. Post-drain note: over-60 is down to 8 (7 src + 1
scripts); after C1-C4 the drain can set the biome cap to 60 - and the
40-milestone discussion from §9.8 still stands.

### 9.22 - 2026-09-27, C1 done - `validateConfig` 110 -> 0 and `deepMergeConfig` 78 -> 0 (one session, two refactor commits)

The first grouped batch: two functions, one session, each with its own
`refactor:` commit (`acaa28381` for validateConfig; deepMergeConfig's refactor
commit carries this entry, its baseline lower and the §0/§4 close-out), each
preceded by its own `test: characterise ...` commit (`7d79fabe6`,
`fdb8f914b`). Both are P0's exact shape - field-by-field
validator / per-key decision chain - and the P0 playbook applied directly.

**The mirror-vs-pinned trap has a deprecated-twin variant.** `validateConfig`
was `test: yes` and its mirror (validate.test.ts, 15 tests) pins the
fallback-map / tierOrder / complexityRouting groups thoroughly - but the basic
field groups (version, models, execution limits, agent.default, tierOrder
attempts) had NO validateConfig-level tests anywhere. The same message strings
ARE pinned in test/integration/config/config.test.ts - through
`NaxConfigSchema.safeParse`, the zod validator the module header says
validateConfig is deprecated in favour of. A grep for the function name misses
that; a grep for the MESSAGE finds it, and the hit is the wrong function.
20 characterisation tests pinned every unpinned branch through validateConfig
itself (byte-exact messages), including a `??`-semantics quirk: an empty-string
`agent.default` is used verbatim as the models key (`??` only falls back on
null/undefined), producing `models. is required (default agent has no model
map)`. deepMergeConfig's §4 `test: none` was the heuristic-path-only reading
again (B1's lesson): test/integration/config/merger.test.ts (475 lines) pins a
LOT - SEC-07, hook flattening, constitution, immutability - and 6 new tests
pinned what it left: the hooks sibling-field copy loop (skipGlobal), BOTH
non-plain-baseHooks arms, primitive-to-object replacement, the `prototype`
dangerous key, and the hooks-both-plain requirement.

**A latent crash found while characterising, recorded not fixed (§2.1):**
`validateConfig` with `models: undefined` and a POPULATED complexityRouting
THROWS TypeError - the routing block reads `config.models[defaultAgentKey]`
(line 152 of the original) without re-checking `config.models`, so it never
returns the "models mapping is required" error in that state. Pinned as-is
(both facets: the returned error with empty routing, the throw with populated
routing). Same class, noted not pinned: missing `execution`/`autoMode`
sections crash their blocks identically - defensive-only for the type-honest
callers the module is kept for.

**Technique - validateConfig:** eight group validators in a new sibling,
`src/config/validate-fields.ts` (224 lines after `bun x biome check --write`),
in original push order: `checkVersion` 1, `checkModelsMapping` 6 (+ private
`checkModelEntry` 7), `checkExecutionLimits` 3, `checkAgentDefault` 2,
`checkTierOrder` 6, `checkFallbackMapAgents` 2, `checkTierOrderAgentKeys` 16,
`checkComplexityRouting` 16; shared helpers `defaultAgentKey` (the thrice-
duplicated `?? DEFAULT_AGENT_NAME`) and `missingTierMessage` (the fallback-map
message is the default-agent message plus its parenthetical suffix - P0's
shared-helper trick, composition verified byte-identical at runtime).
`checkFallbackMapAgents` breached §2.3 on the FIRST pass (26): standard second
split into `fallbackMapAgents` (the set builder, 6) and `fallbackAgentErrors`
(11). `validateConfig` itself is an eight-call push sequence scoring 0;
validate.ts is 175 -> 63.

**Technique - deepMergeConfig:** new sibling
`src/config/merger-special-cases.ts` (126) holds `DANGEROUS_MERGE_KEYS`,
`isPlainObject` (both moved wholesale - merger.ts re-exports the keys set, so
dotenv.ts's `./merger` import path is unchanged), `mergeHooks` 7 (+ private
`mergeHookDefs` 13), and `mergeConstitution` 6. THE cycle question mattered
here: mergeConstitution recurses into deepMergeConfig, so a sibling
import-back would cycle - resolved with the A5/A6 by-reference pattern (the
merger arrives as a `MergeDeep` parameter, the dispatcher passes itself).
First pass left `deepMergeConfig` at 18 - the B7 finally-lesson in a for-loop
shape: the loop's +1 nesting inflates all eight branch decisions. Second
split: the loop body became `applyOverrideKey(result, key, value)` (10) - it
mutates the accumulator in place, legal because EVERY original branch settled
its key with `continue`, so there is no fall-through to preserve.
`deepMergeConfig` is now clone / loop / return, scoring 0; merger.ts is
173 -> 98.

**Ratchet gotcha, sharper than §9.6 recorded:** the escape-hatch looseCast
counter is GLOBAL - a cast added to an EXISTING test file grows it just like a
new file. The first merger characterisation draft added two `as Record` casts
(1474 -> 1476, FAIL). Fix was cheaper than expected: a plain
`{ prototype: {...} }` literal creates the same own data property JSON.parse
would (only `__proto__` is literal-special), so the test needed no cast at
all. looseCast stayed 1474.

**File-size gate trivially met:** both source files were small going in, and
the sibling extraction left them strictly smaller (175 -> 63, 173 -> 98) with
both siblings (224, 126) far under 600. No §9.19 coverage-floor scare: both
siblings are covered by the mirrors plus the two characterisation suites;
`test:coverage` green, below-floor count 1 vs baseline 2 (the standing A5
improvement).

**Verification beyond the suite:** literal fingerprint diffs of each original
file against its pair - validateConfig: 20/20 double-quoted literals and
36/36 template fixed parts verbatim (the one flagged "missing" is the
fallback tier message now composed from `missingTierMessage` + suffix; proven
runtime-identical with a direct probe); merger: 8/8 and 15/15, delete-site
count 1 -> 1. 1209 config unit tests + the merger integration suite green
before each refactor commit; full suite (all phases) green at close-out;
check:all 35 scripts (import-cycles 0, file-sizes green, looseCast 1474);
typecheck both tsconfigs.

**For the next batch:** C2 is three functions - `parseFrontmatter`
(`src/context/rules/rules-frontmatter.ts:110`, 75), `coerceVerdict`
(`src/tdd/verdict-reader.ts:98`, 72), `parseTestFailuresDetailed`
(`src/test-runners/ac-parser.ts:50`, 64). Lessons that transfer: (1) probe
helper scores EARLY - both C1 functions needed one second split (the §2.3
breach and the nesting-inflated sequencer were both found by the
maxAllowedComplexity=1 probe, not by reading); (2) grep test/ for the exact
message strings too, not just function names - a deprecated twin (zod schema)
can hold lookalike pins; (3) coerceVerdict is `test: none` at the unit path -
check for an integration mirror before assuming §2.2 means from-scratch; (4)
if any target function recurses into itself (constitution did), plan the
by-reference parameter before writing the sibling. Post-drain note: over-60
is down to 6 (5 src + 1 scripts); after C2-C4 the drain sets the biome cap
to 60 - and the 40-milestone discussion from §9.8 still stands.

### 9.23 - 2026-09-27, C2a done - `parseFrontmatter` 75 -> 13 (one session)

First of the grouped C2 batch (three functions, one session, one `refactor:`
commit each). P0 + B3's hybrid shape exactly as §3's table predicted: a
line-parser displacement preamble (BOM / blank lines / HTML comments) feeding
a field-by-field YAML validator. One session, including a 14-test
characterisation commit - the "test: yes is not nothing to characterise"
warning held for the NINTH time (A11-A13, B1-B7, now C2a).

**Pre-flight, all answered BEFORE writing code:** (1) NO `_deps`-style seam -
rules-frontmatter.ts is a leaf; its importers (`rule-sections`, `rule-budget`,
`canonical-loader`) import the parse functions and types by value. (2) A2's
traps: no loop-carried mutable state beyond the comment-strip accumulator
(which moved wholesale into its helper), no closures over `let`s, every throw
propagates out of the function untouched. (3) NO source-text tests pin the
file - the grep hits import the module normally. (4) No per-file guard
allow-list names the file (`grep -Rn "grep -vE" scripts/` - only the
naxconfig-cast list, which does not). (5) File measured 293 going in - the
doc's number, exact.

**Characterisation first** (own commit `test: characterise parseFrontmatter
unpinned validation branches before complexity drain`, 14 tests, new file
`test/unit/context/rules/rules-frontmatter-edges.test.ts` - the main mirror
sits at 664 of the 800 test cap; zero cast expressions). The two mirrors pin
the displacement ACs, BUG-03, stages AC1-AC9, and ALL FOUR description
branches. What NOTHING pinned, one test each: (a) the "Frontmatter must be a
YAML object" throw for a top-level YAML LIST; (b) the same throw for a
top-level YAML SCALAR; (c) the "Failed to parse YAML frontmatter:" wrapper
(unclosed-quote input); (d) priority as a string ("high"); (e) priority as
`.inf` - which Bun.YAML parses as NULL, so it lands on the not-a-number error,
not the `!Number.isFinite` arm (that arm is defensive-only through YAML; a
newly discovered quirk, pinned as-is per §2.1); (f) fractional priority
truncation (3.7 -> 3); (g) paths as empty string; (h) paths as a number;
(i) paths array with a whitespace-only entry; (j) appliesTo as a bare string;
(k) appliesTo array with a whitespace-only entry; (l) stages as a bare string;
(m) stages array with a whitespace-only entry; (n) a DISPLACED block with no
closing delimiter returns the default result carrying the displaced warning
instead of throwing - the `if (!close) { if (warnings.length > 0) ... }` arm
nothing exercised.

**Technique:** in-place extraction (§2.4 did not force a sibling at 293
lines, and the whole file is one cohesive parser unit). `parseFrontmatter`
stays the sequencer: displacement detection -> warning push ->
comment-displaced early return -> no-delimiter early return -> closing-
delimiter match (with the BUG-03 compact-empty special case kept verbatim
inline) -> YAML -> unknown keys -> five field extractors -> return literal,
and scores 13. New private helpers: `detectDisplacedFrontmatter` 6 (the
BOM/blank/comment preamble with its AC10/AC11/AC15 comments moved verbatim;
returns the stripped content plus both reason strings so the `??=` precedence
and the comment early-return semantics are unchanged), `parseYamlDocument` 8
(the try/catch + object gate), `assertKnownKeys` 3, and the field extractors
`extractPriority` 3, `extractPaths` 6, `extractAppliesTo` 3, `extractStages`
10, `extractDescription` 5; `stripLeadingBlankLines` (pre-existing) 4. Every
error message byte-identical; the `Bun.YAML.parse(close[1] ?? "")` call moved
into `parseYamlDocument` whole.

**Helper scores (probe at maxAllowedComplexity=1, repo-root probe config per
§9.13/§9.17, deleted after):** all ≤ 10 except the sequencer's 13 - no §2.3
breach, no second split, no baseline hand-edit (§2.3 never triggered, fifteenth
batch running). `check:complexity` reported only "improved" for
rules-frontmatter.ts, and `check:complexity:update` was a pure lower:
233 -> 232 functions, 204 -> 203 files (the file left the over-20 baseline
entirely).

**File-size gate:** in place, 293 -> 323 after `bun x biome check --write`
(+30 lines of helper signatures and doc comments; far under the 600 cap). The
in-place choice also sidesteps §9.19's coverage-floor twin gate entirely - no
new file, and the extracted bodies are the same well-covered code in the same
well-covered file.

**Verification beyond the suite:** literal fingerprint diff of the original
file against the refactored file - all 52 quoted/template literals of length
>= 4 appear verbatim, zero missing. 182 context/rules tests green (incl. the
14 characterisation tests), 1724 across the context tree, `bun run typecheck`
(both tsconfigs) clean.

**For the next function in this batch (C2b `coerceVerdict`):** §4's
`test: none` is heuristic-path-only again - `test/unit/verification/
tdd-verdict.test.ts` (753 of the 800 cap) drives it directly and pins the
approval/ratio logic thoroughly; the unpinned set is the reasoning fallback
chain, the top-level acceptanceCriteria branch, the obj-quality branch,
fixes/testFailureDiagnosis, and several coercion defaults. New tests need a
sibling file (753 is too tight).

### 9.24 - 2026-09-27, C2b done - `coerceVerdict` 72 -> 4 (one session)

Second of the grouped C2 batch. Field-by-field coercion exactly as §3's row
predicted, and §4's `test: none` was heuristic-path-only for the third time
(B1, C1): `test/unit/verification/tdd-verdict.test.ts` (753 of the 800 cap)
drives `coerceVerdict` directly and pins the approval tokens, the BUG-1 ratio
rules, and the #2264 no-signal guard thoroughly. One session, including a
20-test characterisation commit in a new sibling,
`test/unit/verification/tdd-verdict-coerce-edges.test.ts` (753 is too tight
for additions; zero cast expressions - the diagnosis fixture is typed via
`import type { TestFailureDiagnosis }`).

**What the mirror left unpinned, one test each:** the APPROVED token; the
`obj.approved === true` disjunct asserted DIRECTLY (the mirror only ever
asserts passCount beside it); the whole reasoning fallback chain
(obj.reasoning -> obj.overall_status -> summary.overall_status -> the
"Coerced from free-form verdict:" note, whose verdict is the UPPERCASED
string); allMet defaulting to the approval value; the `c.met === true` arm
(no status); the criterion-text fallbacks (c.criterion, then the review key);
the evidence note truncation at 200 and its absent arm; the top-level
acceptanceCriteria branch (allMet OVERWRITE + criteria merged as-is) plus its
quirk pinned as-is per §2.1 - top-level entries with met:false do NOT flip a
true allMet, only the review loop folds; the summary "4/4 SATISFIED" count
met===total rule (the mirror pins it only incidentally inside the big
free-form fixture); the obj-quality rating branch; an unrecognised quality
value -> acceptable; fixes carried/non-array->[]; testFailureDiagnosis
carried/malformed-dropped; the fail-closed testModifications placeholder; a
non-string summary.test_results parsing nothing; a non-object tests value
being ignored.

**Pre-flight:** (1) verdict-reader.ts is NOT barrel-exported - `src/tdd/
index.ts` re-exports readVerdict/cleanupVerdict/VERDICT_FILE from `./verdict`
(a DIFFERENT file that re-exports from verdict-reader), so no mutable seam
exists; the test-runners-style barrel question resolved clean. (2) A2's
traps: no loops, no closures over `let`s; the one try/catch is the coercion
fail-safe (catch -> null) and stayed in the sequencer, wrapping the helper
calls exactly as it wrapped the monolith's blocks. (3) No source-text tests
read the file. (4) No per-file guard allow-list names it.

**The §9.22 looseCast lesson shaped the split:** the escape-hatch counter is
GLOBAL, and the monolith's six `as Record<string, unknown>` casts each had to
land EXACTLY once. `summaryOf` (the verification_summary cast) became a named
reader called by the four summary-reading helpers; every other cast moved
whole into its single consumer. Zero new cast expressions.

**Technique:** in-place extraction (319-line file). `coerceVerdict` stays the
sequencer - approval-signal guard, try{ four coercion calls + return
literal }catch{ return null } - and scores 4. Helpers: `resolveApproval` 4
(returns { approved, verdictStr } because the reasoning fallback quotes the
UPPERCASED string), `coerceTestCounts` 13, `coerceCriteria` 5, `resolveQuality`
9, `buildReasoning` 3, `summaryOf` 1. `isValidVerdict` (27, pre-existing) and
`readVerdict` (9) untouched.

**A REAL REGRESSION caught by the suite, worth its paragraph:** the first
pass split `coerceCriteria` from a 39-point monolith (§2.3 breach, standard
second split into `collectReviewCriteria` / `mergeTopLevelCriteria` /
`allMetFromSummary`) and folded the review verdict as
`let allMet = approved && collectReviewCriteria(criteria, acReview)` - the
`&&` SHORT-CIRCUITED the call whenever approved was false, so FAIL-verdict
inputs collected zero criteria. The mirror's UNSATISFIED test and the new
met:true test both failed instantly (570/572). The comment above the line had
LITERALLY warned against short-circuiting the call; the code did it anyway.
Fix: call first, fold the returned boolean after
(`const reviewAllMet = collectReviewCriteria(...); let allMet = approved &&
reviewAllMet;`). Lesson generalised from A2's state-mutation rule: a helper
with side effects (here, building the list) must never sit on the right side
of a `&&` whose left side can be false - same shape as "never return a fresh
state object across a throw", arrived at from the boolean direction. The
`reviewAllMet` fold is exactly equivalent: review entries can only flip
allMet to false, so `approved && reviewAllMet` reproduces the original
if(!met) allMet = false loop.

**Helper scores (probe at maxAllowedComplexity=1, repo-root probe config per
§9.13/§9.17, deleted after):** coerceTestCounts 13, collectReviewCriteria 14,
mergeTopLevelCriteria 10, resolveQuality 9, coerceCriteria 5,
resolveApproval 4, coerceVerdict 4, buildReasoning 3, allMetFromSummary 3,
summaryOf 1. The first-pass 39 on coerceCriteria is this batch's §2.3 breach,
fixed by the second split above - no baseline hand-edit needed.
`check:complexity` reported only "improved"; `check:complexity:update` was a
pure lower: 232 -> 231 functions, 203 files unchanged (verdict-reader.ts
STAYS baselined at [27] for isValidVerdict, untouched, out of scope - same
pattern as A8 leaving argvBranch/verbBranch).

**File-size gate:** in place, 319 -> 393 after `bun x biome check --write`
(+74 lines of helper signatures, doc comments, and the CoercedCriterion type;
far under the 600 cap; no new file, so §9.19's coverage-floor twin gate never
arises).

**Verification beyond the suite:** literal fingerprint diff of the original
file against the refactored file - all 40 quoted/template literals of length
>= 4 appear verbatim, zero missing. 572 verification + tdd-integration tests
green (incl. the 20 characterisation tests), verify-op-parse green,
`bun run typecheck` (both tsconfigs) clean.

**For the next function in this batch (C2c parseTestFailuresDetailed):**
`failedACs` is heavily pinned through the parseTestFailures wrapper
(test/unit/pipeline/stages/acceptance.test.ts) but `taggedFailureCount` (the
entire Detailed API, BUG-32) and the parser-level AC-HOOK detection have ZERO
coverage anywhere - characterise those. Framework is a closed 8-value union;
a Record dispatch keyed on it needs no own-property guard (unlike B3's
untrusted wire keys) but must preserve rust/mocha running NO branch.

### 9.25 - 2026-09-27, C2c done - `parseTestFailuresDetailed` 64 -> 11 (one session, C2 complete)

Third and last of the grouped C2 batch; the drain's over-60 set is down to
C3/C4. §3's "line parser, big if/switch chain" row, and this one is the
cleanest dispatch-map shape of the whole drain: four framework-guarded
branches per line, each an independent predicate + regex. One session,
including a 13-test characterisation commit - `test: none` meant only "no
file at the heuristic path" again: the `failedACs` HALF is thoroughly pinned
through the parseTestFailures wrapper in acceptance.test.ts, but the entire
`parseTestFailuresDetailed` API had zero direct coverage.

**What nothing pinned, characterised in new file
`test/unit/test-runners/ac-parser-edges.test.ts`** (13 tests; zero cast
expressions): (a) `taggedFailureCount` counting every tagged line vs the
deduplicated id count (BUG-32's raw-vs-dedup contract, incl. the overridden-AC
3-cases-one-id scenario); (b) failure lines without an AC tag counting
nothing; (c) the AC-HOOK sentinel's positive arms ("hook timed out" AND
"hook failed" markers) with count +1; (d) both negative arms (unnamed without
hook marker; hook marker without unnamed failure); (e) AC-HOOK emitted
exactly once for several unnamed failures; (f) framework GATING - a
bun-detected output ignoring an indented go `--- FAIL:` marker (the same
line extracts AC-2 under "unknown"; detector checks go before bun, so the go
marker had to be indented in the bun-detected fixture); (g) rust- and
mocha-detected outputs running NO matcher even with bun markers present;
(h) the bun matcher's `toUpperCase` (a lowercase `(fail) ac-2:` yields
"AC-2" - go/pytest/jest build the id, bun is the only branch that
uppercases). One fixture lesson: an un-indented `--- FAIL:` line in a
supposedly-framework-less fixture silently flips detection to go and the
bun branch never runs - write framework-sensitive fixtures with the
detector's ordering open.

**Pre-flight:** (1) no `_deps`-style seam - the test-runners barrel
re-exports parseTestFailures/parseTestFailuresDetailed BY VALUE; no test
mutates the module. (2) A2's traps: the only accumulators are the local
failedACs array and the counter, both loop-local; the hook `lines.some(...)`
closures read `lines` (a const); no throws. (3) No source-text tests; no
per-file guard allow-list names the file. (4) File measured 141 going in -
the doc's number, exact.

**Technique:** framework-keyed dispatch map, in place (§2.4 did not force a
sibling at 141 lines). `type LineFailureMatcher = (line: string) => string |
null`; one matcher per framework family (`matchBunFailure` 2,
`matchGoFailure` 2, `matchPytestFailure` 2, `matchJestVitestFailure` 3 -
each carrying its branch's anchor/phantom-AC comment VERBATIM), then
`MATCHERS_BY_FRAMEWORK: Record<Framework, LineFailureMatcher[]>` - bun/go/
pytest singleton, jest+vitest sharing the bullet/FAIL matcher, rust/mocha
EMPTY arrays, unknown = all four. The Framework union is closed
(detector-owned), so the map needs no own-property guard - the B3 hazard
does not apply to a typed internal key. `parseTestFailuresDetailed` is now:
stripAnsi -> detect -> split -> nested for-loop over matchers (push dedupe +
count, exactly the original's per-branch tail) -> hook-timeout sentinel
(verbatim) -> return, and scores 11. `parseTestFailures` (wrapper) untouched
at 1. A behavioural subtlety preserved by construction: under "unknown" ONE
line can match MULTIPLE matchers and each match increments the count and
attempts the push - the dispatch loop reproduces the original's four
sequential guards exactly.

**Helper scores (probe at maxAllowedComplexity=1, repo-root probe config per
§9.13/§9.17, deleted after):** matchers 2/2/2/3, `parseTestFailuresDetailed`
64 -> 11. No §2.3 breach, no second split, no baseline hand-edit (§2.3 never
triggered, sixteenth batch running). `check:complexity` reported only
"improved" for ac-parser.ts, and `check:complexity:update` was a pure lower:
231 -> 230 functions, 203 -> 202 files (ac-parser.ts left the over-20
baseline entirely).

**File-size gate:** in place, 141 -> 151 after `bun x biome check --write`
(+10 lines of matcher signatures and the map; far under the cap; no new
file, so the §9.19 coverage-floor twin gate never arises).

**Verification beyond the suite:** literal fingerprint diff of the original
file against the refactored file - all 43 quoted literals verbatim EXCEPT
the three framework-guard strings ("pytest", "jest", "vitest"), which now
serve as the dispatch map's unquoted property keys - B3's exact precedent,
runtime-identical; all 4 `.match()` regex sources and the hook-timeout
`.some()` regex verbatim. 556 tests across the test-runners + acceptance +
acceptance-red-gate + hardening + acceptance-loop suites green (incl. the 13
characterisation tests), `bun run typecheck` (both tsconfigs) clean.

**For the next batch:** C3 `lexBashCommand`
(`src/permissions/bash-lex.ts:78`, 93, 248 lines, test: yes) - ALONE, not
grouped, because it feeds the permission decision: run the command-safety
corpus eval (`scripts/command-safety-eval.ts`) before AND after and record
both results in §9. The usual pre-flight (seam/barrel sweep, A2 traps,
source-text greps, allow-lists) applies; 248 lines means in-place extraction
is likely affordable. After C3, C4 finishes the drain and sets `biome.json`
`maxAllowedComplexity` to 60. The 40-milestone discussion from §9.8 still
stands.

### 9.26 - 2026-09-27, C3 done - `lexBashCommand` 93 -> 7 (one session)

The security-relevant batch, alone as §4 mandated. One session, including a
15-test characterisation commit - the "test: yes is not nothing to
characterise" warning held for the TENTH time running (A11-A13, B1-B7, C2a,
now C3).

**The §4 C3 gate, first thing done and last thing re-checked:** the
command-safety corpus eval (`bun scripts/command-safety-eval.ts --corpus
test/fixtures/command-safety/corpus.jsonl --out <outside the repo>`, rule
scorer, no live rows) ran BEFORE the refactor and AFTER it, and the two
reports are byte-identical (`diff` clean): rule AUROC 0.877, catch@FP 0.754
(t=1.000) at every budget, per-category catches deletes_data 0.600 /
discards_work 0.789 / network_send 0.643 / outside_project 0.706 /
privilege 1.000 / system_change 0.941, corpus 134 dangerous / 154 benign /
16 grey.

**Pre-flight, all answered BEFORE writing code:** (1) NO `_deps`-style seam -
bash-lex.ts has ZERO imports BY DESIGN (module header), so there is nothing
to thread and nothing to cycle; `src/permissions/index.ts` re-exports
`lexBashCommand` and the types BY VALUE, and no test mutates the module.
(2) A2's traps: the lexer's mutable accumulators (`word`, `opaque`,
`started`, `pendingRedirect`, `tokens`, `redirects`, `segments`) are exactly
the closure state the function-local `refusedHere`/`flushWord`/
`flushSegment` helpers mutate - lifted to module level as one `LexerState`
MUTATED IN PLACE (the A2 rule, needed here because a refusal can strike at
any step and the prefix contract reads whatever the interrupted segment had
completed); no closure set up once in setup (no SpinFlags shape); no throw
crosses a state boundary (refusals return values, never throw). (3) NO
source-text tests pin the file (grep across `test/` incl. `test/unit/
scripts/` - B4's rule - found only value imports). (4) No per-file guard
allow-list names the file (`grep -Rn "grep -vE" scripts/`). (5) File
measured 247 going in (the doc's 248 - one line of drift, seventeenth batch
running).

**Characterisation first** (own commit `test: characterise lexBashCommand
unpinned lexer branches before complexity drain`, 15 tests, green against
the unrefactored lexer, new file `test/unit/permissions/bash-lex-edges.test
.ts`; zero cast expressions, looseCast stayed 1474). The mirror pins the
tokenizer/segmenter ACs, all four US-001 prefix ACs, and 20 refusal cases -
but left unpinned: (a) the `separator` VALUE on interrupted segments (`;`,
`&&`, `||`, `|`, `&`, and `\n` which folds to `;`) plus its ABSENCE on the
final segment - the whole `BashSegmentSeparator` contract had zero
assertions; (b) `\t` and `\r` splitting words like a space; (c) a
double-quoted word WITHOUT `$` staying non-opaque; (d) a backtick inside
double quotes refusing (the mirror pins only bare backtick and `$(`-in-
quotes); (e) an escaped `\$` being a literal NON-opaque part of the word
(the escape handler never sets opaque - correct, the value is known); (f)
the escaped-`\$`-then-`(` interaction, which still refuses as a subshell;
(g) the `>(` arm of process substitution; (h) the `<&` arm of fd
duplication; (i) a trailing background `&` refusing as "an empty command
segment"; (j) `;;` - an empty MIDDLE segment refusing with the completed
first segment kept in the prefix; (k) `''` yielding an empty non-opaque
token (the `started`-with-empty-word quirk); (l) `2>>` (the fd-digit reset
against the APPEND operator); (m) multiple redirects keeping their order;
(n) a refusal AFTER a completed redirect keeping that redirect in the
prefix; (o) a redirect operator still awaiting its target being DROPPED
from the prefix (the doc-comment contract nothing pinned; also pins that
whitespace does not flush a pending redirect). The pre-commit hook caught
one genuine type error in the first draft (a `string` test.each column
against the `BashSegmentSeparator` union in a `toBe`) - typed the case
table instead of casting; the hook works, per §9.6.

**Technique:** §3's dispatch-map row, IN PLACE (247 lines, far under 600;
no new file, so §9.19's coverage-floor twin gate never arises).
`lexBashCommand` stays the sequencer: empty-command guard, `LexerState`
init, the while-loop dispatching through `stepAt`, the plain-word-character
fallback kept inline, final `flushSegment` - and scores 7. Ten ordered
handlers, each `(state, i) => LexStep | undefined` where `LexStep` is
`{ kind: "advance", by } | { kind: "refuse", construct }`: `lexSingleQuote`
2, `lexDoubleQuote` 5, `lexEscape` 2, `refuseGroupingOrExpansion` 9,
`refuseRedirectForm` 10, `lexDollar` 1, `skipWhitespace` 2,
`lexLineSeparator` 3, `lexControlOperator` 12, `lexRedirect` 6; plus the
three lifted closure helpers `refusedHere` 2, `flushWord` 3, `flushSegment`
4, `doubleQuoteEnd` 5 (untouched), and `stepAt` 3 (first-claimant finder).
ORDER IS BEHAVIOUR: the HANDLERS table must stay in the original guard
chain's order (`$(` before `$`, `<<` before `<`, `&>` before `&`), and the
table carries a comment saying so - a future handler appended out of order
is the likeliest regression vector for this file.

**A behavioural subtlety preserved by construction, worth naming:** a bare
`<`/`>` handler must run AFTER the three redirect-form refusals AND the
separators, and the redirect handler's fd-digit reset (`/^\d$/.test(word)`)
must read the word BEFORE `flushWord` clears it - the differential harness
below sweeps all of these, which is why it exists.

**Verification - differential testing instead of literal fingerprinting.**
The first fingerprint attempt (naive quote-paired literal extraction)
produced FALSE "missing" artifacts - single quotes inside code confuse any
regex pairing, and A3's diff-the-original lesson deserves a sharper tool
for a lexer, whose entire surface is quoting. Replaced with a differential
harness: the ORIGINAL (from git) and REFACTORED lexers ran on 9801 inputs -
every string of length <= 3 over a 21-symbol shell alphabet
(`' " \ $ \` ( ) < > & | ; \n \t \r space a 2 ! # E` = 9261 + shorter, plus
all 304 command-safety corpus commands, plus every double-quoted literal
from both test files) - with FULL result JSON compared: **0 diffs**, 8232
of the cases refused (so the prefix contract was swept too). This is the
strongest equivalence evidence of any batch in the drain and the cheap
default for any future pure-function batch: exhaustive small-alphabet
enumeration catches order swaps no example list thinks of.

**Probe tooling note (sharper than §9.17 recorded):** the
maxAllowedComplexity=1 probe config must be a FULL COPY at the REPO ROOT -
a /tmp copy fails with "Cannot read file" because biome.json's plugin paths
are relative. Also `sed` must match the actual formatting
(`"maxAllowedComplexity": 170` sits inside `"options":` on its own line).
Probe deleted after.

**File-size gate:** in place, 247 -> 340 after `bun x biome check --write`
(+93 lines of handler signatures, the state/step types, and relocated
comments; far under the 600 cap). The zero-imports rule is untouched - the
refactor added no imports at all.

**Nothing else surprising.** 195 permissions tests green (incl. the 15
characterisation tests), `bun run test` all phases (22255 tests),
`bun run typecheck` (both tsconfigs), `bun run check:all` (35 scripts;
import-cycles 0, file-sizes green, looseCast 1474, 'as unknown as' 0), and
`bun run test:coverage` all green - below-floor count 1 vs baseline 2 (the
standing A5 improvement). `check:complexity` reported only "improved" for
bash-lex.ts, and `check:complexity:update` was a pure lower: 230 -> 229
functions, 202 -> 201 files (bash-lex.ts left the over-20 baseline
entirely - §2.3 never triggered, eighteenth batch running).

**For the next batch:** C4 finishes the drain with TWO functions -
`generateCommand` (`src/cli/generate.ts:49`, 99, 267 lines, test: none) and
`main` (`scripts/report-test-consolidation.ts:293`, 79, 485 lines,
test: none) - each with its own `refactor:` commit, and the SECOND one's
commit also sets `biome.json` `maxAllowedComplexity` 170 -> 60. Lessons
that transfer: (1) both rows say `test: none` - the heuristic-path-only
reading was wrong in B1/C1/C2, so grep for integration mirrors and MESSAGE
strings before writing from scratch; (2) `generateCommand` is the CLI-action
shape (§3's row; §9.5 is the manual: grep source-text tests first, keep
pinned blocks inline, one function per output section); (3) `main` is a
scripts/ file - B4's `test/unit/scripts/` rule applies to its greps too;
(4) the differential harness pattern (exhaustive small-alphabet enumeration
against the git original) is available for any pure function. Post-drain:
zero functions over 60, cap drops to 60, and the 40-milestone discussion
from §9.8 (38 functions over 20, many already in the high teens) goes to
the user.
