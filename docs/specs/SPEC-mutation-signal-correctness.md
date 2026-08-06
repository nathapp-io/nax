# SPEC: Mutation Spot-Check Signal Correctness

<!-- spec-writing: completed-through-phase-6 -->

## Summary

Make the mutation spot-check gate produce an honest, visible signal. Today it reports a false all-clear: on the default `maxMutants: 3` for TypeScript, all three mutants are corrupted `import` paths, each fails module resolution, and each is classified `killed` — so the gate claims the tests are strong while never having executed a meaningful mutation. This spec whitespace-guards the arithmetic operators so string literals and module specifiers stop producing mutants, replaces first-N-in-file-order mutant selection with deterministic even-spread sampling across all changed files, teaches the classifier to distinguish "the tests ran and caught it" from "nothing ran at all", and surfaces surviving mutants at run end so a survivor is no longer invisible.

## Motivation

`execution.mutationCheck` shipped in PR #1305 with polyglot operators added in PR #1349. A gap analysis on 2026-08-06 against `91c100b3` found the gate inert-by-construction on its default configuration, for the language nax itself is written in. Four findings drive this spec:

**G4 — arithmetic operators have no string or comment awareness.** `ARITHMETIC_PAIRS` in `src/verification/mutation/operators.ts` flips `+ - * /` anywhere on a line. `src/verification/mutation/mutator.ts` skips only lines whose trimmed start is a comment prefix. Nothing protects string literals, so every relative module specifier is a mutation site. Probing `generateMutants` against `src/operations/mutation-check.ts` produced 32 mutants, of which the first three were:

```
L16 [ts:arith-flip]  import {...} from "../config";           →  from "..*config";
L17 [ts:arith-flip]  import type {...} from "../config/selectors";  →  "..*config*selectors";
L18 [ts:arith-flip]  import { getLogger } from "../logger";    →  from "..*logger";
```

The comparison operators were deliberately whitespace-guarded to avoid exactly this class of problem (`operators.ts:37-44` carries a comment explaining why). The arithmetic operators never received the equivalent treatment.

**G1 — the budget is spent on the top of the file.** `mutator.ts` walks source order and stops at the first `maxMutants` hits, and `mutation-check.ts` fills its budget from the first changed file before reaching the second. Every TS/JS file opens with an import block, so with G4 the default cap is exhausted before the mutator reaches executable code. A follow-up probe confirmed the whitespace guard alone removes all import-path noise — but the source-order bias remains: `src/execution/story-orchestrator/phase-eval.ts` yields 40 candidate lines and the cap still takes the first three.

**G2 — unbuildable mutants are classified `killed`.** The design names "compile error → `errored` → discarded" as its primary false-alarm guard. That guard does not exist in shipped code. A mutant that fails to compile or resolve produces no parseable test counts, so `analyzeTestExitCode` reports `passCount: 0, failCount: 0`; `isEnvironmentalFailure` requires `passCount > 0` and is therefore false; `src/verification/runners.ts` returns `TEST_FAILURE`; and `classifyMutant` maps `TEST_FAILURE` to `killed`. `errored` is reachable in practice only via `TIMEOUT`. The three-outcome design collapses to two, and it collapses toward silence — the failure mode a test-quality gate can least afford.

**G5 — surviving mutants have no consumer.** `MutationCheckOutput.survivors` is populated and returned, and a repo-wide search finds no reader outside the mutation module. It is not `findings`-shaped, so `extractPhaseFindings` skips it; the phase runner reads only `success`, which is hardcoded `true`; nothing reaches `status.json`, the run summary, or any telemetry. The only output is a `logger.warn`. A user must be reading raw logs, on an opt-in feature they enabled by hand, to ever learn a mutant survived.

G1, G2 and G4 form one chain — fixing any alone leaves the gate mute or dishonest. G5 is what makes the corrected signal reachable.

## Design

### Integration

All four changes extend existing code. Verified symbols and signatures:

| Symbol | Location | Current shape | Change |
|:---|:---|:---|:---|
| `ARITHMETIC_PAIRS` | `src/verification/mutation/operators.ts:105` | `ReadonlyArray<readonly [RegExp, string]>`, patterns `/\+/g`, `/-/g`, `/\*/g`, `/\//g` | Whitespace-guarded lookarounds |
| `COMPARISON_GT` / `COMPARISON_LT` | `src/verification/mutation/operators.ts:43-44` | `/(?<=\s)>(?!=)(?=\s|$)/g`, `/(?<=\s)<(?!=)(?=\s)/g` | Unchanged — the pattern to mirror |
| `generateMutants` | `src/verification/mutation/mutator.ts:29` | `(input: GenerateMutantsInput) => Mutant[]`; `max` field exists but the op never passes it | Drops the `max` early-break; selection moves out |
| `classifyMutant` | `src/verification/mutation/classify.ts:13` | `(result: VerificationResult) => MutantOutcome` | Reads `passCount`/`failCount` on the `TEST_FAILURE` arm |
| `VerificationResult` | `src/verification/types.ts:44` | Carries optional `passCount`, `failCount` | Unchanged — already populated on `TEST_FAILURE` (`runners.ts:98-107`) |
| `MutationCheckOutput` | `src/operations/mutation-check.ts:42` | `{ success: true; survivors: readonly SurvivingMutant[] }` | Gains `outcomes` counts |
| `mutationCheckOp.execute` | `src/operations/mutation-check.ts:66` | Accumulates mutants per file until the cap, then loops | Gathers all candidates, then selects |
| `NaxRuntime` | `src/runtime/index.ts:110` | Carries run-scoped per-story collectors (`adversarialIterations`, `semanticIterations`, `rectificationOscillations`, `quarantineMemo`) | Gains `mutationSummaries` |
| `runCompletionPhase` | `src/execution/runner-completion.ts:111` | `(options: RunnerCompletionOptions) => Promise<RunnerCompletionResult>`; DI via `_runnerCompletionDeps` | Emits the mutation summary |
| `outputAdvisoryFindingsSummary` | `src/execution/lifecycle/headless-formatter.ts:91` | No-ops on empty input and in `json` mode | The pattern to mirror for mutation output |

**Patterns followed.** The run-scoped collector on `NaxRuntime` keyed by `storyId` mirrors `adversarialIterations` / `semanticIterations` exactly. The run-end output path mirrors `outputAdvisoryFindingsSummary`, which already surfaces sub-threshold review findings that would otherwise live only in an on-disk trail — same problem, same shape of solution.

**Why the classifier, not the parser.** G2's most direct fix would sharpen `analyzeTestExitCode` in `src/test-runners/parser.ts`. That file is **590 lines** against the project's 600-line hard limit (`.nax/rules/project-conventions.md`), and it is shared by every gate in the system. The runner already attaches `passCount`/`failCount` to the `TEST_FAILURE` result, so `classifyMutant` (31 lines, used only by mutation) can make the distinction with no change to shared parsing and no risk to the limit.

**Why a new formatter file.** `src/log-format/formatter.ts` is 524 lines. The mutation summary formatter goes in a new `src/log-format/mutation-summary.ts` re-exported from the barrel, keeping both files inside the 600-line limit.

**Where the stdout write lives.** `.nax/rules/forbidden-patterns-source.md` bans `console.log` in `src/` in favour of the project logger. The headless output path is the established exception: `src/execution/lifecycle/headless-formatter.ts` already writes run-end blocks to stdout, because that output *is* the CLI's product rather than diagnostic logging. The mutation block goes in that same file, next to `outputAdvisoryFindingsSummary`, and nowhere else. `src/log-format/mutation-summary.ts` stays pure — it returns a string and writes nothing.

### Approach

**G4 — whitespace-guarded arithmetic.** Each arithmetic pattern requires whitespace on both sides, mirroring `COMPARISON_GT` / `COMPARISON_LT`: `+` becomes `/(?<=\s)\+(?=\s)/g`, and likewise for `-`, `*`, `/`. A real binary expression (`const idx = line - 1;`) is spaced by every formatter in use; a module specifier (`"../config"`), a URL, or a path fragment is not. This was probed against three real nax source files: arithmetic candidates fell from 32 to 0, 1, and 1 respectively, and the survivors were `const idx = line - 1;` and `const lineNumber = i + 1;` — genuine off-by-one mutations, exactly the class the gate exists to inject.

**G1 — even-spread selection.** A new exported `selectEvenlySpaced(mutants, max)` in `src/verification/mutation/select.ts` takes the full candidate list and returns `max` entries at a fixed stride (`stride = floor(length / max)`, indices `0, stride, 2*stride, …`). `generateMutants` loses its early-break so it returns every candidate for a file; `mutationCheckOp` gathers candidates across **all** changed files, then applies `selectEvenlySpaced` once to the combined list. This fixes both biases in one place — top-of-file and first-file-only — and keeps selection a pure, deterministic function.

Selection cannot guarantee a buildable mutant, and it does not try to. That is what G2 is for: a mutant that lands on a type annotation is now reported as `errored` and discarded rather than counted as `killed`.

**G2 — evidence-based classification.** On the `TEST_FAILURE` arm, `classifyMutant` returns `killed` only when there is evidence tests actually executed — `(passCount ?? 0) + (failCount ?? 0) > 0`. With no such evidence the mutant produced a non-zero exit with no test results, which means compilation, module resolution, or collection failed: `errored`. All other arms are unchanged.

This is deliberately conservative in one further case: a genuine test failure whose output the parser cannot recognise (an unknown framework format) now classifies as `errored` rather than `killed`. Discarding an inconclusive result is correct for a spot-check; the current behaviour claims a kill it cannot substantiate, which is the exact false all-clear this spec exists to remove.

The op gains `outcomes: { killed, survived, errored }` so the three-way distinction is observable rather than inferred from an empty `survivors` array.

**G5 — run-end surfacing.** `mutationCheckOp` records its per-story result into `ctx.runtime.mutationSummaries`, a `Map<string, MutationStorySummary>` on `NaxRuntime`. `runCompletionPhase` reads the map at run end, logs a warning when any survivor exists, and in headless non-`json` mode prints a formatted block — mirroring how `outputAdvisoryFindingsSummary` handles sub-threshold review findings. `json` mode stays silent, consistent with the advisory precedent.

The survivors are **not** converted into `Finding` objects. `FindingSource` is a closed nine-member union and `AdvisoryFindingSummaryEntry.reviewer` is `"semantic" | "adversarial"`; both are review-owned, and routing a deterministic operation's output through the review-audit sink would widen shared review contracts to carry something that is not a review. The dedicated collector keeps the blast radius inside the mutation feature.

### Failure Handling

The gate is advisory and fail-open; every existing path must stay that way.

| Condition | Behaviour | Covered by |
|:---|:---|:---|
| No candidate mutants after selection | Return `success: true` with empty survivors and all-zero outcomes; no test runs | US-002 |
| `max` is zero or negative | `selectEvenlySpaced` returns an empty array; no test runs | US-002 |
| Fewer candidates than `max` | Return every candidate; no padding | US-002 |
| `TEST_FAILURE` with no parseable test counts | Classify `errored`, discard, never counted as `killed` or `survived` | US-003 |
| Verification result carries no `passCount`/`failCount` fields | Classify `errored` — absence of evidence is not evidence of a kill | US-003 |
| No storyId on the call context | Skip recording into `mutationSummaries`; the op still returns normally | US-004 |
| No survivors at run end | Emit nothing — no empty block, no warning | US-004 |
| `formatterMode` is `json` | Emit nothing to stdout, matching `outputAdvisoryFindingsSummary` | US-004 |

## Out of Scope

- Restricting mutant candidates to the story's changed diff lines (gap analysis G3). Mutants continue to be drawn from whole changed files; scoping them to added and modified hunks requires threading diff hunk ranges into `generateMutants` and is deferred to a follow-up arc.
- Creating the dedicated `test/unit/verification/mutation/operators.test.ts` covering every shipped operator id (gap analysis G6). This spec tests only the arithmetic operators it changes; six of sixteen operator ids remain without direct coverage.
- Hoisting the loop-invariant `selectScopedTests` call out of the per-mutant loop in `mutationCheckOp` (gap analysis G8). The redundant per-mutant recomputation is a performance concern, not a correctness one.
- Making `revertMutant` verify the target line still holds the mutated content before restoring it (gap analysis G9). Positional revert remains as shipped.
- Adding a `SIGINT` / `SIGTERM` handler that reverts an in-flight mutant (gap analysis G10). An interrupted run can still leave a mutated source file in the worktree.
- Documenting `execution.mutationCheck` in `docs/guides/configuration.md`, `docs/ROADMAP.md`, or `src/cli/config-descriptions.ts` (gap analysis G11).
- Changing the `enabled: false` default, enabling the gate in nax's own `.nax/config.json`, or adding run telemetry counters for kill rate and false-alarm rate (gap analysis G12).
- Deduplicating mutants across operators and detecting semantically equivalent mutants (gap analysis G13).
- Running mutants in parallel, adding an aggregate time budget, or accounting mutation cost in the run's cost reporting (gap analysis G14).
- Promoting the gate from advisory to blocking, or feeding surviving mutants back to the implementer as a rectification finding. The design defers this behind observed false-alarm data, which does not yet exist.
- Converting surviving mutants into `Finding` objects or routing them through the review-audit sink. The run-end summary is the only consumer this spec adds.
- Restricting mutation of type-only positions such as type annotations and generic parameters. Mutants landing there are reported as `errored` rather than prevented.

## Stories

Four stories. `US-002` depends on `US-001` so the realistic-file behaviour is settled before selection is tuned against it; `US-004` depends on `US-003` so the surfaced signal is already correct when it becomes visible.

Not a monorepo — no `Workdir` declared.

### US-001 — Whitespace-guard the arithmetic mutation operators

Stop `ts:arith-flip` and its per-language siblings from matching operators inside string literals, module specifiers, and paths, by requiring whitespace on both sides in the same way the comparison operators already do.

**Depends on:** none

**Context Files (reads):**
- `src/verification/mutation/operators.ts`
- `src/verification/mutation/mutator.ts`
- `test/unit/verification/mutation/mutator.test.ts`

**Creates:** none

### US-002 — Even-spread mutant selection across all changed files

Replace first-N-in-source-order truncation with a deterministic stride-based sample taken over the combined candidate list from every changed file.

**Depends on:** US-001

**Context Files (reads):**
- `src/verification/mutation/mutator.ts`
- `src/verification/mutation/index.ts`
- `src/operations/mutation-check.ts`
- `test/unit/operations/mutation-check.test.ts`

**Creates:**
- `src/verification/mutation/select.ts`
- `test/unit/verification/mutation/select.test.ts`

### US-003 — Classify mutants that never ran tests as errored

Teach `classifyMutant` to require evidence that tests executed before declaring a mutant killed, and expose the three-way outcome counts on the operation output.

**Depends on:** none

**Context Files (reads):**
- `src/verification/mutation/classify.ts`
- `src/verification/mutation/types.ts`
- `src/verification/types.ts`
- `src/operations/mutation-check.ts`

**Creates:** none

### Modifies

This story changes the meaning of `TEST_FAILURE` for the classifier, and two existing assertions encode the old meaning. The implementer is authorised to update both — without this, the story deadlocks with a correct implementation against tests it may not touch.

- `test/unit/verification/mutation/classify.test.ts` — its `makeResult` helper builds a `VerificationResult` with no `passCount` or `failCount`. Two assertions consequently break: `AC3: TEST_FAILURE -> killed` and `AC3: accepts a VerificationResult with only status populated`, both of which expect `killed` from a result carrying no test counts. Under the new rule both inputs classify as `errored`. Update these two cases to supply `failCount` when the intent is `killed`, and add the no-counts case as an `errored` expectation.
- `test/unit/operations/mutation-check.test.ts` — the `AC4: TEST_FAILURE kills the mutant` case stubs `regression` with a `TEST_FAILURE` result carrying no counts. Its assertion (empty `survivors`) still passes, but for the wrong reason: the mutant is now `errored`, not `killed`, so the test no longer proves what its name claims. Add `failCount: 1` to that stub so the case exercises a genuine kill.

### US-004 — Surface surviving mutants at run end

Record each story's mutation result on the runtime and report survivors when the run completes, so a surviving mutant is visible without reading raw logs.

**Depends on:** US-003

**Context Files (reads):**
- `src/runtime/index.ts`
- `src/operations/mutation-check.ts`
- `src/execution/runner-completion.ts`
- `src/execution/lifecycle/headless-formatter.ts`
- `src/log-format/index.ts`
- `test/unit/execution/runner-completion-events.test.ts`

**Creates:**
- `src/log-format/mutation-summary.ts`
- `test/unit/log-format/mutation-summary.test.ts`

### Seams

- **US-002 → `selectEvenlySpaced`.** `mutationCheckOp` is the consumer. Its seam invariant is exercised through the operation's own execution with injected `regression` and `getChangedNonTestFiles` deps: with two changed files each yielding many candidates and `maxMutants: 2`, the op must run exactly two verifications and those two mutants must come from different files — proving selection is applied to the combined list, not per file.
- **US-003 → `MutationCheckOutput.outcomes`.** US-004 is the consumer; its summary reports the counts this field carries.
- **US-004 → `NaxRuntime.mutationSummaries`.** Producer is `mutationCheckOp`; consumer is `runCompletionPhase`. The seam is triggered at `runCompletionPhase`, the outermost run-completion entry point, not at the formatter helper it calls.
- **US-004 → `formatMutationSummary`.** Consumer is the headless output path reached from `runCompletionPhase`.

## Acceptance Criteria

### US-001 — Whitespace-guard the arithmetic mutation operators

1. `[unit]` Calling `generateMutants` with source `import { NaxError } from "@/errors";`, language `typescript`, and any file path returns no mutant whose `operatorId` is `ts:arith-flip`.
2. `[unit]` Calling `generateMutants` with source `import type { Mutant } from "./types";` and language `typescript` returns no mutant whose `operatorId` is `ts:arith-flip`.
3. `[unit]` Calling `generateMutants` with source `const url = "https://a.example/b/c";` and language `typescript` returns no mutant whose `operatorId` is `ts:arith-flip`.
4. `[unit]` Calling `generateMutants` with source `const idx = line - 1;` and language `typescript` returns a mutant with `operatorId` `ts:arith-flip` whose `after` is `const idx = line + 1;`.
5. `[unit]` Calling `generateMutants` with source `const total = a + b;` and language `typescript` returns a mutant with `operatorId` `ts:arith-flip` whose `after` is `const total = a - b;`.
6. `[unit]` Calling `generateMutants` with source `const half = n / 2;` and language `typescript` returns a mutant with `operatorId` `ts:arith-flip` whose `after` is `const half = n * 2;`.
7. `[unit]` Calling `generateMutants` with source `const twice = n * 2;` and language `typescript` returns a mutant with `operatorId` `ts:arith-flip` whose `after` is `const twice = n / 2;`.
8. `[unit]` Calling `generateMutants` with source `y = a + b` and language `python` returns a mutant with `operatorId` `py:arith-flip` whose `after` is `y = a - b`.
9. `[unit]` Calling `generateMutants` with source `path = "a/b/c"` and language `python` returns no mutant whose `operatorId` is `py:arith-flip`.
10. `[unit]` Calling `generateMutants` with source `sum := a + b` and language `go` returns a mutant with `operatorId` `go:arith-flip` whose `after` is `sum := a - b`.
11. `[unit]` Calling `generateMutants` with source `let sum = a + b;` and language `rust` returns a mutant with `operatorId` `rust:arith-flip` whose `after` is `let sum = a - b;`.
12. `[unit]` Given a multi-line TypeScript source whose first five lines are `import` statements containing relative specifiers and whose remaining lines contain spaced arithmetic expressions, every mutant returned by `generateMutants` has a `line` value of 6 or greater.
13. `[unit]` Calling `generateMutants` twice with identical `source`, `language`, and `file` returns two arrays that are deeply equal.

### US-002 — Even-spread mutant selection across all changed files

1. `[unit]` `selectEvenlySpaced` is importable from `src/verification/mutation/select.ts` and is usable as a function.
2. `[unit]` Calling `selectEvenlySpaced` with a list of nine mutants and `max` of three returns exactly three mutants.
3. `[unit]` Calling `selectEvenlySpaced` with a list of nine mutants and `max` of three returns the mutants at zero-based positions 0, 3, and 6 of the input list.
4. `[unit]` Calling `selectEvenlySpaced` with a list of ten mutants and `max` of three returns the mutants at zero-based positions 0, 3, and 6 of the input list.
5. `[unit]` Calling `selectEvenlySpaced` with a list of two mutants and `max` of five returns both input mutants in input order.
6. `[unit]` Calling `selectEvenlySpaced` with an empty list and `max` of three returns an empty array.
7. `[unit]` Calling `selectEvenlySpaced` with a list of nine mutants and `max` of zero returns an empty array.
8. `[unit]` Calling `selectEvenlySpaced` with a list of nine mutants and `max` of negative one returns an empty array.
9. `[unit]` Calling `selectEvenlySpaced` twice with the same input list and the same `max` returns two arrays that are deeply equal.
10. `[unit]` Calling `generateMutants` with a source yielding more than three candidate mutants and no `max` supplied returns every candidate rather than truncating.
11. `[integration]` Executing `mutationCheckOp` with `execution.mutationCheck.maxMutants` set to two, a stubbed `getChangedNonTestFiles` returning one file whose contents yield at least six candidate mutants, and a stubbed `regression` returning a `TEST_FAILURE` result with `failCount` one, invokes the stubbed `regression` exactly twice.
12. `[integration]` Executing `mutationCheckOp` with `maxMutants` set to two, a stubbed `getChangedNonTestFiles` returning two files that each yield at least six candidate mutants, and a stubbed `regression` returning a `SUCCESS` result returns a `survivors` array whose two entries have two different `file` values.
13. `[integration]` Executing `mutationCheckOp` with a stubbed `getChangedNonTestFiles` returning one file whose contents yield no candidate mutants never invokes the stubbed `regression`.

### US-003 — Classify mutants that never ran tests as errored

1. `[unit]` Calling `classifyMutant` with a verification result whose `status` is `TEST_FAILURE`, `passCount` is 0, and `failCount` is 0 returns `errored`.
2. `[unit]` Calling `classifyMutant` with a verification result whose `status` is `TEST_FAILURE` and whose `passCount` and `failCount` are both absent returns `errored`.
3. `[unit]` Calling `classifyMutant` with a verification result whose `status` is `TEST_FAILURE`, `passCount` is 0, and `failCount` is 1 returns `killed`.
4. `[unit]` Calling `classifyMutant` with a verification result whose `status` is `TEST_FAILURE`, `passCount` is 5, and `failCount` is 2 returns `killed`.
5. `[unit]` Calling `classifyMutant` with a verification result whose `status` is `SUCCESS` returns `survived`.
6. `[unit]` Calling `classifyMutant` with a verification result whose `status` is `TIMEOUT` returns `errored`.
7. `[unit]` Calling `classifyMutant` with a verification result whose `status` is `ENVIRONMENTAL_FAILURE` returns `errored`.
8. `[unit]` Calling `classifyMutant` with a verification result whose `status` is `ASSET_CHECK_FAILED` returns `errored`.
9. `[integration]` Executing `mutationCheckOp` with a stubbed `regression` returning a `TEST_FAILURE` result whose `passCount` and `failCount` are both 0, for a single candidate mutant, returns an `outcomes` object whose `errored` count is 1.
10. `[integration]` Executing `mutationCheckOp` with a stubbed `regression` returning a `TEST_FAILURE` result whose `passCount` and `failCount` are both 0, for a single candidate mutant, returns an `outcomes` object whose `killed` count is 0.
11. `[integration]` Executing `mutationCheckOp` with a stubbed `regression` returning a `TEST_FAILURE` result whose `failCount` is 1, for a single candidate mutant, returns an `outcomes` object whose `killed` count is 1.
12. `[integration]` Executing `mutationCheckOp` with a stubbed `regression` returning a `SUCCESS` result, for a single candidate mutant, returns an `outcomes` object whose `survived` count is 1.
13. `[integration]` Executing `mutationCheckOp` with a stubbed `regression` returning a `TEST_FAILURE` result whose `passCount` and `failCount` are both 0 returns a `survivors` array of length 0.

### US-004 — Surface surviving mutants at run end

1. `[unit]` `formatMutationSummary` is importable from `src/log-format/mutation-summary.ts` and is usable as a function.
2. `[unit]` Calling `formatMutationSummary` with one story summary containing a single surviving mutant returns a string containing that mutant's file path.
3. `[unit]` Calling `formatMutationSummary` with one story summary containing a single surviving mutant returns a string containing that mutant's line number.
4. `[unit]` Calling `formatMutationSummary` with one story summary containing a single surviving mutant returns a string containing that mutant's `operatorId`.
5. `[unit]` Calling `formatMutationSummary` with one story summary containing a single surviving mutant returns a string containing that story's id.
6. `[unit]` Calling `formatMutationSummary` with an empty collection of story summaries returns an empty string.
7. `[unit]` Calling `formatMutationSummary` with story summaries whose outcome counts record only killed and errored mutants and whose survivors arrays are empty returns an empty string.
8. `[unit]` Calling `formatMutationSummary` with two story summaries each containing one surviving mutant returns a string containing the file path of the second story's surviving mutant.
9. `[integration]` Executing `mutationCheckOp` with a call context whose `storyId` is `US-007` and a stubbed `regression` returning a `SUCCESS` result for a single candidate mutant leaves `runtime.mutationSummaries` holding an entry keyed `US-007` whose survivors array has length 1.
10. `[integration]` Executing `mutationCheckOp` with a call context that has no `storyId` leaves `runtime.mutationSummaries` empty.
11. `[integration]` Calling `runCompletionPhase` with `headless` true, `formatterMode` `normal`, and a runtime whose `mutationSummaries` holds one surviving mutant writes that mutant's file path to standard output.
12. `[integration]` Calling `runCompletionPhase` with `headless` true, `formatterMode` `json`, and a runtime whose `mutationSummaries` holds one surviving mutant writes nothing containing that mutant's file path to standard output.
13. `[integration]` Calling `runCompletionPhase` with `headless` true, `formatterMode` `normal`, and a runtime whose `mutationSummaries` is empty writes nothing containing the text `surviving mutant` to standard output.
14. `[integration]` Calling `runCompletionPhase` with a runtime whose `mutationSummaries` holds one surviving mutant emits a warning log record whose data carries a survivor count of 1.
