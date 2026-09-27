# Cognitive-complexity drain - status

The live doc for draining the functions whose Biome cognitive-complexity score is over
**60**, so `biome.json`'s `noExcessiveCognitiveComplexity` cap can drop from **170 to 60**.

Same shape as `STATUS-test-consolidation-drain.md` and its siblings: **section 0 is the
live state and is re-measured, never carried forward. Section 9 is append-only.**

Written for handover to an implementer with no prior context. Every task names the
function, the constraints that will bite, and the command that proves it worked.

---

## 0. Current state - measured 2026-09-27 @ `11ba0ef9a` (chore/complexity-ratchet)

```
bun scripts/check-complexity.ts --list        (strict limit 20)
  over 20    255 functions in 221 files   <- recorded in scripts/baselines/complexity-baseline.json
  over 40     67
  over 60     29   (27 src, 1 bin, 1 scripts)  <- THIS DRAIN
  over 100     7
  worst      170   src/prd/schema-story.ts validateStory
biome.json cap: 170
```

Re-measure with `bun scripts/check-complexity.ts --list | awk '$1 > 60'`.

---

## 1. Goal, and what "done" means

- **Done** = zero functions over 60, and `biome.json` `maxAllowedComplexity` set to 60 in
  the same PR as the last refactor.
- **Not the goal:** getting any function to 20. The ratchet (`check:complexity`) already
  holds *new* code to 20. This drain is about the 29 functions where complexity is
  concentrated — most of them sit in the files with the most fix commits.
- After 60, the next milestone is 40 (38 more functions). Decide on it after this drain's
  §9 log shows what a refactor actually cost; do not start it by default.

## 2. Rules for every task (each one exists because a gate will catch you)

1. **Behaviour-preserving only.** A refactor PR changes structure, never behaviour. If you
   find a bug while refactoring, file it or fix it in a separate commit with its own test.
2. **Characterise before you cut.** Functions marked `test: none` in §4 have no mirror test
   file at the heuristic path. Before refactoring, find what exercises them
   (`grep -rn <functionName> test/`). If nothing pins the branches you are moving, add
   characterisation tests first, in their own commit, green against the *unrefactored* code.
3. **Extracted helpers must score <= 20.** `check:complexity` treats a helper split out of
   a baselined function as new code: an extra over-20 function in a baselined file is
   "grown", and one in a new file is "added". If a helper genuinely cannot get under 20,
   hand-edit the baseline in the same PR and justify it in the §9 entry. The file's total
   must still go down.
4. **File-size gate: extract to a sibling file, not in place.** 13 of the 29 files are
   within 100 lines of the 600-line limit, and `unified-executor.ts` (704) and `bin/nax.ts`
   (1948) are grandfathered and may not grow by one line. Splitting a function into helpers
   in the same file usually adds lines. Run `bun x biome check --write <file>` and **then**
   `wc -l` — Biome re-wraps, so the pre-format count is wrong.
5. **Lock the gain in.** After the refactor, `bun run check:complexity` fails with
   "baseline is stale" until you run `bun run check:complexity:update`. Commit the baseline
   change in the same PR.
6. **One function per PR** for Wave A and B. Wave C items (pure functions) may be batched
   two or three per PR.

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

## 4. The 29 functions

Churn and fix counts are **per file**, last 90 days (`git log --since=90.days`), so treat
them as a strong hint, not proof. `test` = a mirror test file exists at `test/unit/<path>`.

### Wave 0 - pilot (1 PR): calibrate the process on a pure, stable function

| Score | Function | File:line | Lines | Churn / fix | test |
|---:|:--|:--|---:|:--|:--|
| 170 | `validateStory` | `src/prd/schema-story.ts:68` | 525 | 4 / 0 | none |

Pure, no I/O, zero fix commits, and the single worst score. Record in §9 how long it took
and what the helpers scored; use that to size Waves A-C.

### Wave A - hot and defect-prone (one PR each, in this order)

| Score | Function | File:line | Lines | Churn / fix | test |
|---:|:--|:--|---:|:--|:--|
| 165 | `executeUnified` | `src/execution/unified-executor.ts:60` | 704 (size-gated) | 30 / 25 | none |
| 97 | `runNativeTurn` | `src/agents/native/session/turn-loop.ts:72` | 484 | 42 / 18 | none |
| 101 | `run` (ExecutionPlan) | `src/execution/story-orchestrator/execution-plan.ts:70` | 596 | 20 / 16 | none |
| 107 | CLI `run` action | `bin/nax.ts:245` | 1948 (size-gated) | 37 / 21 | none |
| 93 | hop callback | `src/operations/build-hop-callback.ts:191` | 599 | 33 / 19 | yes |
| 91 | `callOpDispatch` | `src/operations/call.ts:80` | 591 | 33 / 17 | yes |
| 74 | `resolveCodingToolSupport` | `src/agents/coding-tool-support.ts:307` | 601 | 44 / 18 | yes |
| 127 | `pathsBranch` | `src/tools/policy.ts:429` | 601 | 26 / 16 | yes |
| 71 | `handleRunCompletion` | `src/execution/lifecycle/run-completion.ts:111` | 563 | 22 / 18 | none |
| 83 | `runFixCycle` | `src/findings/cycle.ts:72` | 544 | 16 / 12 | yes |
| 70 | `runNonBlockingFix` | `src/execution/non-blocking-fix.ts:230` | 492 | 17 / 13 | yes |
| 73 | `collectNeighbors` | `src/context/engine/providers/code-neighbor.ts:264` | 498 | 17 / 11 | yes |
| 99 | `callTool` | `src/tools/runtime.ts:318` | 557 | 31 / 8 | yes |

Ordered by fix commits, then by how central the function is to a run. `executeUnified`
goes first because it has the worst ratio (25 of 30 commits are fixes) and sits on every
story's path — but it is size-gated at 704, so the PR must *also* bring the file down.

### Wave B - moderate churn

| Score | Function | File:line | Lines | Churn / fix | test |
|---:|:--|:--|---:|:--|:--|
| 96 | `decideStageAction` | `src/execution/post-run.ts:275` | 534 | 14 / 7 | none |
| 76 | `sendTurn` | `src/agents/acp/adapter.ts:239` | 455 | 15 / 7 | yes |
| 155 | `parseAcpxJsonLine` | `src/agents/acp/parser.ts:88` | 388 | 6 / 5 | yes |
| 73 | `runDeferredRegression` | `src/execution/lifecycle/run-regression.ts:205` | 587 | 10 / 6 | yes |
| 63 | `runParallelBatch` | `src/execution/parallel-batch.ts:122` | 417 | 9 / 5 | yes |
| 66 | `displayFeatureDetails` | `src/cli/status-features.ts:329` | 503 | 6 / 4 | yes |
| 69 | `runSession` | `src/interaction/ask-link.ts:291` | 560 | 5 / 1 | yes |

### Wave C - stable, mostly pure (may batch 2-3 per PR)

| Score | Function | File:line | Lines | Churn / fix | test |
|---:|:--|:--|---:|:--|:--|
| 110 | `validateConfig` | `src/config/validate.ts:30` | 175 | 4 / 0 | yes |
| 93 | `lexBashCommand` | `src/permissions/bash-lex.ts:78` | 248 | 3 / 2 | yes |
| 78 | `deepMergeConfig` | `src/config/merger.ts:41` | 173 | 2 / 2 | none |
| 75 | `parseFrontmatter` | `src/context/rules/rules-frontmatter.ts:110` | 293 | 5 / 2 | yes |
| 72 | `coerceVerdict` | `src/tdd/verdict-reader.ts:98` | 319 | 4 / 4 | none |
| 64 | `parseTestFailuresDetailed` | `src/test-runners/ac-parser.ts:50` | 141 | 4 / 3 | none |
| 99 | `generateCommand` | `src/cli/generate.ts:49` | 267 | 1 / 1 | none |
| 79 | `main` | `scripts/report-test-consolidation.ts:293` | 485 | 3 / 1 | none |

`lexBashCommand` is security-relevant (it feeds the permission decision). Its PR needs
the command-safety corpus eval (`scripts/command-safety-eval.ts`) run before and after, not just unit tests.

## 5. Per-PR checklist

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
```

Then append a §9 entry: function, score before -> after, helper scores, file lines before
-> after, anything surprising.

## 6. When to stop

- A Wave A refactor needs a behaviour change to get under 60: stop, file it, move on.
- A function's score only drops by moving complexity into helpers that fail §2.3 and §3's
  parameter rule: it is not ready — leave it, note why in §9.
- The pilot takes more than roughly two sessions: re-plan Waves A-C before continuing.

## 9. Log (append-only)

### 9.0 - 2026-09-27, ratchet landed (`11ba0ef9a`)

`scripts/check-complexity.ts` runs the rule at 20 against a per-file baseline
(`scripts/baselines/complexity-baseline.json`, 255 functions / 221 files). `biome.json`
cap 176 -> 170. This doc written against that commit.
