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

## 0. Current state - measured 2026-09-27 (chore/complexity-ratchet, pre-A3-commit)

```
bun scripts/check-complexity.ts --list        (strict limit 20)
  over 20    252 functions in 218 files   <- recorded in scripts/baselines/complexity-baseline.json
  over 60     25   (23 src, 1 bin, 1 scripts)  <- THIS DRAIN
  worst      155   src/agents/acp/parser.ts parseAcpxJsonLine
biome.json cap: 170
batches: 4 of 25 done (P0, A1, A2, A3)
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
| A4 | todo | 107 | CLI `run` action | `bin/nax.ts:245` | 1948 (size-gated) | 37 / 21 | none |
| A5 | todo | 93 | hop callback | `src/operations/build-hop-callback.ts:191` | 599 | 33 / 19 | yes |
| A6 | todo | 91 | `callOpDispatch` | `src/operations/call.ts:80` | 591 | 33 / 17 | yes |
| A7 | todo | 74 | `resolveCodingToolSupport` | `src/agents/coding-tool-support.ts:307` | 601 | 44 / 18 | yes |
| A8 | todo | 127 | `pathsBranch` | `src/tools/policy.ts:429` | 601 | 26 / 16 | yes |
| A9 | todo | 71 | `handleRunCompletion` | `src/execution/lifecycle/run-completion.ts:111` | 563 | 22 / 18 | none |
| A10 | todo | 83 | `runFixCycle` | `src/findings/cycle.ts:72` | 544 | 16 / 12 | yes |
| A11 | todo | 70 | `runNonBlockingFix` | `src/execution/non-blocking-fix.ts:230` | 492 | 17 / 13 | yes |
| A12 | todo | 73 | `collectNeighbors` | `src/context/engine/providers/code-neighbor.ts:264` | 498 | 17 / 11 | yes |
| A13 | todo | 99 | `callTool` | `src/tools/runtime.ts:318` | 557 | 31 / 8 | yes |

Ordered by fix commits, then by how central the function is to a run. A1 goes first
because it has the worst ratio (25 of 30 commits are fixes) and sits on every story's path
- but its file is size-gated at 704, so the batch must *also* bring the file down. A1 and
A4 are the two most likely to need more than one session; if so, split them per §8.

### Wave B - moderate churn (one function per batch)

| Batch | Status | Score | Function | File:line | Lines | Churn / fix | test |
|:--|:--|---:|:--|:--|---:|:--|:--|
| B1 | todo | 96 | `decideStageAction` | `src/execution/post-run.ts:275` | 534 | 14 / 7 | none |
| B2 | todo | 76 | `sendTurn` | `src/agents/acp/adapter.ts:239` | 455 | 15 / 7 | yes |
| B3 | todo | 155 | `parseAcpxJsonLine` | `src/agents/acp/parser.ts:88` | 388 | 6 / 5 | yes |
| B4 | todo | 73 | `runDeferredRegression` | `src/execution/lifecycle/run-regression.ts:205` | 587 | 10 / 6 | yes |
| B5 | todo | 63 | `runParallelBatch` | `src/execution/parallel-batch.ts:122` | 417 | 9 / 5 | yes |
| B6 | todo | 66 | `displayFeatureDetails` | `src/cli/status-features.ts:329` | 503 | 6 / 4 | yes |
| B7 | todo | 69 | `runSession` | `src/interaction/ask-link.ts:291` | 560 | 5 / 1 | yes |

### Wave C - stable, mostly pure (grouped)

| Batch | Status | Score | Function | File:line | Lines | Churn / fix | test |
|:--|:--|---:|:--|:--|---:|:--|:--|
| C1 | todo | 110 | `validateConfig` | `src/config/validate.ts:30` | 175 | 4 / 0 | yes |
| C1 | todo | 78 | `deepMergeConfig` | `src/config/merger.ts:41` | 173 | 2 / 2 | none |
| C2 | todo | 75 | `parseFrontmatter` | `src/context/rules/rules-frontmatter.ts:110` | 293 | 5 / 2 | yes |
| C2 | todo | 72 | `coerceVerdict` | `src/tdd/verdict-reader.ts:98` | 319 | 4 / 4 | none |
| C2 | todo | 64 | `parseTestFailuresDetailed` | `src/test-runners/ac-parser.ts:50` | 141 | 4 / 3 | none |
| C3 | todo | 93 | `lexBashCommand` | `src/permissions/bash-lex.ts:78` | 248 | 3 / 2 | yes |
| C4 | todo | 99 | `generateCommand` | `src/cli/generate.ts:49` | 267 | 1 / 1 | none |
| C4 | todo | 79 | `main` | `scripts/report-test-consolidation.ts:293` | 485 | 3 / 1 | none |

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
