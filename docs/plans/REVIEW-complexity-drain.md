# Branch review: `chore/complexity-ratchet` (cognitive-complexity drain, cap 170 -> 60)

- **Reviewed:** 2026-09-28
- **Scope:** whole branch against merge base `50be4feb` with `origin/main`. That is 60 commits and 98 files (+22,374 / -7,823).
- **Plan under review:** `docs/plans/STATUS-complexity-drain.md`, batches P0, A1-A13, B1-B7 and C1-C4.
- **Method:**
  - For every one of the 29 refactored functions, I compared the original at `<refactor-sha>^` with HEAD, block by block.
  - I checked the characterisation tests against what they claim to pin.
  - I checked the §9 log claims against the code.
  - I ran the repo gates.
  - For the permission lexer (C3), I also ran old and new side by side.

---

## Verdict

**The branch is in good shape. 28 of the 29 refactors are behaviour-preserving.**

Items 1-2 and 3-4 are the ones to act on; none of them blocks a PR:

| # | Item | Severity | Suggested action |
|---|------|----------|------------------|
| 1-2 | A1 (`executeUnified`) has two small behaviour changes, which breaks §2 rule 1 | Low | Record them in §9, and either revert or fix them properly |
| 3-4 | The ratchet gate has two ways past it | Medium | Close them before any "cap 40" milestone |
| 5 | A pre-existing cost under-reporting bug was carried over but not logged | Low | Record it in §9 and file it |
| — | Rule violations, weak tests, stale comments and §9 inaccuracies | Nit | Optional cleanup |

---

## Gate results at HEAD (`14edda8d`)

| Gate | Result |
|------|--------|
| `bun run typecheck` | pass |
| `lint:biome` + `check:all-without-biome` | pass |
| `bun run check:complexity` | pass: "227 baselined functions over 20 in 199 files", which matches §0 |
| `bun run test` | 20,695 pass, 5 fail (environmental, see below) |
| `bun run test:coverage` | stopped on 12 test failures before measuring coverage, so the per-file floor was **not checked here** |

**Environmental failures.** Of the 12 tests that failed under `test:coverage`, 11 fail identically at the merge base (`50be4feb`). These are:

- `bash-deny-suite` AC6-8
- `progress` BUG-09
- `migrate` non-EXDEV
- `queue-handler` rename/unlink
- `spawn-client` env

The container runs as root, so tests that simulate "permission denied" cannot fail. It also has Bun 1.3.11 installed instead of the pinned 1.4.0. The 12th test, the idle-watchdog US-004 AC5, passes when run on its own on both trees.

**CI needs to confirm the coverage gate.**

**Biome cap.** `biome.json` `maxAllowedComplexity` is 60, and none of its overrides exempt any files from the complexity rule. The worst remaining functions score 59:

- `src/pipeline/stages/acceptance.ts`
- `src/agents/native/session/turn-tool-batch.ts`

---

## 1. Behaviour changes (A1 `executeUnified`, commit `e971d0ca`)

I checked both of these in the code.

### 1.1 The pre-check skip path now uses the updated PRD (risk, low)

- **Where:**
  - `src/execution/unified-executor-dispatch-phases.ts:169-175` (sequential)
  - `src/execution/unified-executor-parallel-dispatch.ts:360-373` (single story in parallel mode)
- **Old code:** it set only `prdDirty = seqPre.prdDirty; continue;`, and the local `prd` kept its pre-check value.
- **New code:** it returns `state: { prd: seqPre.prd, … }`, so `prd` becomes the updated one (`singlePre.prd` in the parallel file).
- **When it shows:** the real `preIterationTierCheck` always returns `prdDirty: true` on a skip, so the next iteration reloads from disk and hides the difference. The difference only shows when the skip happens on the **last allowed iteration**.
  - Before: `buildResult("max-iterations").prd`, and the acceptance step's `prd`/`stories`, received the old PRD, with the story not yet marked escalated or failed.
  - Now: they receive the PRD that matches disk.
- **Assessment:** arguably a fix. But §2.1 says to record such a change, not make it inside the batch, and §9.2 claims the refactor is "traceable line-for-line". No test covers a skip on the last iteration.

### 1.2 The heartbeat can write the previous cost (risk, low)

- **Where:** `src/execution/unified-executor.ts:102-107`
- **Old code:** `startHeartbeat(…, () => totalCost, …)` read a local variable that was updated straight after `runIteration` / `runParallelBatch` returned.
- **New code:** it reads `state.totalCost`, and `state` is only replaced when the phase helper returns. The helper returns *after* `ctx.statusWriter.update(totalCost, iterations)` and after `runIterationDelay` (the configured `iterationDelayMs`).
- **Failure scenario:** a heartbeat tick (60s interval) lands in that window of a few seconds. It writes the previous iteration's cost to the status file, overwriting the correct value that `statusWriter.update` has just written. The value stays wrong until the next tick. `iterations` is unaffected.

---

## 2. Ratchet gate: `scripts/check-complexity.ts`

### 2.1 Comparing by rank lets a specific function get worse (risk, medium)

- **Where:** `compareToBaseline` / `withinBaseline`, `scripts/check-complexity.ts:144-159`
- **What:** a file's scores are compared position by position (highest first), not per function. So the "known blind spot" in the header, "a different new function lands on exactly the same score", is much wider than the header says.
- **Cases reproduced by calling `compareToBaseline` directly:**

  | Baseline | Current | Real-world cause | Result |
  |----------|---------|------------------|--------|
  | `[80, 30]` | `[79, 25]` | function A goes 80 -> 25 while function B goes 30 -> 79 | "lowerable", not "grown" |
  | `[80, 30]` | `[30, 30]` | the 80 is split into a caller under 20 plus a **new** 30-point helper | "lowerable", not "grown" |

- **Consequences:**
  - In both cases `--update-baseline` accepts the new scores as a "lower".
  - The header comment ("Any other combination is caught", and "No baselined file may gain an over-limit function") is wrong.
  - §2 rule 3 ("a helper split out of a baselined function … is 'grown'") is also wrong.
- **Impact on this branch:** none. Biome was run on the old and new versions of all six changed files that have more than one baselined function. Each remaining score belongs to the original function, for example `displayAllFeatures` 37 and `buildCodingToolSupport` 38.
- **Fix options:**
  - Key the baseline by function name as well as score.
  - Or: when a file's multiset of scores changes other than by removing or lowering entries, require any new score to be at or below 20.

### 2.2 A suppression comment hides a function completely (risk, medium)

- **What:** Biome honours `// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: …` (and `biome-ignore-all`) under the script's strict config too.
- **Reproduced:** I added the comment above `pathsBranch` (score 127) in a copy of the old `policy.ts`. Biome then reported only the file's other functions (23 and 29), the summary count still matched, and `parseScores` accepted the result.
- **Consequences:**
  - A new file with an over-limit function passes silently.
  - In a baselined file, the hidden function reads as "lowerable", and `--update-baseline` locks the lower score in.
  - The same comment also escapes biome's own cap of 60.
- **Today:** there are zero such comments in the repo, and nothing prevents the first one.
- **Fix:** have the script (or a `check:*` script) grep `src/ bin/ scripts/` for that suppression and fail on it.

### 2.3 Nits

- **"no JSON report (exit 0)" was an environment issue.** It appeared only while `node_modules` wasn't installed. In that state `bun x biome` fetched the unrelated npm package `biome` (an env-var manager, v0.3.3), which exits 0 and triggers the punycode warning. The script correctly refused to pass. `bun x @biomejs/biome` or `node_modules/.bin/biome` would fail with a clearer error, and `lint:biome` has the same pattern.
- **A file rename fails as "added".** Fixing it needs a hand edit of the baseline, because `--update-baseline` refuses. This fails safe but isn't documented.
- **`--init-baseline` is undocumented.** It also runs when the baseline is corrupt, not only when it is missing, and it isn't in the usage block.

---

## 3. A pre-existing bug the refactor kept but §9 doesn't record

**The `runFixCycle` validator-error exit under-reports cost.**

- **Where:** `src/findings/cycle-execute.ts:340-356`
- **What:** when full validation exhausts its retries, the cycle returns `costUsd: state.totalCostUsd` **without the current iteration's strategy spend**. It also skips `recordIteration`.
- **Scenario:** a strategy spends $0.50, then the validator throws on every retry. The result reports $0 for that iteration and keeps no record of it.
- **Status:** the refactor preserved this exactly (A10, `55a5ef6c`). It is the same under-reporting class as #1369. The only test (`cycle.test.ts:387`) asserts `exitReason` alone.
- **Action:** per §2.1, record it in §9 and file it. A10 had no characterisation commit, and this exit is the one branch that §9.11's "the mirror suites pin every branch" does not cover.

---

## 4. Rule violations

**Functions with more than 3 positional parameters** (repo rule: 3 or fewer, options object beyond that):

| Function | File | Params |
|---|---|---|
| `handleParallelBatchFailures` | `src/execution/unified-executor-parallel-dispatch.ts:47` | 5 |
| `reportPackageResults(frame, pkgDir, results, displayDir)` | `src/cli/generate.ts:78` | 4 |
| `runGroupReport(argv, rows, groups, stats)` | `scripts/report-test-consolidation.ts:439` | 4 |
| `describeGateRegressionNow` | `src/execution/story-orchestrator/execution-plan-phases.ts:58` | 4 (3 as a method before) |

**Helpers that fill a caller's array.** These are small and private, but they match §3's "mutable bag" shape:

- `extractStages(…, warnings)` (`rules-frontmatter.ts:228`)
- `collectReviewCriteria`, `mergeTopLevelCriteria` (`verdict-reader.ts:163`, `:186`)

`CycleLoopState` (`cycle-loop.ts:62`), `HopClosureState`, `RunRetryState` and `RectificationState` are deliberate mutable state objects. They are documented as persistent loop or closure state, not the §3 "fake fix".

---

## 5. Dead code, duplication, lost or stale comments

- **Lost design comments (P0, `784e9c78`).** Checked. These were dropped from `schema-story.ts` and are not in `schema-story-fields.ts`:
  - the nax#2125 repo-rooted-frame contract on `workdir`/`contextFiles`/`expectedFiles` (3 places, including the pointer to `findNonCanonicalDeclaredPaths`);
  - the `modifiedFiles` note about `### Modifies` and hand-edited prd.json.

  This contradicts the new module header's claim that "only the location changed".
- **Dead field:** `PathCheckFrame.grant` (`src/tools/policy-paths-branch.ts:199`) is set but never read.
- **Redundant check:** `src/execution/post-run-decide-action.ts:130` checks again a condition the caller has already checked through `hasRectificationExhaustion`.
- **Duplication:**
  - `hasUsablePackageDir` exists (`coding-tool-support-resolve.ts:126`), but `loadPackageEffectiveConfig` writes the same condition out again inline at `:149-150`.
  - The advisory log in `post-run-decide-action.ts` (about line 150) builds its sources Set inline instead of calling `collectFindingSources`.
- **Misplaced doc comment:** the large doc comment for `collectNeighbors` (`code-neighbor.ts:168-213`) now sits above `interface CollectNeighborsInput`, so it documents the interface.
- **Meaningless comment:** `unified-executor.ts:269` says "Defined after executeUnified so story:started precedes runParallelBatch in source order". Those strings now live in other files.
- **Stale line references in test comments:**
  - `non-blocking-fix-wiring.test.ts:344` and `story-scoped-fix-budget.test.ts:361` cite line numbers in `execution-plan.ts`.
  - `validate.test.ts` cites "line 152 … `config.models[defaultAgentKey]`". That code is now in `checkComplexityRouting` in `validate-fields.ts`, and the variable is `defaultAgent`.
- **Inconsistent numbering:** the phase doc comments in `parallel-batch-phases.ts` are numbered unevenly.
- **Wrong line count in comments:** `execution-plan-phases.ts:473` and `execution-plan-verdict.ts:5` say the first extraction "landed at 625 lines". It was 684 (625 is A1's number).
- **Types (nits):**
  - `runBakeoffMode` (`bin/run-action-execute.ts:101`) is typed `Promise<void>` but always calls `process.exit`. `Promise<never>` would state what `bin/nax.ts` relies on.
  - `RunConfig = NaxConfig` is an alias that adds nothing.
  - `mergeHooks`/`mergeConstitution` take `unknown` and cast straight to `Record<string, unknown>`, although the caller has already narrowed them.
- **Array handling:** `turn-loop-round-trip.ts:379` builds a new messages array on followUp, where the old code pushed onto the existing one. This only matters to a `before_turn_end` handler that keeps the array reference, and none does today.

---

## 6. Tests that don't pin what they claim

| Test | Gap |
|---|---|
| `test/unit/prd/schema-story.test.ts`, `test/unit/config/validate.test.ts` | Only one invalid field per case, so **nothing pins error order**, although `validate.ts:34` says "evaluated in this order". A single `toEqual([...])` on an input with several invalid fields would fix it. |
| `test/integration/cli/cli-run-preflight.test.ts` (and the `bin/run-action.ts:7` header) | Claims gate ORDER is pinned, but only two orderings are tested (`-m` before `--plan`, `--parallel` before `--schedule`). Swapping bake-off preflight and schedule/plan, feature name and directory, or `-m` and `--parallel` would still pass. The plan phase, contestant validation, `--max-cost` and the schedule wait have no characterisation. |
| `test/unit/agents/acp/parser-line-edges.test.ts:136-148` | §9.17(e) says an unknown `sessionUpdate` "falls through to result/error handling". Neither test line carries `id`/`result`/`error`, so the fall-through is not pinned. |
| `test/unit/operations/build-hop-callback-branches.test.ts:279` | Only asserts `not.toBe("original prompt")`. `toContain("## Rebuilt context")` would pin the swap handoff itself. |
| `test/unit/cli/status-features-details-edges.test.ts` | Every assertion is `toContain`, so section order is not pinned. The line-131 case ("Skipped only when non-zero") never checks that the line is absent when the count is zero. |
| `unified-executor-signature.test.ts` AC-7 | "The first cost-limit after the batch" would still pass if the post-batch check were deleted, because a later match exists. The weakness is pre-existing, but the comment claim is false. |
| `runner-parallel-metrics-rectification-events.test.ts:507` | The legacy `runParallelExecution` ban still scans only `unified-executor.ts`, not the two new sibling files that now hold the dispatch code. |
| `run-completion-edges.test.ts` header item 5 | Claims to pin the "no-retention no-op", but the test covers the schema-default case instead. §9.10 calls the no-op branch unreachable. |
| `test/unit/agents/acp/adapter-send-turn-edges.test.ts:80-110` | Depends on real time: a 100ms deadline against a 300ms sleep. The margin is comfortable. |
| `parallel-batch-edges.test.ts:419-446` | The "real dep defaults" tests rely on the file-level `beforeEach` snapshot of `_parallelBatchDeps` holding the real implementations. They would quietly lose value if another file ever leaked a stub. |

**`_deps` hygiene is otherwise good.** Every new or changed test file on the branch restores what it overrides: `afterEach` with saved originals, `Object.assign(deps, saved)`, or `mock.restore()` for `spyOn`. `14edda8d` correctly fixed the one leak: `code-neighbor.test.ts` saved its "originals" in `beforeEach`, so a stub leaked by an earlier file was treated as the original.

---

## 7. Inaccuracies in the §9 log

| Entry | Claim | Actual |
|---|---|---|
| §9.2 (A1) | "traceable line-for-line", "no dispatch rule changed" | See findings 1.1 and 1.2 |
| §9.4 (A3) | "a real bug caught while writing the extraction" | It was a regression introduced during the extraction and fixed before commit, not a pre-existing defect |
| §9.4 (A3) | stage count | Says "five stages", lists seven, then "extracted the six stages" |
| §9.11 (A10) | the mirror suites "pin every branch" | The validator-error exit's cost and iteration log are unpinned (finding 3) |
| §9.11 (A10) | `cycle-execute.ts` 416 lines | 415 |
| §9.13 (A12) | characterisation green under `bun run test` "all phases" | True locally; the `_deps` leak showed up only in CI's file order (fixed by `14edda8d`) |
| §9.17 (B3) | item (e): fall-through to result/error | True of the code, but not pinned by a test |
| §9.18 (B4) | sibling "landed at 530 lines" | 546 in `e9caa8e5` and at HEAD |
| §9.22 (C1) | 15 existing mirror tests, 20 characterisation tests added | 19 existing; 16 added (13 call sites with two `test.each`). The file now runs 35 |
| §9.26 (C3) | corpus eval before/after byte-identical | True, but the default rule scorer doesn't call `lexBashCommand`, so it is weak evidence. The side-by-side harnesses are the real proof |
| — | `14edda8d` | No §9 entry. The lesson is that a `beforeEach` snapshot of `_deps` is poisoned by another file's leak |

§0's figures are accurate: 227 functions, 199 files, worst 59, cap 60, 25 of 25 batches.

---

## 8. Verified clean, per batch

| Batch | Function | Notes |
|---|---|---|
| P0 | `validateStory` | Extractor order, error codes and messages, `seenIds.add` timing and key order of the returned story all preserved (comments lost, see §5) |
| A1 | `executeUnified` | See findings 1.1 and 1.2. The 7 test edits only repoint source-text assertions; none hides a runtime change |
| A2 | `runNativeTurn` | State changed in place in the round-trip loop, so the catch sees the latest messages. Compaction guards are in the same order. The `@nathapp/nax-ai` import stays inside `src/agents/native/` |
| A3 | `ExecutionPlan.run` | Loop `continue`/`break`, post-rectification resume, non-blocking-fix guard, verdict and `failedPhases` carve-out all match. `phaseCosts`/`phaseOutputs` are the same objects throughout |
| A4 | CLI `run` action | Same gate order, exit codes and messages. The SIGINT once/remove, BUG-22/BUG-51 unmounts and every await are preserved |
| A5 | hop callback | `HopClosureState` reads and writes happen in the original order. `endpoint` is undefined in the same case. The #1794 early return is intact. `config`/`pipelineStage` are still passed. The `hop-endpoint.ts` change is comment-only |
| A6 | `callOpDispatch` | Prologue order and both retry loops are identical. `_callOpDeps` is passed by reference, so test seams still work |
| A7 | `resolveCodingToolSupport` | Side effects in the same order. The `NaxConfig` cast allow-list entry moved without being widened |
| A8 | `pathsBranch` | **No decision became more permissive.** `confineTo` check first, then resolve, out-of-root deny with breach, rules, globs. The `enforcePathGlobs` vs `restrictPaths` asymmetry is kept, and denial texts are identical |
| A9 | `handleRunCompletion` | Side-effect order unchanged, from the regression gate through to the final status |
| A10 | `runFixCycle` | Each `continue`/`return` maps onto a verdict. `liteValidateIfExhausted` building history later is equivalent |
| A11 | `runNonBlockingFix` | Exit order, log payloads and the in-place restore of phase outputs/costs are preserved |
| A12 | `collectNeighbors` | Phase order, labelled `break outer`, truncation flag and sibling-hint position are preserved |
| A13 | `callTool` | Shadow-tap point, ask resolution (signal precedence, abort re-check), denial redirect order and audit payloads are identical |
| B1 | `decideStageAction` | Branch precedence unchanged. `tddFailureCategory` is still written first |
| B2 | `sendTurn` | Deadline is created before the pre-abort return. The session is re-read each iteration, and `continue`/`break` outcomes match |
| B3 | `parseAcpxJsonLine` | Drift guard first. JSON-RPC and legacy chains, applier order and first-error-wins behaviour preserved |
| B4 | `runDeferredRegression` | The #2201 rectification loop is intact (`dispose()` still in `finally`). The seven result shapes are identical field for field. `8a3fa92e` (logger reset) is legitimate test isolation |
| B5 | `runParallelBatch` | Sequential phases, the only `allSettled` step, `buildFailedList` after merge, and BUG-37/BUG-60 timing and cost all preserved |
| B6 | `displayFeatureDetails` | Section bodies are byte-identical and in the same order |
| B7 | `runSession` | Both try/finally blocks and the outer finally statement order are preserved. `settleWaiters` matches all four original loops |
| C1 | `validateConfig`, `deepMergeConfig` | Error array order and the `models: undefined` TypeError quirk are preserved. Clone-then-mutate is unchanged, and so is `DANGEROUS_MERGE_KEYS` |
| C2 | `parseFrontmatter`, `coerceVerdict`, `parseTestFailuresDetailed` | Validation order, regexes and messages are identical. Per-framework matcher order is the same ("unknown" is bun, go, pytest, jest) |
| C3 | `lexBashCommand` | **Old and new agree on 1,708,597 inputs:** every string up to length 5 over a 17-char shell alphabet, plus 200k random strings of length 6-15, with zero differences. The corpus eval is byte-identical (AUROC 0.877, catch 0.754) |
| C4 | `generateCommand`, `report-test-consolidation` `main` | Branch order, messages and exit modes are preserved. `.sort()` became an explicit comparator with the same order |

---

## 9. Suggested follow-ups, in priority order

1. **A1:** add a §9 note for findings 1.1 and 1.2. For 1.2, either keep a live `totalCost` accessor, or write `state` back before `statusWriter.update` and the delay. For 1.1, keep the new behaviour deliberately (with a test for a skip on the last iteration) or restore the old one.
2. **Gate:** close 2.1 (per-function identity, or require any new score to be at or below 20) and 2.2 (fail on the complexity suppression comment). Fix the header comment and §2.3 in the same change.
3. **Log finding 3** in §9 and file it as an issue.
4. Convert the four functions with more than 3 positional parameters to options objects.
5. Restore the P0 design comments and remove the dead or duplicate code in §5.
6. Tighten the tests in §6, starting with error order and the preflight gate order.
7. Correct the §9 entries in §7, and add a §9 entry for `14edda8d`.
