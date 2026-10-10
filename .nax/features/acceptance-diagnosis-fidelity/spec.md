# SPEC: Acceptance diagnosis fidelity, single-session prompt checks, and acceptance telemetry

## Summary

The acceptance diagnosis decides whether a failing acceptance test is a source bug or a test bug without seeing the acceptance criterion the test is meant to check. It reads only the first 2,000 characters of raw test output, and when its reply cannot be parsed it falls back to `source_bug`. This feature gives the diagnosis and the source-fix session the failing criteria's text, a decision rule tied to that text, and the structured failure summary the fix prompts already use. The parse fallback becomes `test_bug`. Each source-fix and test-fix attempt records the files it changed, and every acceptance loop logs one `acceptance.summary` event, so the next acceptance decision can be read from the run logs. Separately, the single-session prompts gain an edge-case rule and a wiring rule. The `tdd-simple` prompt (also used by `test-after`) and the `batch` prompt get both rules. The `no-test` prompt gets an AC-to-code check, since no-test stories write no tests.

## Motivation

The A2 acceptance retro (nax autonomy plan, 2026-10-10) read all 17 source-fix sessions from 2026-09-10 to 2026-10-10. Three fixed a real defect. Eleven bent production code to fit a generated test: invented factories, alias modules, dual-shape parameters, a symlink tree, a test-only conftest alias. Sixteen of those edits reached `main`. Over the same window, 82.6% of the 654 diagnoses blamed the generated test. Several source-fix verdicts were wrong in ways the criterion text alone would have shown: the test asserted a name, literal or path the AC never states.

Grounded causes on `main`:
- `AcceptancePromptBuilder.buildDiagnosisPrompt` (`packages/nax/src/prompts/builders/acceptance-builder.ts:368`) slices the raw test output to its first 2,000 characters. Runner failures print at the end of the output. #914 moved the fix prompts to `formatTestOutputForFix`, but the diagnosis prompt was missed.
- The diagnosis prompt contains no acceptance criterion text. The diagnoser cannot tell "the source misses the AC" from "the test asserts something the AC never said".
- `acceptanceDiagnoseOp`'s `FALLBACK` (`packages/nax/src/operations/acceptance-diagnose.ts:23`) is `source_bug`, so a parse failure routes to the session that edits production code.
- The source-fix prompt also lacks the criterion text and says nothing against test-only shims.
- `acceptance-source-fix` and `acceptance-test-fix` define no `extractApplied`, so their `findings.cycle` "iteration completed" log lines carry no `fixTargetFiles`. The A2 classification needed hand-matching against tool-audit files.

User rulings: source-fix stays as long as acceptance is on (A2-R1). There is no per-story or per-strategy acceptance switch. Single-session coverage improves through the prompt instead (A2-R2). Single-session covers `tdd-simple`, `test-after`, `batch` and `no-test`.

## Design

### Approach

All changes are deterministic prompt text, data plumbing and logging. No new LLM call is added.

1. **Failing-criteria resolver (US-001).** `loadRefinedCriteria(featureDir)` reads `<featureDir>/acceptance-refined.json`, the file `acceptance-setup` writes. `resolveFailedCriteria` maps failing `AC-N` ids to criterion text using the generator's numbering. A package group's criteria are the refined entries whose `storyId` belongs to that group, in file order, and the k-th entry (1-based) is `AC-k`. That is the numbering `acceptance-setup` used to build the group's `criteriaList` (`packages/nax/src/pipeline/stages/acceptance-setup.ts:349`). A package group's story ids are the stories that `isInAcceptanceScope` admits and whose `path.join(workdir, storyWorkdir(story))` equals the failing package's `packageDir`. This is the grouping rule of `groupStoriesByPackage` (`packages/nax/src/acceptance/test-path.ts:132`).
2. **Diagnosis prompt (US-001).** It renders the failing criteria, shows the test output through `formatTestOutputForFix`, and states the decision rule. The test file stays a path-only reference (#914). The parse fallback becomes `test_bug`, and the diagnosis records which path produced its verdict.
3. **Source-fix prompt and fix-attempt telemetry (US-002).** The source-fix prompt renders the same failing criteria and the no-shim rule. Both acceptance fix strategies snapshot a git ref before each dispatch and report the files changed since then. `runAcceptanceLoop` logs one `acceptance.summary` per call.
4. **Single-session prompt rules (US-003).** Rule lines are added to `buildRoleTaskSection` for `tdd-simple`, `batch` and `no-test`.

### Prompt text (normative, rendered verbatim)

**Diagnosis: criteria section.** The section is inserted after the `FAILING TEST OUTPUT` block. With one or more resolved criteria:

```
FAILING ACCEPTANCE CRITERIA (the behaviour each failing test is meant to check):
AC-3 [US-002]: <refined text>
  Spec wording: <original text>
```

The `Spec wording:` line appears only when `original` differs from `refined`. With no resolved criteria:

```
FAILING ACCEPTANCE CRITERIA: (criterion text unavailable — judge from the test file and the output)
```

**Diagnosis: decision rule.** These lines are inserted before the response schema:

```
DECISION RULE:
- Read the acceptance test file before deciding.
- source_bug: the failing assertion checks behaviour the criterion text states, or that follows directly from it, and the source does not do it.
- test_bug: the failing assertion depends on a name, literal, shape, file path, import path, fixture or setup step that the criterion text does not state.
- both: only when different failing assertions fall on different sides of this rule.
```

**Source-fix prompt.** This text follows the `TEST OUTPUT` block. The criteria lines render exactly as in the diagnosis section, under the header `FAILING ACCEPTANCE CRITERIA:`, or the header followed by ` (criterion text unavailable)` when none resolved. Then:

```
SOURCE-FIX RULES:
- Change source only to deliver behaviour the criteria above state.
- Do not add aliases, wrapper exports, alternate parameter shapes, symlinks, test-only hooks or config shims whose only purpose is to satisfy this test.
- If the failing assertion needs something the criteria do not state, make no edit and reply with one line: UNRESOLVED: <AC id> — the test asserts <what> that the criterion does not state.
```

**Single-session rule lines.** Each is rendered as one line in the role's `Rules:` list:

- `EDGE_CASE_RULE`: `- Edge cases: for every AC that names a limit, boundary, empty or zero input, malformed input, or an error it raises or returns, write a test for that case, not only the success path.`
- `WIRING_RULE`: `- Wiring: every function, class or module you add must be called from production code (the entry point the story names, or an existing production caller); code that only tests call is not done. When an AC names an entry point (route, command, event, scheduled job), at least one test enters through it.`
- `NO_TEST_AC_CHECK_RULE`: `- AC check: before committing, map every AC to the code that satisfies it and list the mapping in the commit body, one line per AC: AC-N: <file>#<symbol>.`
- `NO_TEST_WIRING_RULE`: `- Wiring: every function, class or module you add must be reachable from an existing production caller; do not leave code that nothing calls.`

`tdd-simple` and `batch` get `EDGE_CASE_RULE` and `WIRING_RULE`. `no-test` gets a `Rules:` list holding `NO_TEST_AC_CHECK_RULE` and `NO_TEST_WIRING_RULE`, placed after its existing `Instructions:` list. The four constants are exported from `packages/nax/src/prompts/sections/role-task.ts`.

### `acceptance.summary` event

`runAcceptanceLoop` emits `logger.info("acceptance", "acceptance.summary", data)` exactly once per call, on every exit path. It does this by becoming a thin wrapper: the current body moves to an inner function, and the wrapper emits the summary in a `finally` block from an accumulator that the inner function fills. Counts aggregate over the whole call, across every failing package. `data`:

```ts
{
  storyId: string | undefined;            // first PRD story, as other acceptance logs
  outcome: "passed" | "failed";
  retries: number;                         // the returned AcceptanceLoopResult.retries, or 0 when absent
  diagnoses: {
    byVerdict: { source_bug: number; test_bug: number; both: number };
    byPath: { "implement-only": number; "test-level": number; llm: number; fallback: number };
  };
  sourceFixAttempts: number;               // fixesApplied entries with strategyName "acceptance-source-fix"
  testFixAttempts: number;                 // fixesApplied entries with strategyName "acceptance-test-fix"
  sourceFixUnresolved: number;             // source-fix fixesApplied entries carrying an unresolved reason
  sourceFixFiles: { production: number; test: number }; // unique targetFiles across all source-fix attempts in the call, split by isTestFile(path) with default patterns (intended: the project-agnostic classifier)
  storyStrategies: Record<string, number>; // count of PRD stories that isInAcceptanceScope admits, per routing.testStrategy; a story without one counts under "unset"
}
```

### Integration

Symbols this feature changes. The baseline exists only to locate the code. It is never the interface to implement.

**`AcceptancePromptBuilder.buildDiagnosisPrompt` / `DiagnosisPromptParams`**: `packages/nax/src/prompts/builders/acceptance-builder.ts:368`, `:86`
- Baseline: `testOutput.slice(0, 2000)`; params `{ testOutput; testFileContent?; acceptanceTestPath?; sourceFiles }`.
- Target: params gain `failedCriteria?: FailedCriterion[]`. The output goes through `formatTestOutputForFix(p.testOutput)`. The criteria section is built from `failedCriteria`.

**`AcceptancePromptBuilder.buildDiagnosisPromptTemplate` / `DiagnosisTemplateParams`**: `:273`, `:122`
- Baseline: `{ truncatedOutput; acceptanceTestPath; sourceFilesSection; maxFileLines }`.
- Target: gains `failedCriteriaSection?: string`. When absent, the template renders the "criterion text unavailable" line. It renders the DECISION RULE block before the schema.

**`AcceptancePromptBuilder.buildSourceFixPrompt` / `SourceFixParams`**: `:309`, `:129`
- Target: params gain `failedCriteria?: FailedCriterion[]`. The prompt renders the criteria lines and the SOURCE-FIX RULES block after `TEST OUTPUT`.

**`acceptanceDiagnoseOp` / `AcceptanceDiagnoseInput` / `AcceptanceDiagnoseOutput` / `FALLBACK`**: `packages/nax/src/operations/acceptance-diagnose.ts`
- Target: input gains `failedCriteria?: FailedCriterion[]`, passed to `buildDiagnosisPrompt`. Output gains `fallback?: true`. `FALLBACK` is `{ verdict: "test_bug", reasoning: "diagnosis failed — falling back to test fix", confidence: 0, fallback: true }`.

**`DiagnosisResult`**: `packages/nax/src/acceptance/types.ts:143`
- Target: gains `path?: "implement-only" | "test-level" | "llm" | "fallback"`.

**`resolveAcceptanceDiagnosis` / `ResolveAcceptanceDiagnosisOptions`**: `packages/nax/src/execution/lifecycle/acceptance-fix.ts`
- Target: `diagnosisOpts` gains `failedCriteria?: FailedCriterion[]`, forwarded in the op input. Only `verdict`, `reasoning`, `confidence`, `findings` and `cost` are copied from the op output, never `fallback`. The result carries `path`: `"implement-only"` and `"test-level"` on the two fast paths, `"fallback"` when the op output has `fallback: true`, otherwise `"llm"`.

**`runAcceptanceLoop` / `runAcceptanceFixCycle`**: `packages/nax/src/execution/lifecycle/acceptance-loop.ts:357`, `:255`
- Target: per failing package, the loop resolves `failedCriteria` with `_failedCriteriaDeps.loadRefinedCriteria(ctx.featureDir)` and `resolveFailedCriteria`, and passes them to `resolveAcceptanceDiagnosis` and `runAcceptanceFixCycle`. The "Diagnosis resolved" log gains `path` and `failedACs`. `runAcceptanceFixCycle` gains a `failedCriteria` parameter, appended last (9th) so existing positional callers keep working. Each strategy makes its own `attemptFileHooks(fixTarget.packageDir ?? ctx.workdir)` call, so the two never share a captured ref. It uses that call's `beforeDispatch` and composes its own `extractApplied` over that call's `changedFiles`. `extractApplied` returns `{ targetFiles }`, and for source-fix also `unresolved: output.unresolved`. The loop emits `acceptance.summary` once per call.

**`acceptanceFixSourceOp` / `AcceptanceFixSourceInput` / `AcceptanceFixOutput`**: `packages/nax/src/operations/acceptance-fix.ts`
- Target: input gains `failedCriteria?: FailedCriterion[]`. `parse` returns `{ applied: true, unresolved?: string }`. When a reply line matches `^UNRESOLVED:\s*(.+)$` (multiline), `unresolved` is the captured text after the prefix, as `autofix-implementer.ts` does.

**`buildRoleTaskSection`**: `packages/nax/src/prompts/sections/role-task.ts:29`
- Target: renders the rule constants above for `tdd-simple`, `batch` and `no-test`. Other roles are unchanged.

Symbols this feature reads but does not change:
- `formatTestOutputForFix(rawOutput: string): string`: `packages/nax/src/prompts/builders/acceptance-builder-helpers.ts`.
- `RefinedCriterion` (`original`, `refined`, `testable`, `storyId`, `refinementFallback`): `packages/nax/src/acceptance/types.ts:22`. The persisted JSON entries also carry `acId`.
- `groupStoriesByPackage`: `packages/nax/src/acceptance/test-path.ts:132`; `storyWorkdir`: `packages/nax/src/utils/path-frame.ts`; `isInAcceptanceScope`: `@/prd`.
- `captureGitRef(workdir): Promise<string | undefined>`: `packages/nax/src/utils/git.ts:34`. `captureWorkingTreeChanges(workdir, baseRef, scopePrefix?): Promise<string[]>`: `packages/nax/src/utils/git.ts:376`. It returns `[]` when `baseRef` is falsy.
- `isTestFile(filePath, patterns?)`: `packages/nax/src/test-runners/detector.ts:43`.
- `FixStrategy.beforeDispatch` / `extractApplied` and the `findings.cycle` "iteration completed" log, which emits `fixTargetFiles`: `packages/nax/src/findings/cycle-types.ts`, `packages/nax/src/findings/cycle-iteration-log.ts:92`.
- `promptStage` single-session dispatch (no-test role, else tdd-simple; batch role for batches): `packages/nax/src/pipeline/stages/prompt.ts:73-105`.

### New module (US-001)

```ts
// src/acceptance/failed-criteria.ts
export interface RefinedCriterionRecord { acId: string; original: string; refined: string; storyId: string }
export interface FailedCriterion { acId: string; storyId: string; original: string; refined: string }

export const _failedCriteriaDeps = { readFile: (p: string) => Bun.file(p).text() };

/** Reads <featureDir>/acceptance-refined.json. Returns [] when featureDir is undefined, the file is missing or unreadable, or its content is not an array of records. Never throws. */
export async function loadRefinedCriteria(featureDir: string | undefined): Promise<RefinedCriterionRecord[]>;

/** Filters `refined` to entries whose storyId is in groupStoryIds (file order), numbers them AC-1..AC-n, and returns the entries whose number is in failedACs, in failedACs order. Ids not found (including "AC-ERROR") are skipped. */
export function resolveFailedCriteria(args: {
  refined: readonly RefinedCriterionRecord[];
  groupStoryIds: ReadonlySet<string>;
  failedACs: readonly string[];
}): FailedCriterion[];

/** Story ids of the acceptance group whose packageDir equals `packageDir` (groupStoriesByPackage's rule). Compares path.resolve(workdir, storyWorkdir(story)) with path.resolve(packageDir). */
export function groupStoryIdsForPackage(prd: PRD, workdir: string, packageDir: string): Set<string>;
```

All four symbols, plus the two types, are re-exported from `packages/nax/src/acceptance/index.ts`.

### New module (US-002)

`acceptance-loop.ts` is 583 lines, and `check:file-sizes` caps source files at 600 raw lines. US-001 therefore first moves `runAcceptanceFixCycle` and `_acceptanceFixCycleDeps` (about 80 lines) out to `packages/nax/src/execution/lifecycle/acceptance-fix-cycle.ts`, unchanged in behaviour, and `acceptance-loop.ts` re-exports both so existing imports and stubs keep working. US-002's strategy edits land in that new file. US-002's summary and fix-attempt logic lives in a second new file:

```ts
// packages/nax/src/execution/lifecycle/acceptance-summary.ts
export const _acceptanceAttemptDeps = { captureGitRef, captureWorkingTreeChanges };

export interface AcceptanceSummaryAccumulator { /* diagnoses by verdict and path, fix-attempt records */ }
export function createAcceptanceSummaryAccumulator(): AcceptanceSummaryAccumulator;
export function recordDiagnosis(acc: AcceptanceSummaryAccumulator, d: DiagnosisResult): void;
export function recordFixIterations(acc: AcceptanceSummaryAccumulator, iterations: readonly Iteration[]): void;
export function emitAcceptanceSummary(acc: AcceptanceSummaryAccumulator, args: { prd: PRD; outcome: "passed" | "failed"; retries: number; storyId?: string }): void;

/** beforeDispatch/extractApplied pair for one acceptance fix strategy. The captured ref lives in this closure. */
export function attemptFileHooks(dir: string): {
  beforeDispatch: () => Promise<void>;
  changedFiles: () => Promise<string[]>;
};
```

Both acceptance fix strategies call git through `_acceptanceAttemptDeps`, following the `_repoScopedFixDeps` precedent in `src/operations/full-suite-rectify.ts:118`.

### Failure Handling

| Failure | Behaviour |
|---|---|
| `acceptance-refined.json` missing, unreadable or not a JSON array | `loadRefinedCriteria` returns `[]`; prompts render the "criterion text unavailable" form; no throw |
| a failing AC id has no mapped criterion (including `AC-ERROR`) | that id is skipped; the remaining ids still resolve |
| diagnosis reply unparseable or missing `verdict` / `reasoning` / `confidence` | `FALLBACK`: verdict `test_bug`, confidence 0, `fallback: true`; diagnosis `path` is `"fallback"` |
| `captureGitRef` returns `undefined` before a fix attempt | that attempt's `targetFiles` is `[]` |
| source-fix reply has an `UNRESOLVED:` line | `unresolved` carries the text after the prefix. The existing give-up handling applies (`handleGiveUps`, `src/findings/cycle-execute.ts:81`): when every strategy that ran gave up, the cycle exits `agent-gave-up`, and the loop's final acceptance check decides the outcome. |
| source-fix reply has no `UNRESOLVED:` line | `unresolved` is absent; the cycle proceeds to validation as today |

## Out of Scope

- A per-story or per-test-strategy switch for acceptance; acceptance stays a feature-level setting (ruling A2-R2).
- A separate switch that disables source-fix while acceptance stays on (ruling A2-R1).
- Capping source-fix rounds that make no edit (ruling A2-R3 left it unpursued).
- Changing the `implement-only` fast path or the >80% test-level fast path in `resolveAcceptanceDiagnosis`; only their recorded `path` is new.
- Embedding the acceptance test file body in the diagnosis or source-fix prompt; the path-only reference from #914 stays.
- Reconciling the global `acId` numbering written into `acceptance-refined.json` with the per-package numbering the generator uses in multi-package features; the resolver follows the generator's per-package numbering and ignores the stored `acId`.
- Attributing acceptance cost or time per role in `metrics.json`; the cost ledger already records `stage` and `sessionRole` per session.
- Excluding files that were already untracked before a fix attempt from that attempt's `targetFiles`.
- Enforcing the source-fix rules in code (for example rejecting a diff that adds an alias); they are prompt rules, and `acceptance.summary` measures their effect.
- Changing the three-session test-writer, implementer or verifier prompts.
- Changing the acceptance test-fix prompt.

## Stories

1. **US-001: failing-criteria resolver and diagnosis fidelity** — `Workdir: packages/nax` — no dependencies. Adds `packages/nax/src/acceptance/failed-criteria.ts`. The diagnosis prompt gains the criteria section, the decision rule and the formatted output. The diagnosis op gets the `test_bug` fallback and the `fallback` marker. `resolveAcceptanceDiagnosis` records `path`. `runAcceptanceFixCycle` and `_acceptanceFixCycleDeps` move to `acceptance-fix-cycle.ts`, re-exported from `acceptance-loop.ts`. `runAcceptanceLoop` resolves and forwards the failing criteria and logs `path` and `failedACs` on "Diagnosis resolved".
2. **US-002: source-fix criteria, fix-attempt files and `acceptance.summary`** — `Workdir: packages/nax` — depends on US-001. The source-fix prompt renders the criteria and SOURCE-FIX RULES. `acceptanceFixSourceOp.parse` extracts `UNRESOLVED:`. Both acceptance fix strategies record changed files through `beforeDispatch` and `extractApplied`. `runAcceptanceLoop` emits `acceptance.summary` once per call.
3. **US-003: single-session prompt rules** — `Workdir: packages/nax` — no dependencies. The four rule constants are added to `packages/nax/src/prompts/sections/role-task.ts`, and `buildRoleTaskSection` renders them for `tdd-simple`, `batch` and `no-test`.

Paths are repo-rooted. Every story is `Workdir: packages/nax`.

### Context Files

**US-001**
- `packages/nax/src/prompts/builders/acceptance-builder.ts` — `buildDiagnosisPrompt`, `buildDiagnosisPromptTemplate` and their param types
- `packages/nax/src/operations/acceptance-diagnose.ts` — the op, its input and output types and `FALLBACK`
- `packages/nax/src/execution/lifecycle/acceptance-fix.ts` — `resolveAcceptanceDiagnosis` and its fast paths
- `packages/nax/src/execution/lifecycle/acceptance-loop.ts` — the per-package diagnosis call and the "Diagnosis resolved" log
- `packages/nax/src/acceptance/test-path.ts` — `groupStoriesByPackage`, the grouping rule to mirror

**US-002**
- `packages/nax/src/execution/lifecycle/acceptance-loop.ts` — `runAcceptanceFixCycle` strategies and `runAcceptanceLoop` exits
- `packages/nax/src/operations/acceptance-fix.ts` — `acceptanceFixSourceOp` and its parse
- `packages/nax/src/prompts/builders/acceptance-builder.ts` — `buildSourceFixPrompt`
- `packages/nax/src/findings/cycle-types.ts` — `beforeDispatch`, `extractApplied`, `FixApplied`
- `packages/nax/src/acceptance/failed-criteria.ts` — created by US-001, consumed here
- `packages/nax/src/execution/lifecycle/acceptance-fix-cycle.ts` — created by US-001; the fix strategies edited here
- `packages/nax/src/operations/full-suite-rectify.ts` — the `_repoScopedFixDeps` git-seam precedent

**US-003**
- `packages/nax/src/prompts/sections/role-task.ts` — `buildRoleTaskSection`
- `packages/nax/src/pipeline/stages/prompt.ts` — single-session and batch role dispatch
- `packages/nax/test/unit/pipeline/stages/prompt-tdd-simple.test.ts` — the prompt-stage harness to mirror

### Creates

**US-001**
- `packages/nax/src/acceptance/failed-criteria.ts`
- `packages/nax/src/execution/lifecycle/acceptance-fix-cycle.ts` — `runAcceptanceFixCycle` and `_acceptanceFixCycleDeps`, moved from `acceptance-loop.ts`
- `packages/nax/test/unit/acceptance/failed-criteria.test.ts`

**US-002**
- `packages/nax/src/execution/lifecycle/acceptance-summary.ts`
- `packages/nax/test/unit/execution/lifecycle/acceptance-loop-summary.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/operations/acceptance-diagnose.test.ts` — the tests "falls back to source_bug on malformed JSON" and "falls back to source_bug on missing fields" assert verdict `source_bug`; the fallback is now `test_bug` with `fallback: true`, so they assert verdict `test_bug` instead.
- `packages/nax/test/unit/prompts/__snapshots__/acceptance-builder.test.ts.snap` — the snapshot "buildDiagnosisPromptTemplate() snapshot stability no verdicts" pins the old template; the template now renders the criteria-unavailable line and the DECISION RULE block, so the snapshot is regenerated to the new template text.

### Seams

- US-001 internal: `resolveFailedCriteria` and `loadRefinedCriteria` are consumed by `runAcceptanceLoop`. Seam AC in US-001 enters at `runAcceptanceLoop` with `_failedCriteriaDeps.readFile` returning a refined-criteria JSON and `_diagnosisDeps.callOp` spied.
- US-001 → US-002: `FailedCriterion` values reach the source-fix strategy. Seam AC in US-002 enters at `runAcceptanceLoop` and asserts the source-fix op input carries the resolved criteria.
- US-003: the rule constants reach agents through `promptStage`. Seam ACs enter at `promptStage.execute` for a `test-after` story and a `no-test` story.

## Acceptance Criteria

Acceptance-loop tests (US-001 AC 21-22, US-002 AC 6-15) run `runAcceptanceLoop` with the real `runFixCycle`. They stub:
- the diagnosis through `_diagnosisDeps.callOp`;
- fix-op dispatch through `_cycleDeps.callOp` (from `@/findings`). That stub returns already-parsed op output, e.g. `{ applied: true }`, or `{ applied: true, unresolved: "..." }` for a give-up;
- acceptance runs through `_runAcceptanceTestsOnceDeps`;
- `_acceptanceFixScopeDeps.buildRunDispatchAskWiring`;
- git through `_acceptanceAttemptDeps`, with `captureGitRef` resolving `"abc"` and `captureWorkingTreeChanges` resolving `[]` unless the AC says otherwise.

The advisor is disabled in the test config. Logs are captured inline, as in `acceptance-loop-routing.test.ts`: `resetLogger(); initLogger({ level: "info", headless: true, useChalk: false }); addSink(entry => ...)`. Assertions read `entry.message` and `entry.data`. "The `acceptance.summary` entry" is the captured entry whose message is `acceptance.summary`. "The refined JSON" in an AC means `_failedCriteriaDeps.readFile` returns `[{"acId":"AC-1","original":"o1","refined":"r1","storyId":"US-001"},{"acId":"AC-2","original":"o2","refined":"r2","storyId":"US-002"},{"acId":"AC-3","original":"o3","refined":"o3","storyId":"US-002"}]`.

### US-001: failing-criteria resolver and diagnosis fidelity

1. [unit] `resolveFailedCriteria` given the three refined records above, `groupStoryIds` `{"US-001","US-002"}` and `failedACs` `["AC-2"]` returns `[{ acId: "AC-2", storyId: "US-002", original: "o2", refined: "r2" }]`.
2. [unit] `resolveFailedCriteria` given the same records, `groupStoryIds` `{"US-002"}` and `failedACs` `["AC-1"]` returns the record whose `refined` is `"r2"` with `acId` `"AC-1"` (numbering restarts within the group).
3. [unit] `resolveFailedCriteria` given `failedACs` `["AC-ERROR", "AC-9", "AC-1"]` and `groupStoryIds` `{"US-001","US-002"}` returns exactly one entry, with `acId` `"AC-1"`.
4. [unit] `loadRefinedCriteria(undefined)` resolves `[]`.
5. [unit] With `_failedCriteriaDeps.readFile` rejecting with an error, `loadRefinedCriteria("/f")` resolves `[]`.
6. [unit] With `_failedCriteriaDeps.readFile` resolving `"{\"not\":\"an array\"}"`, `loadRefinedCriteria("/f")` resolves `[]`.
7. [unit] `groupStoryIdsForPackage` for a PRD with `US-001` (no workdir) and `US-002` (workdir `apps/api`), workdir `/repo/` (trailing slash) and packageDir `/repo/apps/api` returns a set containing only `"US-002"`.
8. [unit] `buildDiagnosisPrompt` with `failedCriteria` `[{ acId: "AC-2", storyId: "US-002", original: "o2", refined: "r2" }]` returns text that includes the line `AC-2 [US-002]: r2` and the line `  Spec wording: o2`.
9. [unit] `buildDiagnosisPrompt` with `failedCriteria` `[{ acId: "AC-3", storyId: "US-002", original: "o3", refined: "o3" }]` returns text with no `Spec wording:` line.
10. [unit] `buildDiagnosisPrompt` with no `failedCriteria` returns text that includes `FAILING ACCEPTANCE CRITERIA: (criterion text unavailable — judge from the test file and the output)`.
11. [unit] `buildDiagnosisPrompt` returns text that includes the line `DECISION RULE:` and, after it, the `test_bug:` rule line as given in Design.
12. [unit] `buildDiagnosisPrompt` given a bun-format `testOutput` of 100 lines `(pass) AC-1: ok [1ms]`, then the line `error: expected 2 got 3`, then the line `(fail) AC-2: returns two [1ms]`, then the footer lines ` 100 pass` and ` 1 fail`, returns text that includes `expected 2 got 3`.
13. [unit] For the same input, `buildDiagnosisPrompt` returns text that does not include `(pass) AC-1: ok`.
14. [unit] `acceptanceDiagnoseOp.parse("could not diagnose", input, ctx)` returns verdict `"test_bug"`, confidence `0` and `fallback` `true`.
15. [unit] `acceptanceDiagnoseOp.parse` given valid JSON `{"verdict":"source_bug","reasoning":"r","confidence":0.8}` returns an output with no `fallback` property.
16. [unit] `resolveAcceptanceDiagnosis` with strategy `"implement-only"` returns `path` `"implement-only"`.
17. [unit] `resolveAcceptanceDiagnosis` where 9 of 10 ACs failed returns `path` `"test-level"`.
18. [unit] `resolveAcceptanceDiagnosis` with `_diagnosisDeps.callOp` resolving `{ verdict: "test_bug", reasoning: "x", confidence: 0, fallback: true }` returns `path` `"fallback"`.
19. [unit] `resolveAcceptanceDiagnosis` with `_diagnosisDeps.callOp` resolving `{ verdict: "source_bug", reasoning: "x", confidence: 0.7 }` returns `path` `"llm"`.
20. [unit] `resolveAcceptanceDiagnosis` given `diagnosisOpts.failedCriteria` of one entry calls `_diagnosisDeps.callOp` with an input whose `failedCriteria` equals that one-entry array.
21. [integration] With the refined JSON, a PRD whose stories `US-001` (one AC) and `US-002` (two ACs) have no workdir (one root package group), acceptance failing only `AC-2` of the 3, and `_diagnosisDeps.callOp` spied, `runAcceptanceLoop` calls the spy with an input whose `failedCriteria` is `[{ acId: "AC-2", storyId: "US-002", original: "o2", refined: "r2" }]`.
22. [integration] In the same setup, the "Diagnosis resolved" log entry `runAcceptanceLoop` emits carries `path` `"llm"` and `failedACs` `["AC-2"]`.

Verification note (US-001): `bun run check:file-sizes` stays green, so `acceptance-loop.ts` is at most 600 lines after the move. `runAcceptanceFixCycle` and `_acceptanceFixCycleDeps` stay importable from `@/execution/lifecycle/acceptance-loop`, which the existing `acceptance-loop-cycle.test.ts` and `acceptance-fix-scope.test.ts` confirm by compiling and passing unchanged.

### US-002: source-fix criteria, fix-attempt files and `acceptance.summary`

1. [unit] `buildSourceFixPrompt` with `failedCriteria` `[{ acId: "AC-2", storyId: "US-002", original: "o2", refined: "r2" }]` returns text that includes `FAILING ACCEPTANCE CRITERIA:` followed by the line `AC-2 [US-002]: r2`.
2. [unit] `buildSourceFixPrompt` returns text that includes the line `SOURCE-FIX RULES:` and the `UNRESOLVED:` rule line as given in Design.
3. [unit] `buildSourceFixPrompt` with no `failedCriteria` returns text that includes `FAILING ACCEPTANCE CRITERIA: (criterion text unavailable)`.
4. [unit] `acceptanceFixSourceOp.parse("Looked at it.\nUNRESOLVED: AC-2 — the test asserts createClient that the criterion does not state", input, ctx)` returns `unresolved` equal to `AC-2 — the test asserts createClient that the criterion does not state`.
5. [unit] `acceptanceFixSourceOp.parse("fixed the bug", input, ctx)` returns an output with no `unresolved` property.
6. [integration] With the refined JSON, acceptance failing `AC-2`, the diagnosis stubbed to `source_bug`, and the source-fix op dispatch spied, `runAcceptanceLoop` dispatches the source-fix op with an input whose `failedCriteria` is `[{ acId: "AC-2", storyId: "US-002", original: "o2", refined: "r2" }]`.
7. [integration] With `_acceptanceAttemptDeps.captureGitRef` resolving `"abc"` and `_acceptanceAttemptDeps.captureWorkingTreeChanges` resolving `["src/a.ts", "test/a.test.ts"]`, one source-fix attempt in `runAcceptanceLoop` yields an "iteration completed" log entry whose `fixTargetFiles` is `["src/a.ts", "test/a.test.ts"]`.
8. [integration] With `_acceptanceAttemptDeps.captureGitRef` resolving `undefined`, one test-fix attempt yields an "iteration completed" log entry whose `fixTargetFiles` equals `[]`, and `_acceptanceAttemptDeps.captureWorkingTreeChanges` is called with `undefined` as its ref.
9. [integration] When acceptance passes on its first run, `runAcceptanceLoop` emits exactly one `acceptance.summary` entry, with `outcome` `"passed"`, `sourceFixAttempts` `0` and `diagnoses.byVerdict.source_bug` `0`.
10. [integration] When acceptance fails, the diagnosis returns `source_bug` via the LLM path, one source-fix attempt changes `["src/a.ts", "test/a.test.ts"]`, and the rerun passes, `acceptance.summary` has `diagnoses.byPath.llm` `1`, `sourceFixAttempts` `1` and `sourceFixFiles` `{ production: 1, test: 1 }`.
11. [integration] When the diagnosis returns `source_bug`, the `_cycleDeps.callOp` stub returns `{ applied: true, unresolved: "AC-2 — not stated" }` for the source-fix op, and the final acceptance check still fails, `runAcceptanceLoop` emits exactly one `acceptance.summary` entry, with `outcome` `"failed"` and `sourceFixUnresolved` `1`.
12. [integration] For a PRD with two `tdd-simple` stories and one `no-test` story, `acceptance.summary.storyStrategies` equals `{ "tdd-simple": 2, "no-test": 1 }`.
13. [integration] When `runAcceptanceLoop` returns through the "Runtime not found for diagnosis" exit, it emits exactly one `acceptance.summary` entry, with `outcome` `"failed"`.
14. [integration] When the acceptance run fails with no failed ACs reported (the "no specific failures detected" exit), `runAcceptanceLoop` emits exactly one `acceptance.summary` entry, with `outcome` `"failed"`.
15. [integration] When `acceptance.maxRetries` is `0` and the first acceptance run fails, `runAcceptanceLoop` returns through the max-retries exit and emits exactly one `acceptance.summary` entry, with `outcome` `"failed"` and `retries` equal to the returned result's `retries` (or `0` when absent).

### US-003: single-session prompt rules

1. [unit] `buildRoleTaskSection("tdd-simple")` returns text that includes `EDGE_CASE_RULE` exactly as exported from `packages/nax/src/prompts/sections/role-task.ts`.
2. [unit] `buildRoleTaskSection("tdd-simple")` returns text that includes `WIRING_RULE`.
3. [unit] `buildRoleTaskSection("batch")` returns text that includes both `EDGE_CASE_RULE` and `WIRING_RULE`.
4. [unit] `buildRoleTaskSection("no-test")` returns text that includes `NO_TEST_AC_CHECK_RULE` and `NO_TEST_WIRING_RULE`.
5. [unit] `buildRoleTaskSection("no-test")` returns text that does not include `EDGE_CASE_RULE` (no-test stories write no tests).
6. [unit] `buildRoleTaskSection("no-test")` still includes the line `- Do NOT create or modify test files`.
7. [unit] `buildRoleTaskSection("implementer", "standard")` returns text that includes neither `EDGE_CASE_RULE` nor `WIRING_RULE`.
8. [unit] `EDGE_CASE_RULE` equals the `EDGE_CASE_RULE` string given in Design, and `NO_TEST_AC_CHECK_RULE` equals the string given there.
9. [integration] `promptStage.execute` for a single story whose `routing.testStrategy` is `"test-after"` sets `ctx.prompt` to text that includes `WIRING_RULE`.
10. [integration] `promptStage.execute` for a single story whose `routing.testStrategy` is `"no-test"` and that has a `noTestJustification` sets `ctx.prompt` to text that includes `NO_TEST_AC_CHECK_RULE`.
11. [integration] `promptStage.execute` for a batch of two stories sets `ctx.prompt` to text that includes `EDGE_CASE_RULE`.
