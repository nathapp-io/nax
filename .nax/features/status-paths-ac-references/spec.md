# SPEC: Status and plan report wrong answers silently — `nax status` reads the wrong feature directory, and numeric AC references survive AC renumbering

## Summary

This feature fixes two places where nax reports a wrong answer without saying anything is wrong. First, `nax status -f <feature>` prints "No prd.json found" for every planned feature, and `nax status` (the all-features table) shows zero counts, no cost and no crash state (#2284). Both views read `prd.json` and the feature `status.json` from the per-user output directory, but `nax plan` and `nax run` write them to the repo's `.nax/features/<feature>/`. The fix reads those two files from the repo feature directory, keeps reading run logs from the output directory, and resolves the project root by walking up from `--dir` the way `nax run` does. Second, `nax plan` splits compound acceptance criteria and renumbers every later AC, so an AC whose text says "the AC-14 setup" points at a different criterion in the PRD (#2283). The fix adds one shared matcher for numeric AC references, a `nax spec lint` warning when a spec AC contains one, and a post-plan warning when a PRD AC contains one.

## Motivation

- **#2284, single feature.** `displayFeatureStatus` (`src/cli/status-features.ts:388`) has two branches. With `options.dir` it builds `join(projectOutputDir(projectKey, config?.outputDir), "features", feature)`, the per-user output directory. Without it, it uses `resolveProject({ feature })`, the repo directory. `nax status` declares `-d, --dir <path>` with a default of `process.cwd()` (`src/cli/status-dispatch.ts:156`), so `options.dir` is always set and the output-directory branch always runs. `nax plan` writes `prd.json` to the repo feature directory (`src/plan/strategies/context-builder.ts:28-29`), and `nax run` writes the feature `status.json` there too (`bin/nax.ts:274`, `writeFeatureStatus` in `src/execution/status-writer.ts:308`). The output directory holds only `runs/`. So `displayFeatureDetails`'s `existsSync(prdPath)` guard always fails and prints the "No prd.json found" notice.
- **#2284, all features.** `displayAllFeatures` (`src/cli/status-features.ts:235`) lists `<outputDir>/features/*` and reads each feature's `prd.json` and `status.json` from there. In real use neither file exists there, so every row reads 0/0/0 with no cost and no crash state. A feature that was planned but never run has no output directory, so it is not listed at all.
- **#2284, subdirectory.** `runStatusAction` walks up from `--dir` to find `.nax/`, but `displayFeatureStatus` receives the raw `--dir`. From a package subdirectory, the all-features branch calls `resolveProject({ dir })`, which throws `NAX_DIR_NOT_FOUND`.
- **Why tests missed it.** Every status test stubs `_statusFeaturesDeps.projectOutputDir` to return `<testDir>/.nax`. That makes the output feature directory and the repo feature directory the same path, so no test can tell them apart.
- **#2283.** The plan prompt says "One assertion per AC" (`src/prompts/builders/plan-builder.ts:426`), so the planner splits compound ACs, and every AC after a split is renumbered. A criterion that points at another by number ("In the AC-7 shape", "Given the AC-14 setup") keeps the old number, so in the PRD it points at a different criterion. Stories run in isolated sessions, and the implementer sees only the PRD's criteria. On the `tmp-confinement` plan (v0.83.0-canary.1), three split ACs said "Given the AC-14 setup", and PRD AC-14 was a stubbed-backend test that *allows* `/tmp`. Read literally, the story could not be satisfied. `nax spec lint`, `nax plan` and PRD validation all passed it. A manual fidelity review caught it. Across this repo's 4,941 planned ACs, 17 contain an `AC-<n>` token.

## Design

### Integration

Symbols this feature only reads:

- `findProjectDir(startDir?: string): string | null` — `src/config/loader.ts:284`, exported from `@/config`. It walks up from `startDir` to the first directory holding `.nax/config.json` and returns that `.nax` directory's path, or `null`.
- `featureDir(root: string, featureId: string): string` and `featuresDir(root: string): string` — `src/config/paths/index.ts:104-117`, exported from `@/config`. These are the feature-path SSOT; `scripts/check-feature-dir-ssot.ts` rejects an open-coded `join(root, ".nax", "features", …)`.
- `projectOutputDir(projectKey: string, outputDirOverride: string | undefined): string` — `src/runtime/paths.ts:19`.
- `displayFeatureDetails(featureName: string, featureDir: string): Promise<void>` — `src/cli/status-features.ts:337`. It reads `prd.json` and `status.json` from `featureDir` and prints the "No prd.json found" notice when `prd.json` is absent. It is unchanged; only the directory passed to it changes.
- `loadProjectStatusFile(projectDir)` — `src/cli/status-features.ts`. It reads `<outputDir>/status.json`, which is correct and unchanged.
- `runStatusAction`, `dispatchStatusView`, `registerStatusCommand` — `src/cli/status-dispatch.ts`, unchanged.
- `checkAcceptanceCriteria(lines, maxAcCount)` (private) — `src/prd/spec-lint.ts:328`. It walks `## Acceptance Criteria`, tracks the current `### US-<n>` heading and counts `^\d+\.\s` bullets per story.
- `BLOCKING_SPEC_LINT_CODES` — `src/prd/spec-lint.ts:79`, unchanged. The new code is deliberately not a member.
- `assertSpecLintClean(specContent, options)` — `src/plan/spec-lint-gate.ts:51`. It returns non-blocking findings, and `src/plan/strategies/context-builder.ts:40-51` logs them as `"Spec lint findings — planning anyway"`, so a new warn code reaches `nax plan` output with no further wiring.
- `specLintCommand(options, deps)` — `src/cli/spec-lint-command.ts:174`. Warnings never change its exit code, including under `--strict`.
- `warnOnDroppedContextFiles(prd, specContent, featureName)` — `src/operations/plan-fidelity.ts:126`. This is the warn-only post-plan check to mirror.
- `PRD`, `UserStory` — `src/prd/types.ts`. `UserStory.acceptanceCriteria` is `string[]`.

Symbols this feature changes. Each `Baseline:` exists only to locate the code and is never the interface to implement; implement the `Target:`.

- `_statusFeaturesDeps` — `src/cli/status-features.ts:27`
  - Baseline: `{ projectOutputDir, loadConfig }`
  - Target: `{ projectOutputDir, loadConfig, findProjectDir }`, where `findProjectDir` defaults to the `@/config` export
- `displayFeatureStatus(options: FeatureStatusOptions = {}): Promise<void>` — same signature. Whenever `options.dir` is given, it resolves `projectRoot` by the Approach's project-root rule, in both branches:
  - Baseline, single feature: `featureDir = join(projectOutputDir(...), "features", feature)`. Target: `displayFeatureDetails(feature, featureDir(projectRoot, feature))`.
  - Baseline, all features: `displayAllFeatures(resolveProject({ dir: options.dir }).projectDir)`, which throws `NAX_DIR_NOT_FOUND` from a subdirectory because `resolveProject` does not walk up. Target: `displayAllFeatures(projectRoot)`.
  - Without `options.dir`, both branches keep calling `resolveProject` as today.
- `displayAllFeatures(projectDir)` (private) — lists `featuresDir(projectDir)` instead of `<outputDir>/features`
- `getFeatureSummary` (private)
  - Baseline: `getFeatureSummary(featureName: string, featureDir: string): Promise<FeatureSummary>`, which reads `runs/` under `featureDir`
  - Target: `getFeatureSummary(featureName: string, featureDir: string, runsDir: string): Promise<FeatureSummary>`, which reads `prd.json` and `status.json` from `featureDir` and run logs from `runsDir`
- New export `findAcNumericReferences(text: string): string[]` — new file `src/prd/ac-references.ts`, re-exported from the `src/prd` barrel
- `checkAcceptanceCriteria` (private) — `src/prd/spec-lint.ts`: gains the `ac-numeric-reference` warn
- New export `warnOnAcCrossReferences(prd: PRD, featureName: string): void` — `src/operations/plan-fidelity.ts`
- `applyPlanFidelity(prd: PRD, specContent: string, featureName: string): PRD` — same signature; it calls `warnOnAcCrossReferences` on the repaired PRD after `warnOnDroppedContextFiles`

### Approach

**Status paths (US-001).** `prd.json` and the feature `status.json` are VCS-side inputs and run state written into the repo feature directory. Run logs (`runs/*.jsonl`) are per-user output. The status views read each from where its writer puts it:

1. **Project root.** When `options.dir` is given, `projectRoot` is the parent of `_statusFeaturesDeps.findProjectDir(resolve(options.dir))`. If that returns `null`, `projectRoot` is `resolve(options.dir)`. This mirrors `nax run` (`bin/nax.ts:243-275`), which walks up from its workdir and takes the `.nax` directory's parent.
2. **Single feature.** `displayFeatureDetails(feature, featureDir(projectRoot, feature))`.
3. **All features.** `displayAllFeatures(projectRoot)` lists the subdirectories of `featuresDir(projectRoot)`, sorted by name. For each, `getFeatureSummary(name, featureDir(projectRoot, name), join(outputDir, "features", name, "runs"))`, where `outputDir` is `projectOutputDir(config?.name?.trim() || basename(projectRoot), config?.outputDir)`, with the config loaded as today (`.catch(() => null)`). A directory that exists only under `<outputDir>/features/` is not listed, because it has no PRD to summarise. When `featuresDir(projectRoot)` is absent or holds no subdirectories, the view prints `No features found.` as today.

The project-level banner (`loadProjectStatusFile`) keeps reading `<outputDir>/status.json`.

**Numeric AC references (US-002).** `findAcNumericReferences(text)` first removes every inline code span (text between a pair of backticks), then collects each match of `\bAC[- ](\d+)\b`: an uppercase `AC`, then one hyphen or one space, then digits, then a word boundary. It returns each match normalised to `AC-<digits>`, deduplicated, in first-seen order. Code spans are removed because a quoted `AC-1: a` is data, such as a test title, not a pointer at another criterion. `AC-ERROR` and `AC-HOOK` have no digits, so they never match.

- **Spec lint.** For every AC bullet that `checkAcceptanceCriteria` already counts, a non-empty result adds one finding: level `warn`, code `ac-numeric-reference`, message `<story> AC <n> refers to another criterion by number (<refs joined by ", ">). nax plan splits compound ACs and renumbers the rest, so the number can point at a different criterion in the PRD — name the setup instead.` The code is not added to `BLOCKING_SPEC_LINT_CODES`, so it neither fails `nax spec lint` nor blocks `nax plan`.
- **Post-plan.** `warnOnAcCrossReferences(prd, featureName)` walks every story's `acceptanceCriteria`. For each AC with a non-empty result it logs one warn from stage `plan`, message `PRD acceptance criterion refers to another criterion by number — AC numbering is not stable across plan runs`, data `{ storyId, featureName, acIndex, references }`, where `acIndex` is 1-based. It never changes the PRD. `applyPlanFidelity` calls it last, after `warnOnDroppedContextFiles`, so both plan strategies (`src/operations/plan.ts:111`, `src/operations/plan-refine.ts:425`) and `finalizeAndWritePrd` get it.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| `--dir` has no `.nax/config.json` at or above it | `projectRoot` is `resolve(--dir)`; the single-feature view prints the "No prd.json found" notice. (The CLI already exits earlier with "nax not initialized.") |
| The repo feature directory has no `prd.json` | The single-feature view prints `No prd.json found. Run: nax plan -f <feature> --from <spec>`; the table row reads 0/0/0 as today |
| The feature's `runs/` directory is absent under the output directory | The table row's last run reads `No runs yet` |
| `.nax/config.json` cannot be loaded | The output directory key falls back to `basename(projectRoot)`, as today |
| `featuresDir(projectRoot)` is absent | The all-features view prints `No features found.` |
| A spec AC or PRD AC contains a numeric reference only inside backticks | No finding and no warn |

## Out of Scope

- Changing the plan prompt so the planner rewrites or inlines numeric AC references when it splits a criterion.
- Making `ac-numeric-reference` a blocking spec-lint code, or failing `nax plan` on a PRD AC that contains a numeric reference.
- Rewriting or stripping numeric AC references in the PRD.
- The project-key mismatch where `nax run` keys its output directory on `basename(workdir)` while `nax status` keys it on `basename(projectRoot)` when `config.name` is unset.
- Listing features that exist only under the per-user output directory in the all-features table.
- `nax status --cost` and its sub-views, which read run metrics, not feature directories.
- `src/pipeline/subscribers/registry.ts:65` recording `statusPath` under the output directory in `meta.json`, and `src/commands/migrate.ts` classifying a feature `status.json` as generated content.
- #1796: acceptance-refine's retry-once-then-warn already shipped in #2272; the unmarked fallback in `src/acceptance/hardening.ts` has no reader for `refinementFallback` and is not changed here.

## Stories

1. **US-001: nax status reads the repo feature directory** — no dependencies
2. **US-002: Numeric AC references are reported at spec lint and after plan** — no dependencies

### Context Files

**US-001**
- `src/cli/status-features.ts` — `displayFeatureStatus`, `displayAllFeatures`, `getFeatureSummary`, `_statusFeaturesDeps`
- `src/cli/status-features-details.ts` — `displayNoPrdNotice`, `displayRunStatusSection`
- `src/cli/status-dispatch.ts` — `registerStatusCommand`, `runStatusAction`, `_statusCommandActionDeps`
- `src/config/paths/index.ts` — `featureDir`, `featuresDir`
- `test/unit/cli/status-features.test.ts` — the existing fixture and stub pattern (710 lines, so new tests go in a new file)

**US-002**
- `src/prd/spec-lint.ts` — `checkAcceptanceCriteria`, `BLOCKING_SPEC_LINT_CODES`, the `out-of-scope-unprefixed-hoist` warn to mirror
- `src/operations/plan-fidelity.ts` — `applyPlanFidelity`, `warnOnDroppedContextFiles`
- `src/prd/index.ts` — the barrel
- `src/plan/spec-lint-gate.ts` — `assertSpecLintClean`
- `test/unit/operations/plan-fidelity.test.ts` — the logger-capture pattern

### Creates

**US-001**
- `test/unit/cli/status-features-repo-paths.test.ts` — the US-001 tests, with the output directory stubbed to a separate temp dir

**US-002**
- `src/prd/ac-references.ts` — `findAcNumericReferences`
- `test/unit/prd/ac-references.test.ts` — the matcher tests

### Modifies

None. US-001: every existing status test stubs `projectOutputDir` to `<testDir>/.nax`, so `featureDir(testDir, name)` and `featuresDir(testDir)` resolve to the paths those tests already populate, and their expectations hold. US-002: no existing spec-lint or plan-fidelity test fixture carries an AC with a numeric `AC-<n>` reference, and the new code is warn-only and non-blocking.

### Seams

- US-001 AC13: `registerStatusCommand` → `runStatusAction` → `dispatchStatusView` → `displayFeatureStatus` reads the repo feature directory, observed through the printed story ids with the real action deps.
- US-002 AC11: `lintSpecContent` → `checkAcceptanceCriteria` → `findAcNumericReferences`, observed through `assertSpecLintClean`'s returned findings.
- US-002 AC16: `applyPlanFidelity` → `warnOnAcCrossReferences`, observed through the logger.

## Acceptance Criteria

The status fixture used by US-001: a temp project root `R` holding `.nax/config.json` with `{"name":"status-fixture"}`; `_statusFeaturesDeps.projectOutputDir` stubbed to return a separate temp dir `O` that is not under `R`; and `R/.nax/features/feat-a/prd.json` with feature `feat-a` and two stories, `US-001` with status `passed` and `US-002` with status `pending`.

### US-001

1. `[unit]` In the status fixture, `displayFeatureStatus({ feature: "feat-a", dir: R })` prints both `US-001` and `US-002`, and never prints `No prd.json found`.
2. `[unit]` In the status fixture, with `R/.nax/features/feat-a/status.json` holding a usable status file whose `run.status` is `crashed`, `displayFeatureStatus({ feature: "feat-a", dir: R })` prints `Crashed Run Detected`.
3. `[unit]` In the status fixture, with an existing subdirectory `R/packages/app` that has no `.nax/` of its own, `displayFeatureStatus({ feature: "feat-a", dir: join(R, "packages", "app") })` prints `US-001` and never prints `No prd.json found`.
4. `[unit]` In the status fixture, with `O/features/feat-a/prd.json` holding a different PRD whose only story is `US-099`, `displayFeatureStatus({ feature: "feat-a", dir: R })` prints `US-001` and never prints `US-099`.
5. `[unit]` In the status fixture, with `R/.nax/features/feat-b/` present and holding no `prd.json`, `displayFeatureStatus({ feature: "feat-b", dir: R })` prints `No prd.json found. Run: nax plan -f feat-b --from <spec>`.
6. `[unit]` In the status fixture, with `R/.nax/features/feat-b/prd.json` holding one pending story and no `O/features/` directory at all, `displayFeatureStatus({ dir: R })` prints one table row that starts with `feat-a` and one that starts with `feat-b`.
7. `[unit]` In the status fixture, `displayFeatureStatus({ dir: R })` prints a `feat-a` row whose Done column is `1` and whose Pending column is `1`.
8. `[unit]` In the status fixture, with a run log `O/features/feat-a/runs/2026-09-28T10-00-00.jsonl`, `displayFeatureStatus({ dir: R })` prints a `feat-a` row whose Last Run column is `2026-09-28T10-00-00`.
9. `[unit]` In the status fixture, with `R/.nax/features/feat-a/status.json` holding a usable status file whose `cost.spent` is `1.5` and whose `run.status` is `completed`, `displayFeatureStatus({ dir: R })` prints a `feat-a` row whose Cost column is `$1.5000`.
10. `[unit]` In the status fixture, with `O/features/ghost/runs/2026-09-28T10-00-00.jsonl` present and no `R/.nax/features/ghost/` directory, `displayFeatureStatus({ dir: R })` prints no table row that starts with `ghost`.
11. `[unit]` For a temp project root holding `.nax/config.json` and no `.nax/features/` directory, with `projectOutputDir` stubbed to a separate temp dir, `displayFeatureStatus({ dir: <root> })` prints `No features found.`
12. `[unit]` In the status fixture, with an existing subdirectory `R/packages/app` that has no `.nax/` of its own, `displayFeatureStatus({ dir: join(R, "packages", "app") })` resolves without throwing and prints a table row that starts with `feat-a`.
13. `[integration]` In the status fixture, a fresh commander program with `registerStatusCommand(program)` and the default `_statusCommandActionDeps`, parsing `["status", "-f", "feat-a", "--dir", R]`, prints `US-001` and never prints `No prd.json found`.
14. `[unit]` In the status fixture, with no `O/features/feat-a/runs/` directory, `displayFeatureStatus({ dir: R })` prints a `feat-a` row whose Last Run column is `No runs yet`.
15. `[unit]` For a fresh temp directory `T` with no `.nax/config.json` in it or any of its ancestors, `displayFeatureStatus({ feature: "feat-a", dir: T })` prints `No prd.json found. Run: nax plan -f feat-a --from <spec>` and does not throw.
16. `[unit]` In the status fixture, with `R/.nax/config.json` rewritten to hold the text `not json` and `_statusFeaturesDeps.projectOutputDir` stubbed to record its arguments, `displayFeatureStatus({ dir: R })` calls `projectOutputDir` with the project key equal to the base name of `R`.

### US-002

1. `[unit]` `findAcNumericReferences("In the AC-7 shape, a write fails")`, imported from the `src/prd` barrel, returns `["AC-7"]`.
2. `[unit]` `findAcNumericReferences("Given the AC 14 setup, the call is rejected")` returns `["AC-14"]`, normalising the space form to the hyphen form.
3. `[unit]` `findAcNumericReferences("AC-3 holds, then AC-12 and AC-3 again")` returns `["AC-3", "AC-12"]`, deduplicated in first-seen order.
4. `[unit]` `findAcNumericReferences("failedACs equals [\"AC-ERROR\"] and the AC-HOOK sentinel is set")` returns `[]`.
5. `[unit]` `findAcNumericReferences` returns `[]` for the text: the test titled `AC-1: a` passes. The only candidate sits inside an inline code span.
6. `[unit]` `findAcNumericReferences("the refined criterion is returned unchanged")` returns `[]`.
7. `[unit]` When `lintSpecContent` runs on the reference spec, a spec whose `## Acceptance Criteria` section has a `### US-001` heading with bullet `1. [unit] foo() returns 1.` and bullet `2. [unit] In the AC-1 setup, foo() returns 2.`, the result has exactly one finding with code `ac-numeric-reference`, and that finding's level is `warn`.
8. `[unit]` For the reference spec, the `ac-numeric-reference` finding's message contains `US-001 AC 2` and `AC-1`.
9. `[unit]` `BLOCKING_SPEC_LINT_CODES.has("ac-numeric-reference")` returns `false`.
10. `[unit]` When `lintSpecContent` runs on a spec whose only `AC-1` token is in an AC bullet inside backticks (`` 1. [unit] the test titled `AC-1: a` passes. ``), the result contains no finding with code `ac-numeric-reference`.
11. `[unit]` When `lintSpecContent` runs on a spec whose `## Design` prose says `see AC-3 below` and whose AC bullets carry no numeric reference, the result contains no finding with code `ac-numeric-reference`.
12. `[unit]` When `assertSpecLintClean` runs on the reference spec with `{ specPath: "spec.md", featureName: "f", workdir: <temp dir> }`, it does not throw, and its returned findings include one with code `ac-numeric-reference`.
13. `[unit]` When `specLintCommand` runs with `{ dir: <temp dir>, paths: [<path to the reference spec>], strict: true }` and deps whose `readFile` returns that spec, the result's `exitCode` is `0`.
14. `[unit]` When `warnOnAcCrossReferences` runs on a PRD whose story `US-001` has acceptance criteria `["foo() returns 1", "Given the AC-1 setup, foo() returns 2"]` with feature name `feat`, the logger records exactly one `warn` from stage `plan` with message `PRD acceptance criterion refers to another criterion by number — AC numbering is not stable across plan runs`.
15. `[unit]` In that same run, the warn's data has `storyId` `US-001` as its first key, plus `featureName` `feat`, `acIndex` `2` and `references` `["AC-1"]`.
16. `[unit]` When `warnOnAcCrossReferences` runs on a PRD with story `US-001` whose second AC says `In the AC-1 shape, bar() throws` and story `US-002` whose first AC says `Given the AC 3 setup, baz() returns 0`, the logger records two warns with that message, one with `storyId` `US-001` and one with `storyId` `US-002`.
17. `[unit]` When `warnOnAcCrossReferences` runs on a PRD whose acceptance criteria contain no numeric reference, the logger records no warn with that message.
18. `[unit]` When `applyPlanFidelity(prd, specContent, "feat")` runs on a PRD whose story `US-001` has the criterion `Given the AC-1 setup, foo() returns 2` and a spec with no `## Out of Scope`, `### Modifies` or `### Context Files` section, the logger records one warn with message `PRD acceptance criterion refers to another criterion by number — AC numbering is not stable across plan runs`.
19. `[unit]` In that same `applyPlanFidelity` run, the returned PRD's `US-001` `acceptanceCriteria` equals the input's `acceptanceCriteria` element for element.
