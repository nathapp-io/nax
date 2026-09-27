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

## 0. Current state - measured 2026-09-27 @ `9dd73572d` (chore/complexity-ratchet)

```
bun scripts/check-complexity.ts --list        (strict limit 20)
  over 20    255 functions in 221 files   <- recorded in scripts/baselines/complexity-baseline.json
  over 40     67
  over 60     29   (27 src, 1 bin, 1 scripts)  <- THIS DRAIN
  over 100     7
  worst      170   src/prd/schema-story.ts validateStory
biome.json cap: 170
batches: 0 of 25 done
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
| P0 | todo | 170 | `validateStory` | `src/prd/schema-story.ts:68` | 525 | 4 / 0 | none |

Pure, no I/O, zero fix commits, and the single worst score. Record in §9 how long it took
and what the helpers scored; use that to size the rest (see §6).

### Wave A - hot and defect-prone (one function per batch)

| Batch | Status | Score | Function | File:line | Lines | Churn / fix | test |
|:--|:--|---:|:--|:--|---:|:--|:--|
| A1 | todo | 165 | `executeUnified` | `src/execution/unified-executor.ts:60` | 704 (size-gated) | 30 / 25 | none |
| A2 | todo | 97 | `runNativeTurn` | `src/agents/native/session/turn-loop.ts:72` | 484 | 42 / 18 | none |
| A3 | todo | 101 | `run` (ExecutionPlan) | `src/execution/story-orchestrator/execution-plan.ts:70` | 596 | 20 / 16 | none |
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
