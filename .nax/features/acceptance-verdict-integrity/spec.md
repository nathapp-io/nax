# SPEC: Acceptance verdict integrity — editable generation, AC count check, loud refine fallback, RED crash repair

## Summary

Five changes that make an acceptance verdict mean what it says. `acceptance-gen` and `plan-refine`
gain the `Edit` tool, and the generator prompt tells the model that nax runs the file right away,
that the file must load before the implementation exists, and that every AC test belongs in the one
file. A deterministic AC count check compares the `AC-N` tests a file declares with the in-scope ACs
of its package group and warns on a gap, at generation and at post-run; it never changes a verdict.
A fingerprint match whose test file is missing now regenerates instead of reusing nothing.
`acceptance-refine` stops returning the original criteria silently when its output is unusable or
has the wrong number of items: it throws a parse error, retries once, and the stage marks the
fallback in `acceptance-refined.json` with one run-level warning. Finally, the RED gate tells a load
crash from a genuine RED and sends a crashing file back to the model once for repair, except for
Go/Rust compile failures that consist only of missing symbols, which are the expected RED state.

## Motivation

- **Missing ACs pass silently (#2257).** Nothing checks that every AC has a test.
  `acceptanceGenerateOp.verify` (`src/operations/acceptance-generate.ts`) only rejects a missing or
  stub file; the RED gate in `runAcceptanceSetup` (`src/pipeline/stages/acceptance-setup.ts`) only
  checks `exitCode !== 0`; the post-run stage learns about ACs only from failing `AC-N:` lines. On
  feature `turn-cancellation` (#2222, 54 ACs) the generator wrote AC-1..30 to
  `.nax-acceptance.test.ts`, could not append (no `Edit`), and wrote AC-31..54 to a side file the
  stage never runs. The run logged `All acceptance tests passed` with 24 ACs ungated.
- **The model cannot revise what it wrote.** 12 `RequestCapability` calls in three days of
  tool-audit came from `acceptance-gen` and `plan-refine`: 8 asked to run the file they had just
  written (the prompt never says nax runs it), 4 asked to patch a large existing file. `plan-refine`
  rewrote a 41 KB `prd.json` twice in one session. Adding `Edit` needs no guard change (#2263 already
  allows `Edit` on the op's own `prd.json` and on test-shaped files in a feature dir).
- **The RED gate counts a crash as RED.** Any non-zero exit passes the gate, so a file that fails to
  import surfaces only post-run as `AC-ERROR` plus a fix loop. In TypeScript/JavaScript and Python
  the usual cause is a top-level import of a module the feature has not created yet.
- **Refine fails quietly (#1796 item 1).** `parseRefinementResponse` (`src/acceptance/refinement.ts`)
  returns the original criteria with `testable: true` on unusable output, and maps over the array the
  model returned rather than the input criteria, so a response with fewer items silently drops ACs
  before generation.
- **Reuse blesses a missing file.** When the stored fingerprints match, `runAcceptanceSetup` skips
  generation even if the test file is gone (its own comment says so). On the fix-review run
  (2026-09-26) an agent's `rm -rf .nax` deleted the file; the resumed run logged `Reusing existing
  acceptance tests (fingerprint match)` and failed post-run with `Required acceptance test file
  missing`.

## Design

### Integration

Read-only symbols (verified, used as-is):

- `parseTestFailuresDetailed(output): { failedACs: string[]; taggedFailureCount: number }`
  (`src/test-runners/ac-parser.ts`, exported from `@/test-runners`).
- `groupStoriesByPackage(...)` and `AcceptanceTestGroup { testPath; packageDir; stories; criteria;
  language }` (`src/acceptance/test-path.ts`). `criteria` is the flat list of in-scope ACs of the
  group's stories; `language` is the per-package language string (`"go"`, `"rust"`, ...) or
  `undefined`.
- `isInAcceptanceScope` (`@/prd`); `storyAbsWorkdir` (`@/utils/path-frame`).
- `MAX_RAW_TAIL_CHARS = 2_000` (`src/quality/diagnostics.ts`, exported from `@/quality`).
- `ParseValidationError` (`@/agents/retry`). The `transient-network` retry preset
  (`src/agents/retry/presets.ts`) retries any thrown `Error` up to `maxAttempts - 1` times;
  `acceptanceRefineOp.retry` is `{ preset: "transient-network", maxAttempts: 2 }`, so a parse throw
  gets one retry and then `callOp` rejects.
- `extractTestCode` (`src/acceptance/generator.ts`), `hasLikelyTestContent` and `isStubTestContent`
  (`src/acceptance/heuristics.ts`).
- `compileToolPolicy(grants, root, { ownedWriteExemption })` (`@/tools`).
- `_acceptanceSetupDeps.runTest(testPath, workdir, cmd, timeoutMs): Promise<{ exitCode; output }>`,
  `.callOp`, `.writeFile`, `.autoCommitIfDirty` (`src/pipeline/stages/acceptance-setup.ts`) — the
  seams tests already stub.
- `REQUIRED_TOOLS_BY_ROLE["acceptance-gen"] = ["Write"]` (`scripts/check-op-tool-capability.ts`) — the
  new op declares `Write`, so the ratchet passes unchanged.

Mutated symbols. The baseline exists only to locate the code; it is never the interface to implement.

- `acceptanceGenerateOp.tools` (`src/operations/acceptance-generate.ts`)
  - Baseline: `["Read", "Glob", "Grep", "Write", "RequestCapability"]`
  - Target: `["Read", "Glob", "Grep", "Write", "Edit", "RequestCapability"]`; the comment above it
    says `Edit` revises the file the op wrote and that there is still no `Exec`.
- `planRefineOp.tools` (`src/operations/plan-refine.ts`)
  - Baseline: `["Read", "Glob", "Grep", "Write", "RequestCapability"]`
  - Target: `["Read", "Glob", "Grep", "Write", "Edit", "RequestCapability"]`; comment updated the same way.
- `AcceptancePromptBuilder.buildGeneratorFromPRDPrompt` (`src/prompts/builders/acceptance-builder.ts`)
  - Target: the rules list gains the three generator sentences G1-G3 below.
- `AcceptancePromptBuilder.buildPathCorrection`
  - Baseline: its Requirements list ends with "If you wrote it somewhere else, delete the misplaced
    copy after moving it so only the canonical path remains." (the op has no delete tool)
  - Target: that bullet is replaced by sentence P1 below.
- `AcceptancePromptBuilder` gains `buildLoadRepairPrompt(targetTestFilePath: string, outputTail: string): string`.
- `RefinedCriterion` (`src/acceptance/types.ts`)
  - Baseline: `{ original; refined; testable; storyId }`
  - Target: adds `refinementFallback?: boolean`.
- `acceptanceRefineOp.parse` (`src/operations/acceptance-refine.ts`)
  - Baseline: non-empty unusable output logs a warn and returns the original criteria.
  - Target: throws `ParseValidationError` when the output is unusable or its item count differs
    from `input.criteria.length`.
- `AcceptanceMeta` (`src/pipeline/stages/acceptance-setup.ts`)
  - Baseline: `{ generatedAt; acFingerprint; layoutFingerprint?; storyCount; acCount; generator }`
  - Target: adds `coverage?: AcceptanceCoverageEntry[]`.
- `runAcceptanceSetup` (`src/pipeline/stages/acceptance-setup.ts`) — the reuse branch, the
  refinement loop (moved out, US-003) and the RED gate loop (moved out, US-005).
- `acceptanceStage.execute` (`src/pipeline/stages/acceptance.ts`) — runs the count check per group.

New symbols:

- `src/test-runners/ac-coverage.ts`:
  `interface AcTestCoverage { expected: number; found: number; missing: string[] }` and
  `acTestCoverage(source: string, expected: number): AcTestCoverage`, both exported from `@/test-runners`.
- `src/pipeline/stages/acceptance-coverage.ts`:
  `interface AcceptanceCoverageEntry { testPath: string; expected: number; found: number; missing: string[] }`
  and `checkAcceptanceCoverage(args: { testPath: string; source: string; expected: number; storyId?: string }): AcceptanceCoverageEntry`.
- `src/test-runners/compile-crash.ts`:
  `classifyAcceptanceCrash(output: string, language: string | undefined): "expected-red" | "repairable"`,
  exported from `@/test-runners`.
- `src/operations/acceptance-repair.ts`: `acceptanceRepairOp`, exported from `@/operations`.
- `src/pipeline/stages/acceptance-refine-criteria.ts`: `refineAcceptanceCriteria(...)`.
- `src/pipeline/stages/acceptance-red-gate.ts`: `runAcceptanceRedGate(...)`.

File-size constraint: `src/pipeline/stages/acceptance-setup.ts` is at 584 of the 600-line source
limit (`scripts/check-file-sizes.ts`). US-002 puts its logic in new modules and adds at most 10 net
lines there; US-003 and US-005 each move the loop they change into a new file.

### Prompt sentences (verbatim)

- **G1:** "nax runs this file as soon as you finish, before any implementation exists; a file that fails to load is sent back for repair."
- **G2:** "The file must load before the implementation exists. In languages that resolve imports at runtime (TypeScript, JavaScript, Python), import modules this feature adds inside each test rather than at the top of the file, so a missing module fails only the tests that use it."
- **G3:** "Write every AC-N test into this one file. To add or change tests in a file you already wrote, use Edit; do not create a second test file."
- **P1:** "Keep every acceptance test in this one file; do not create a second test file."

### US-001 — Acceptance generator and plan-refine can edit what they wrote

`Edit` joins both ops' tool lists; `Exec`, `Bash` and `Delete` stay absent. G1-G3 are appended to
the generator's rules; P1 replaces the path-correction delete instruction, which named an action the
op cannot perform.

### US-002 — AC count check and missing-file regeneration

**Counting.** `acTestCoverage(source, expected)` collects the distinct AC numbers `N` that the source
names as tests, in any of these forms (case-insensitive where noted):

| Form | Example | Frameworks |
|---|---|---|
| `AC-N:` anywhere (test titles) | `test("AC-3: rejects empty input", ...)` | bun, jest, vitest, Go subtests |
| `TestAC` + optional `_`/`-` + `N` | `func TestAC3_Rejects(t *testing.T)`, `TestAC_3` | go test |
| `test_ac` + optional `_` + `N` (case-insensitive) | `def test_ac_3_rejects():`, `test_AC3` | pytest |
| `fn ac` + optional `_` + `N` (case-insensitive) | `fn ac_3_rejects()` | cargo test |

`found` counts the distinct `N` with `1 <= N <= expected`; `missing` lists `AC-N` for every
`N` in `1..expected` not found, ascending. Numbers above `expected` are ignored. The scan is textual,
so a name inside a comment counts; that is accepted because the result only drives a warning.

**Where it runs.**
- *Setup.* After a group's content is written (agent test code or skeleton), `runAcceptanceSetup`
  calls `checkAcceptanceCoverage` with the content it just wrote (no disk read) and
  `expected = group.criteria.length`. The ACs are numbered per group, the way the generator numbers
  them. A group that got no file (dispatch failure) gets no entry. The entries are stored as
  `coverage` in `acceptance-meta.json`, with `testPath` relative to `ctx.workdir`.
- *Post-run.* In `acceptanceStage.execute`, for each group whose test file exists, the stage reads
  the file's text and calls `checkAcceptanceCoverage` with `expected` = the number of in-scope ACs
  of the PRD stories whose `storyAbsWorkdir` equals the group's `packageDir`.
- On a gap, `checkAcceptanceCoverage` logs warn `"Acceptance test file does not cover every AC"`
  with `{ storyId, testPath, expected, found, missing }`. It never throws and never changes a
  stage result, a verdict, or a story status.

**Missing-file regeneration.** In `runAcceptanceSetup`, when `meta` exists and both fingerprints
match but at least one group's `testPath` does not exist (`_acceptanceSetupDeps.fileExists`), the
stage takes the existing regenerate path (back up and delete present files, regenerate every group,
rewrite meta) and logs warn `"Acceptance test file missing despite fingerprint match — regenerating"`
with `{ storyId, missingTestPaths }`. The comment that blessed the missing file is removed.

### US-003 — Refine fails loud

`acceptanceRefineOp.parse` throws `ParseValidationError` in two new cases (the empty-output throw
stays):

- `refinementWouldFallback(output)` is true for non-empty output;
- the parsed array's length differs from `input.criteria.length`; the message is
  `acceptance-refine: returned <got> of <expected> criteria`.

The warn it logs today on unusable output is removed (the throw replaces it). The retry preset is
unchanged, so each story gets one retry. The refinement loop moves from `runAcceptanceSetup` into
`refineAcceptanceCriteria(ctx, stories, groupConfigs, callOp)` in
`src/pipeline/stages/acceptance-refine-criteria.ts`. It keeps the `refinementConcurrency` cap and the
story order, and returns `{ criteria: RefinedCriterion[]; fallbackStoryIds: string[] }`. When a
story's `callOp` rejects, its criteria become `{ original: c, refined: c, testable: true, storyId,
refinementFallback: true }`. `testable` stays `true` because `runHardeningPass`
(`src/acceptance/hardening.ts`) discards ACs marked `testable === false`. After all stories settle,
if any fell back, one warn `"AC refinement unusable after retries — using unrefined criteria"` is
logged with `{ storyId, storyIds }`, replacing today's per-story warn. `acceptance-refined.json` entries
gain `refinementFallback: boolean` (`true` for fallback entries, `false` otherwise, including when
`acceptance.refinement` is off).

### US-004 — Crash classifier and repair op

**`classifyAcceptanceCrash(output, language)`** — deterministic, for output of a run that exited
non-zero with no AC-tagged failure:

- `language` is `"go"` (case-insensitive): error lines are lines of the form
  `<path>.go:<line>[:<col>]: <message>`. The result is `"expected-red"` when there is at least one
  such line and every message is a missing symbol, meaning it starts with `undefined: ` or matches
  `<expr> undefined (type <T> has no field or method <name>)`. Otherwise `"repairable"`.
- `language` is `"rust"` (case-insensitive): error lines are lines starting `error[E<4 digits>]` or
  `error: `. The two summary forms `error: could not compile` and `error: aborting due to` are
  ignored. The result is `"expected-red"` when at least one coded error line remains and every
  remaining error line carries one of `E0425`, `E0432`, `E0433`, `E0412`, `E0599`. Otherwise
  `"repairable"`; an uncoded `error: ` line (a syntax error) makes it `"repairable"`.
- Any other `language`, including `undefined`: `"repairable"`.

**`acceptanceRepairOp`** — `kind: "run"`, `name: "acceptance-repair"`, `stage: "acceptance"`,
`session: { role: "acceptance-gen", lifetime: "fresh" }`,
`tools: ["Read", "Glob", "Grep", "Write", "Edit", "RequestCapability"]`, and `model` and `timeoutMs`
resolved as in `acceptanceGenerateOp`. Input `{ targetTestFilePath: string; outputTail: string }`;
output `{ testCode: string | null }`. `build` puts
`buildLoadRepairPrompt(targetTestFilePath, outputTail)` in the task section. `parse` returns
`{ testCode: extractTestCode(output) }`. `verify` returns `parsed` when `testCode` is non-null, else
reads `targetTestFilePath` and returns `{ testCode: content }` when it has likely test content and is
not a stub, else `null`. `buildLoadRepairPrompt` names the path, includes the output tail in a fenced
block, asks for the smallest edit that makes the file load while keeping every `AC-N` test and its
assertions, and includes G2.

### US-005 — RED gate repairs a crashing file

The RED gate loop moves from `runAcceptanceSetup` into
`runAcceptanceRedGate(ctx, entries, deps): Promise<number>` in
`src/pipeline/stages/acceptance-red-gate.ts`. It returns the RED count;
`entries: readonly { testPath; packageDir; testFramework?; commandOverride?; language?; storyId?; config: NaxConfig }[]`;
`deps: Pick<typeof _acceptanceSetupDeps, "runTest" | "callOp" | "writeFile" | "autoCommitIfDirty">`.
`runAcceptanceSetup` passes `_acceptanceSetupDeps`, each group's `language` and first story id, and
its per-package config. Per entry:

1. Run the file (same command and timeout as today). Exit `0` → not RED.
2. Non-zero exit with at least one AC-tagged failure (`parseTestFailuresDetailed`) → RED.
3. Otherwise it is a crash. When `classifyAcceptanceCrash(output, language)` is `"expected-red"`,
   log info `"RED gate: compile errors are all missing-symbol — expected RED"`
   `{ storyId, testPath, language }` and count RED, with no repair.
4. `"repairable"`: log warn `"RED gate: acceptance file crashed on load — issuing one repair turn"`
   `{ storyId, testPath, language }` and call `deps.callOp(ctx, packageDir, acceptanceRepairOp,
   { targetTestFilePath: testPath, outputTail: output.slice(-MAX_RAW_TAIL_CHARS) }, storyId, config)`.
   If the result's `testCode` is non-null, `deps.writeFile(testPath, testCode)`. Then
   `deps.autoCommitIfDirty(...)` as the setup commit does, and run the file once more, classifying
   the second run by rules 1-2. A second crash logs warn
   `"RED gate: acceptance file still crashes after repair"` `{ storyId, testPath }`.
5. A crash counts as RED whether or not it was repaired, as today. The repair runs at most once per
   entry per run.

If the repair `callOp` rejects, log warn `"RED gate: acceptance repair failed"`
`{ storyId, testPath, error }`, skip the re-run, and count the entry RED.

### Failure Handling

| Condition | Behaviour | Story |
|---|---|---|
| Written content or post-run file declares fewer ACs than expected | warn with `missing`; verdict and stage result unchanged | US-002 |
| Group got no file (generation dispatch failure) | no coverage entry for it; existing missing-target path unchanged | US-002 |
| Fingerprints match, a group's test file missing | regenerate every group, warn with `missingTestPaths` | US-002 |
| Refine output unusable or wrong item count | `ParseValidationError`, one retry | US-003 |
| Refine still fails after the retry | unrefined criteria with `refinementFallback: true`, `testable: true`; one run-level warn | US-003 |
| Go/Rust crash of only missing-symbol compile errors | expected RED, no repair, info log | US-005 |
| Crash of any other kind | one repair turn, one re-run | US-005 |
| Repair `callOp` rejects | warn, no re-run, entry counts RED | US-005 |
| Repair returns `testCode: null` | file left as it is, re-run still happens | US-005 |
| Still crashes after the repair | warn, entry counts RED, post-run `AC-ERROR` path unchanged | US-005 |

## Out of Scope

- Verifying AC coverage from runner reports (JUnit/JSON reporters) or generating a skeleton first for the model to fill in.
- Making the AC count check a gate: a count gap never changes a stage result, an acceptance verdict, a story status or the RED count.
- Detecting skipped or todo tests in the AC count check; a named test counts whether or not it runs.
- Changing the RED gate's `skip` result when every acceptance test passes before implementation; post-run acceptance already runs regardless of that result.
- Structured output or strict tool calls for `acceptance-refine` (#1796 item 2), and changing its retry preset or `maxAttempts`.
- Granting `Delete`, `Exec`, `Bash` or `RunCommand` to `acceptance-gen`, `acceptance-repair` or `plan-refine`; a copy the model wrote at a wrong path is not removed by nax.
- Adding `Edit` to `plan-interactive`, whose repair turns rewrite invalid JSON whole.
- Reconciling the feature-wide `AC-N` numbering written to `acceptance-refined.json` with the per-group numbering the generator uses.
- Warning on extra test files in a feature directory.
- A second repair turn, or a repair turn in the post-run acceptance stage.
- A failure category for a rectification-exhausted TDD plan (the `"defaulting to pause"` log in `src/execution/post-run.ts`).
- Running or relocating `.nax/features/turn-cancellation/turn-cancellation-remaining.test.ts`.

## Stories

1. **US-001: Acceptance generator and plan-refine can edit what they wrote** — no dependencies
2. **US-002: AC count check and missing-file regeneration** — no dependencies
3. **US-003: acceptance-refine fails loud** — no dependencies
4. **US-004: Crash classifier and acceptance repair op** — depends on US-001
5. **US-005: RED gate repairs a crashing acceptance file** — depends on US-003, US-004

### Context Files

**US-001**
- `src/operations/acceptance-generate.ts` — `acceptanceGenerateOp.tools`, `pathCorrectionStep`
- `src/operations/plan-refine.ts` — `planRefineOp.tools`, `fileOutput`
- `src/prompts/builders/acceptance-builder.ts` — `buildGeneratorFromPRDPrompt`, `buildPathCorrection`, `STEP3_SHARED_RULES`
- `test/unit/operations/plan-fileoutput-writable.test.ts` — `compileToolPolicy` with `ownedWriteExemption` pattern

**US-002**
- `src/pipeline/stages/acceptance-setup.ts` — `runAcceptanceSetup`, `AcceptanceMeta`, `_acceptanceSetupDeps`
- `src/pipeline/stages/acceptance.ts` — `acceptanceStage.execute`, `storiesByPackageDir`
- `src/test-runners/ac-parser.ts` — AC naming patterns per framework
- `src/acceptance/test-path.ts` — `AcceptanceTestGroup`, `groupStoriesByPackage`
- `test/unit/pipeline/stages/acceptance-setup-fingerprint.test.ts` — reuse-path test patterns

**US-003**
- `src/operations/acceptance-refine.ts` — `acceptanceRefineOp.parse`, `retry`
- `src/acceptance/refinement.ts` — `parseRefinementResponse`, `refinementWouldFallback`
- `src/acceptance/types.ts` — `RefinedCriterion`
- `src/pipeline/stages/acceptance-setup.ts` — the refinement loop and the `acceptance-refined.json` writer
- `src/acceptance/hardening.ts` — `runHardeningPass` reads `testable`

**US-004**
- `src/operations/acceptance-generate.ts` — `acceptanceGenerateOp` shape, `verify`, model/timeout selectors
- `src/prompts/builders/acceptance-builder.ts` — `AcceptancePromptBuilder`, G2 text
- `src/acceptance/heuristics.ts` — `hasLikelyTestContent`, `isStubTestContent`
- `src/test-runners/ac-parser.ts` — module style for output classifiers
- `src/operations/index.ts` — operations barrel

**US-005**
- `src/pipeline/stages/acceptance-setup.ts` — RED gate loop, `_acceptanceSetupDeps`
- `src/acceptance/generator.ts` — `buildAcceptanceRunCommand`
- `src/quality/diagnostics.ts` — `MAX_RAW_TAIL_CHARS`
- `test/unit/pipeline/stages/acceptance-setup-gate.test.ts` — RED gate test patterns
- `src/operations/acceptance-repair.ts` — created by US-004, called here

### Creates

**US-002**
- `src/test-runners/ac-coverage.ts` — `acTestCoverage`, `AcTestCoverage`
- `src/pipeline/stages/acceptance-coverage.ts` — `checkAcceptanceCoverage`, `AcceptanceCoverageEntry`

**US-003**
- `src/pipeline/stages/acceptance-refine-criteria.ts` — `refineAcceptanceCriteria`

**US-004**
- `src/test-runners/compile-crash.ts` — `classifyAcceptanceCrash`
- `src/operations/acceptance-repair.ts` — `acceptanceRepairOp`

**US-005**
- `src/pipeline/stages/acceptance-red-gate.ts` — `runAcceptanceRedGate`

### Modifies

**US-001**
- `test/unit/prompts/__snapshots__/acceptance-builder.test.ts.snap` — snapshots the generator and path-correction prompt text verbatim; G1-G3 and P1 change it. Regenerate the snapshot; the replacing invariant is that the generator prompt still carries the path anchor and the "One test per AC" rule, now followed by G1-G3, and the path-correction prompt ends its Requirements with P1.

**US-003**
- `test/unit/operations/acceptance-refine.test.ts` — "falls back to original criteria on malformed JSON" asserts that `parse` returns the original criteria for malformed output; `parse` now throws. Replace it with an assertion that `parse` throws `ParseValidationError` for that input; `refinementWouldFallback` tests stay as they are.

**US-005**
- `test/unit/pipeline/stages/acceptance-setup-criteria.test.ts` — its `runTest` fakes return `{ exitCode: 1, output: "1 fail" }`, a RED with no AC-tagged failure, which the RED gate now treats as a crash and repairs. Change EVERY `runTest` fake in this file whose output has a non-zero exit and no AC-tagged failure line (each occurrence, not one representative) to include a `(fail) AC-1: x` line; the replacing invariant is that each fake still represents a genuine RED, so no test in the file triggers a repair call and every existing `callOp`/`runTest` call-count assertion keeps its value.
- `test/unit/pipeline/stages/acceptance-setup-fingerprint.test.ts` — its `runTest` fakes return `{ exitCode: 1, output: "1 fail" }` or `"RED"`, a RED with no AC-tagged failure, which the RED gate now treats as a crash and repairs (the reuse test's `callOpCalled` would turn true). Change EVERY `runTest` fake in this file whose output has a non-zero exit and no AC-tagged failure line (each occurrence, not one representative) to include a `(fail) AC-1: x` line; the replacing invariant is that each fake still represents a genuine RED, so no test in the file triggers a repair call and every existing `callOp`/`runTest` call-count assertion keeps its value.
- `test/unit/pipeline/stages/acceptance-setup-dispatch-failure.test.ts` — its `runTest` fakes return `{ exitCode: 1, output: "1 fail" }` or `"fail"`, a RED with no AC-tagged failure, which the RED gate now treats as a crash and repairs. Change EVERY `runTest` fake in this file whose output has a non-zero exit and no AC-tagged failure line (each occurrence, not one representative) to include a `(fail) AC-1: x` line; the replacing invariant is that each fake still represents a genuine RED, so no test in the file triggers a repair call and every existing `callOp`/`runTest` call-count assertion keeps its value.
- `test/unit/pipeline/stages/acceptance-missing-target.test.ts` — its `runTest` fakes return `{ exitCode: 1, output: "1 fail" }`, a RED with no AC-tagged failure, which the RED gate now treats as a crash and repairs. Change EVERY `runTest` fake in this file whose output has a non-zero exit and no AC-tagged failure line (each occurrence, not one representative) to include a `(fail) AC-1: x` line; the replacing invariant is that each fake still represents a genuine RED, so no test in the file triggers a repair call and every existing `callOp`/`runTest` call-count assertion keeps its value.

### Seams

- US-002 AC11 and AC14: `acceptanceSetupStage.execute` and `acceptanceStage.execute` → `acTestCoverage` via `checkAcceptanceCoverage`, observed through the warn log and `acceptance-meta.json`.
- US-003 AC8: `acceptanceSetupStage.execute` → `refineAcceptanceCriteria`, observed through the generator's `criteriaList` and `acceptance-refined.json`.
- US-005 AC1: `acceptanceSetupStage.execute` → `acceptanceRepairOp` through `_acceptanceSetupDeps.callOp`.
- US-005 AC6: `acceptanceSetupStage.execute` → `classifyAcceptanceCrash` (Go missing-symbol output makes no repair call).

## Acceptance Criteria

### US-001

1. [unit] `acceptanceGenerateOp.tools` equals `["Read", "Glob", "Grep", "Write", "Edit", "RequestCapability"]`.
2. [unit] `planRefineOp.tools` equals `["Read", "Glob", "Grep", "Write", "Edit", "RequestCapability"]`.
3. [integration] `compileToolPolicy` built from `planRefineOp.tools`'s `Edit` grant with `ownedWriteExemption` equal to the op's `fileOutput` path allows an `Edit` call on that path and denies an `Edit` call on `.nax/features/other/prd.json`.
4. [unit] `buildGeneratorFromPRDPrompt` returns text that includes sentence G1 verbatim.
5. [unit] `buildGeneratorFromPRDPrompt` returns text that includes sentence G2 verbatim.
6. [unit] `buildGeneratorFromPRDPrompt` returns text that includes sentence G3 verbatim.
7. [unit] `buildPathCorrection("/r/.nax/features/f/.nax-acceptance.test.ts")` returns text that includes sentence P1 verbatim and still names `/r/.nax/features/f/.nax-acceptance.test.ts`.
8. [unit] `acceptanceGenerateOp.build(...)` returns a task section whose content includes sentence G3, showing the op uses the updated builder.

### US-002

1. [unit] `acTestCoverage` on a source declaring tests titled `AC-1: a`, `AC-2: b` and `AC-3: c`, with `expected` 3, returns `{ expected: 3, found: 3, missing: [] }`.
2. [unit] `acTestCoverage` on a source declaring tests titled `AC-1: a` and `AC-3: c`, with `expected` 3, returns `found` 2 and `missing` `["AC-2"]`.
3. [unit] `acTestCoverage` on a source declaring two tests titled `AC-2: x` and `AC-2: y` plus one titled `AC-1: a`, with `expected` 2, returns `found` 2.
4. [unit] `acTestCoverage` on a Go source declaring `func TestAC1_Parses(t *testing.T)` and `func TestAC_2Rejects(t *testing.T)`, with `expected` 2, returns `found` 2.
5. [unit] `acTestCoverage` on a Python source declaring `def test_ac_1_parses():` and `def test_AC2_rejects():`, with `expected` 2, returns `found` 2.
6. [unit] `acTestCoverage` on a Rust source declaring `fn ac_1_parses()` and `fn ac2_rejects()`, with `expected` 2, returns `found` 2.
7. [unit] `acTestCoverage` on a source declaring tests titled `AC-1: a` and `AC-5: e`, with `expected` 3, returns `found` 1 and `missing` `["AC-2", "AC-3"]`.
8. [unit] `checkAcceptanceCoverage` with a source covering 3 of 5 expected ACs logs one warn `"Acceptance test file does not cover every AC"` with `expected` 5, `found` 3 and `missing` `["AC-4", "AC-5"]`, and returns an entry with the same three values.
9. [unit] `checkAcceptanceCoverage` with a source covering every expected AC logs no warn and returns an entry whose `found` equals `expected` and whose `missing` is `[]`.
10. [unit] `checkAcceptanceCoverage` with an empty `source` and `expected` 2 returns `found` 0 and `missing` `["AC-1", "AC-2"]` without throwing.
11. [integration] `acceptanceSetupStage.execute` for one group whose stories carry 5 in-scope ACs, with the generate op returning test code titled `AC-1:` to `AC-3:`, logs the warn `"Acceptance test file does not cover every AC"` with `missing` `["AC-4", "AC-5"]`, and the meta passed to `writeMeta` has `coverage` `[{ testPath, expected: 5, found: 3, missing: ["AC-4", "AC-5"] }]` with `testPath` relative to the workdir.
12. [integration] `acceptanceSetupStage.execute` for two groups `apps/a` (2 ACs) and `apps/b` (3 ACs), each generated file titled `AC-1:` up to its own group's count, logs no `"Acceptance test file does not cover every AC"` warn.
13. [integration] `acceptanceSetupStage.execute` with a coverage gap and a RED run exiting 1 with a `(fail) AC-1: x` line returns action `"continue"`, the same action it returns for a fully covered file with the same RED run.
14. [integration] `acceptanceStage.execute` over a group whose existing test file declares tests titled `AC-1:` and `AC-2:` while the group's PRD stories carry 3 in-scope ACs logs the warn `"Acceptance test file does not cover every AC"` with `missing` `["AC-3"]`, and returns the same action as for a file declaring `AC-1:` to `AC-3:` with the same runner outcome.
15. [integration] `acceptanceSetupStage.execute` with stored meta whose `acFingerprint` and `layoutFingerprint` both match and `fileExists` returning `false` for the group's `testPath` calls the generate op for that group and logs warn `"Acceptance test file missing despite fingerprint match — regenerating"` with `missingTestPaths` naming that path.
16. [integration] `acceptanceSetupStage.execute` with matching fingerprints and `fileExists` returning `true` for every group's `testPath` calls neither the refine op nor the generate op.
17. [integration] After a missing-file regeneration, `writeMeta` receives meta whose `acFingerprint` equals the current AC fingerprint.
18. [integration] `acceptanceSetupStage.execute` where the generate op returns `{ testCode: null, adapterFailure }` for the only group logs no `"Acceptance test file does not cover every AC"` warn.

### US-003

1. [unit] `acceptanceRefineOp.parse` with output `"I could not refine these criteria"` throws `ParseValidationError`.
2. [unit] `acceptanceRefineOp.parse` with a JSON array of 2 items for `input.criteria` of length 3 throws `ParseValidationError` whose message includes `returned 2 of 3 criteria`.
3. [unit] `acceptanceRefineOp.parse` with a JSON array of 4 items for `input.criteria` of length 3 throws `ParseValidationError` whose message includes `returned 4 of 3 criteria`.
4. [unit] `acceptanceRefineOp.parse` with a JSON array of 3 items for `input.criteria` of length 3 returns 3 criteria, each with `storyId` set to `input.storyId` when the item carries none.
5. [unit] `refineAcceptanceCriteria` with a `callOp` that rejects for story `US-002` returns US-002's criteria with `refined` equal to `original`, `testable` `true` and `refinementFallback` `true`, and `fallbackStoryIds` `["US-002"]`.
6. [unit] `refineAcceptanceCriteria` with a `callOp` that rejects for stories `US-001` and `US-003` logs exactly one warn `"AC refinement unusable after retries — using unrefined criteria"` with `storyIds` `["US-001", "US-003"]`.
7. [unit] `refineAcceptanceCriteria` with a `callOp` that resolves for every story logs no `"AC refinement unusable after retries — using unrefined criteria"` warn and returns an empty `fallbackStoryIds`.
8. [integration] `acceptanceSetupStage.execute` where the refine op rejects for `US-002` passes the generate op a `criteriaList` that includes US-002's original AC text, and writes `acceptance-refined.json` whose US-002 entries carry `refinementFallback: true` and whose other entries carry `refinementFallback: false`.
9. [integration] `acceptanceSetupStage.execute` with `acceptance.refinement` set to `false` writes `acceptance-refined.json` whose entries all carry `refinementFallback: false`.
10. [unit] `refineAcceptanceCriteria` with `refinementConcurrency` 1 and three stories returns criteria ordered by story in input order.

### US-004

1. [unit] `classifyAcceptanceCrash` with language `"go"` and output `./acceptance_test.go:12:5: undefined: ParseConfig` followed by `FAIL	example.com/pkg [build failed]` returns `"expected-red"`.
2. [unit] `classifyAcceptanceCrash` with language `"go"` and output `./acceptance_test.go:9:14: cfg.Parse undefined (type *Config has no field or method Parse)` returns `"expected-red"`.
3. [unit] `classifyAcceptanceCrash` with language `"go"` and output holding both `./acceptance_test.go:12:5: undefined: ParseConfig` and `./acceptance_test.go:20:1: syntax error: unexpected }` returns `"repairable"`.
4. [unit] `classifyAcceptanceCrash` with language `"go"` and output `panic: runtime error: invalid memory address` with no `<path>.go:<line>:` error line returns `"repairable"`.
5. [unit] `classifyAcceptanceCrash` with language `"rust"` and output ``error[E0425]: cannot find function `parse_config` in this scope`` followed by ``error: could not compile `ex` (test "acceptance") due to 1 previous error`` returns `"expected-red"`.
6. [unit] `classifyAcceptanceCrash` with language `"rust"` returns `"expected-red"` for output whose only coded error line carries `E0432`.
7. [unit] `classifyAcceptanceCrash` with language `"rust"` returns `"expected-red"` for output whose only coded error line carries `E0433`.
8. [unit] `classifyAcceptanceCrash` with language `"rust"` returns `"expected-red"` for output whose only coded error line carries `E0412`.
9. [unit] `classifyAcceptanceCrash` with language `"rust"` returns `"expected-red"` for output whose only coded error line carries `E0599`.
10. [unit] `classifyAcceptanceCrash` with language `"rust"` and output `error[E0308]: mismatched types` returns `"repairable"`.
11. [unit] `classifyAcceptanceCrash` with language `"rust"` and output ``error: expected one of `;` or `}`, found `let` `` returns `"repairable"`.
12. [unit] `classifyAcceptanceCrash` with language `"typescript"` and output `error: Cannot find module '../src/new-module'` returns `"repairable"`.
13. [unit] `classifyAcceptanceCrash` with language `undefined` and Go-style missing-symbol output returns `"repairable"`.
14. [unit] `acceptanceRepairOp` has `name` `"acceptance-repair"`, session role `"acceptance-gen"` and `tools` equal to `["Read", "Glob", "Grep", "Write", "Edit", "RequestCapability"]`.
15. [unit] `acceptanceRepairOp.build` with `{ targetTestFilePath: "/r/t.test.ts", outputTail: "error: Cannot find module 'x'" }` returns a task section whose content includes `/r/t.test.ts`, `error: Cannot find module 'x'` and sentence G2.
16. [unit] `acceptanceRepairOp.verify` with `testCode` `null` and a target file holding real test source with a non-placeholder assertion returns `{ testCode }` equal to that file's content.
17. [unit] `acceptanceRepairOp.verify` with `testCode` `null` and no file at the target path returns `null`.
18. [unit] `acceptanceRepairOp` is importable from the `@/operations` barrel and `classifyAcceptanceCrash` from the `@/test-runners` barrel.

### US-005

1. [integration] `acceptanceSetupStage.execute` whose first RED run for a TypeScript group exits 1 with output `error: Cannot find module '../src/x'` and no `(fail) AC-` line calls `_acceptanceSetupDeps.callOp` once with `acceptanceRepairOp` and input `{ targetTestFilePath: <group testPath>, outputTail }`, where `outputTail` equals the output's last `MAX_RAW_TAIL_CHARS` characters.
2. [integration] In that case `runTest` is called a second time for the same `testPath` after the repair.
3. [integration] When the repair returns a non-null `testCode`, `writeFile` receives the group's `testPath` and that `testCode` before the second `runTest` call.
4. [integration] When the repair has run, `autoCommitIfDirty` is called after the repair and before the second `runTest` call.
5. [integration] When the second RED run crashes again, `runTest` is called no third time, `callOp` receives `acceptanceRepairOp` no second time, and a warn `"RED gate: acceptance file still crashes after repair"` names the `testPath`.
6. [integration] For a Go group whose RED run exits 1 with `./acceptance_test.go:12:5: undefined: ParseConfig` only, `callOp` never receives `acceptanceRepairOp`, and an info log `"RED gate: compile errors are all missing-symbol — expected RED"` names the `testPath`.
7. [integration] For a Go group whose RED run exits 1 with a `syntax error: unexpected }` compile error, `callOp` receives `acceptanceRepairOp` once.
8. [integration] A RED run exiting 1 with a `(fail) AC-1: x` line makes no `acceptanceRepairOp` call.
9. [integration] A RED run exiting 0 makes no `acceptanceRepairOp` call.
10. [integration] When the `acceptanceRepairOp` call rejects, a warn `"RED gate: acceptance repair failed"` names the `testPath`, `runTest` is not called again for it, and the stage returns action `"continue"`.
11. [integration] A group that crashes on both runs contributes 1 to `redFailCount` in the `postrun:phase:completed` event details.
12. [integration] When the `acceptanceRepairOp` call resolves `{ testCode: null }`, `writeFile` is not called for the group's `testPath` after the repair, and `runTest` is still called a second time.
