# SPEC: Gates and config correctness (2026-11-09 review, F4)

## Summary

Close seven findings from the 2026-11-09 whole-repo review (`docs/reviews/20261109-review-nax.md`): M15, M16, M17,
M19, M20, M21 and M22. Three make a gate select the wrong files: vitest detection reads `coverage.include` as the
test-file pattern with high confidence (M15), a rule `appliesTo` written with brace globs (`*.{ts,tsx}`) never matches
and gives no warning (M16), and the import-grep fallback stops at 200 test files and treats the partial result as
complete (M17). One skips validation: the package registry's `hydrate` path, which every workflow run uses, merges a
per-package `config.json` with no env resolution, no compat shims, no guards and no schema check (M19). Three are
safety gaps: `nax init` and `nax migrate --reclaim` accept project names that collide with nax's own `~/.nax`
subdirectories (M20), the tree kill skips a descendant whose parent died first (M21), and the opt-in auto-PR plugin
pushes and opens a PR from `main` (M22).

## Motivation

The review confirmed each finding by re-run or agent repro, and each still holds at main
`367673302`:

- M15: `parseVitestConfig` (`src/test-runners/detect/framework-configs.ts:53`) runs `/include\s*:\s*\[([^\]]+)\]/s`
  over the whole file. With `defineConfig({ test: { coverage: { include: ["src/**/*.ts"] } } })` detection returns
  `{"patterns":["src/**/*.ts"],"confidence":"high"}`, so every source file is treated as a test file. `parseViteConfig`
  extracts the `test: {}` block first but then runs the same regex inside it, so `coverage.include` written before
  `include` in that block wins there too.
- M16: `globToRegex` (`src/context/engine/scope-path-match/index.ts`) escapes `{` and `}` (a `,` is emitted as-is). `SCOPE_GLOB_META`
  counts `{` as glob syntax, so `src/**/*.{ts,tsx}` is compiled as a glob that matches only the literal text
  `*.{ts,tsx}`. The rule is never selected, and `nax rules lint` classifies the pattern as a literal path (its
  `classifyPattern` treats only `*` and `?` as wildcards), so lint reports no match without saying why.
- M17: `importGrepFallback` (`src/verification/smart-runner.ts:138`) stops collecting at `maxScanFiles` (default 200)
  in readdir order, logs at debug, and greps only those files. `selectScopedTests`
  (`src/test-runners/scoped-selection.ts`) runs any non-empty result of at most `scopeTestThreshold` files as the scoped set, so an
  affected test past the cap is never run. Repro: 261 test files that all import `src/a`; the fallback returned 200.
- M19: `loadPackageOverrideWithConfig` (`src/config/loader.ts:390`) calls `mergePackageConfig` directly.
  `createPackageRegistry().hydrate` (`src/runtime/packages.ts:210`) reaches it whenever no loader is passed, which is
  how `run-setup.ts:306` calls it. Repro: `.nax/mono/packages/api/config.json` = `{"execution":{"costLimit":-5}}`;
  `loadConfigForWorkdir` throws `PER_PACKAGE_PROFILE_INVALID`, `loadPackageOverrideWithConfig` returns
  `costLimit: -5`.
- M20: `validateProjectName` (`src/cli/init.ts:50`) and the `name` refine in `NaxConfigSchema`
  (`src/config/schemas.ts:103`) reserve only `global` and `_archive`. `runs`, `profiles`, `acp`, `plugins`, `events`
  and `memory` all validate, and `nax migrate --reclaim profiles` renames `~/.nax/profiles` into `_archive` with no
  prompt, taking every named profile with it.
- M21: `signalIfUnchanged` (`src/execution/pid-registry.ts:328`) skips a signal when the process's `parentPid` or
  `startedAt` changed since the snapshot. A descendant whose parent exits on SIGTERM is reparented (ppid 1), so its
  own SIGTERM (sent concurrently) and the SIGKILL pass both skip it and it outlives the run. Agent repro: a child that
  traps TERM under a shell stayed alive with `ppid=1`.
- M22: `autoPrPlugin` (`src/plugins/builtin/auto-pr/index.ts`) runs `git push -u origin <context.branch>` and opens a
  PR for whatever branch the run was on. `shouldRun` has no branch check. The workflow publisher already refuses this
  case with `isPublishableBranch` (`src/workflow/finalize.ts:75`).

User rulings 2026-11-09: M16 expands braces in the shared matcher; M17 escalates to the full suite at the cap; M20 uses
one static list of nax-owned names; M21 matches on pid and start time for both passes; M22 mirrors the workflow
publisher's protection, including the remote default branch.

## Design

All seven stories are in `packages/nax` and independent of each other.

### Integration

Symbols the feature only reads (verified at `367673302`):

- `extractBalancedBlock(text: string, anchor: RegExp): string | null` — `src/test-runners/detect/framework-configs.ts:344`, file-local.
- `extractStringLiterals` and `normalize(patterns: string[]): string[]` — same file, file-local.
- `detectTestFilePatterns(workdir)` — `src/test-runners/detect/index.ts`; returns `{ patterns, confidence, sources }`. It drops sources with empty `patterns` (`index.ts:148-149`), so a vitest source with `patterns: []` is visible only through `detectFromFrameworkConfigs`.
- `detectFromFrameworkConfigs(workdir): Promise<DetectionSource[]>` — `framework-configs.ts:367`, exported; returns every Tier 1 source, including one with `patterns: []`.
- `ruleMatchesScopeFiles(appliesTo: string[] | undefined, scopeFiles: string[] | undefined): boolean` — `src/context/engine/scope-path-match/index.ts:171`.
- `pathMatchesScope(scopePaths: string[], filePath: string): boolean` — `src/context/engine/effectiveness.ts:372`.
- `SCOPE_GLOB_META = /[*?[{]/` — `scope-path-match/index.ts:43`; already treats `{` as glob syntax, unchanged.
- `_rulesLintDeps.globHasMatch(pattern: string, cwd: string): GlobMatchResult` — `src/cli/rules-lint.ts:186` (in `_rulesLintDeps`, `:160`); `GlobMatchResult = "match" | "no-match" | "unknown"`.
- `selectScopedTests(input): Promise<SelectScopedTestsResult>` — `src/test-runners/scoped-selection.ts:98`; an empty Pass 2 result already returns its `fullSuite()` result.
- `resolveEnvVarsWarnOnFailure`, `applyConfigCompatShims`, `rejectPipelineModeKeys`, `warnQualityCommandChains`, `rejectLegacyAgentKeys`, `rejectLegacyRectificationKeys`, `rejectDeadQualityFlags`, `rejectRemovedPlanModes`, `validatePermissionsBlock`, `stripRemovedConfig`, `createConfigWarnDedupe`, `loadPackageProfileLayers`, `NaxConfigSchema` — the chain `loadConfigForWorkdir` (`loader.ts:430-599`) already runs on a package layer.
- `createPackageRegistry(loader, repoRoot).hydrate(packageDirs, loadOverride?)` — `src/runtime/packages.ts:210`; with no `loadOverride` it calls `loadPackageOverrideWithConfig`.
- `globalConfigDir(): string` — `src/config/paths/index.ts:63`.
- `migrateCommand(options: MigrateOptions)` — `src/commands/migrate.ts:41`; validates `--reclaim` and `--merge` through `validateProjectName`.
- `PidRegistry.killAll()` — `src/execution/pid-registry.ts:153`; calls the private `killPidTree`, which signals TERM to every target concurrently, sleeps `PID_TREE_KILL_GRACE_MS`, then signals KILL.
- `readDefaultBranch(projectDir)` — `src/workflow/git.ts:270`; the command it runs is `git symbolic-ref --quiet --short refs/remotes/origin/HEAD`, stripping `origin/`.

Symbols the feature changes. The baseline exists only to locate the code; implement the target.

- `parseVitestConfig(workdir)` and `parseViteConfig(workdir)` (file-local, `framework-configs.ts:45`, `:281`).
  Baseline: vitest matches `include` over the whole file; vite matches the first `include` anywhere inside the
  `test: {}` block. Target: both extract the `test: {}` block with `extractBalancedBlock` and read only an `include`
  key at the top level of the slice `extractBalancedBlock` returns (outside every nested `{}` in that slice), through
  one new file-local helper. `extractBalancedBlock` is unchanged; like it, the helper counts braces without regard to
  string literals. A vitest config with no `test` block, or
  with a `test` block that has no top-level `include`, returns the vitest source with `patterns: []` (it still claims
  the framework, as today).
- `globToRegex(pattern: string): RegExp` (`scope-path-match/index.ts:82`).
  Baseline: escapes `{`, `}` and `,`. Target: a balanced brace group that contains at least one top-level `,`
  compiles to a non-capturing alternation — `{` to `(?:`, each top-level `,` inside the group to `|`, `}` to `)` — with
  nesting; `*`, `**` and `?` inside a group keep their meaning, and every other character inside a group stays
  regex-escaped as today. An empty alternative is allowed (`{a,}` matches `a` or nothing). A group with no top-level
  `,` (`{a}`, `{}`) stays literal, as in bash and minimatch. When the pattern's braces are not balanced, every `{` and
  `}` stays literal (today's escape). A `,` outside any group stays literal. The memo keyed on the raw pattern is unchanged. `globToRegex` is
  recorded at complexity 22 in `packages/nax/scripts/baselines/complexity-baseline.json` against the strict limit 20
  (`packages/repo-tooling/scripts/check-complexity.ts`), and the ratchet fails a function whose score grows: the brace
  handling goes in new file-local helpers (finding the group extents, translating one group), each scoring 20 or
  less, so `globToRegex` itself does not grow; when its score drops, lower its baseline entry to the new score.
- `classifyPattern(normalizedPattern)` (file-local, `rules-lint.ts:95`). Baseline: a segment is a wildcard segment only
  if it contains `*` or `?`. Target: a segment containing `{` also ends the literal prefix, so a brace pattern is never
  checked as a literal path. Update the doc comment above it, which says `{` and `}` are matched literally.
- `importGrepFallback(sourceFiles, workdir, testFilePatterns, maxScanFiles = MAX_GREP_TEST_FILES): Promise<string[]>`
  (`smart-runner.ts:138`). Baseline: stops collecting at `maxScanFiles` files, logs at debug, greps the collected
  files. Target: when the scan yields a file past `maxScanFiles` (the scan holds more than `maxScanFiles` files), it
  reads no test file, logs one warn on the `smart-runner` stage naming the cap and that scoped selection escalates to
  the full suite, and returns `[]`. Exactly `maxScanFiles` files is not over the cap. `smart-runner.ts` is 599 lines,
  so the change must not grow it past the 600-line source limit (replace the debug block in place).
- `loadPackageOverrideWithConfig({ repoRoot, packageDir, rootConfig })` (`loader.ts:390`).
  Baseline: `mergePackageConfig(rootConfig, data.fields)`, profile layers, `mergePackageConfig` again, no validation.
  Target: the package fields go through the same per-layer preparation `loadConfigForWorkdir` runs (env resolution,
  compat shims, `rejectPipelineModeKeys`, `warnQualityCommandChains`, the legacy reject guards, `stripRemovedConfig`),
  and the merged, profile-overlaid result goes through the same final validation (legacy reject guards,
  `validatePermissionsBlock`, `stripRemovedConfig`, `NaxConfigSchema.safeParse`), throwing `NaxError` code
  `PER_PACKAGE_PROFILE_INVALID` with the same message shape `loadConfigForWorkdir` uses. The returned `overlay` stays
  the declared package fields plus profile layers as today; the `review.commands` bridge stays and runs on the
  validated config. Both steps move into a new module `src/config/package-layer.ts` that `loadConfigForWorkdir`
  also calls, so the two paths cannot drift again; `loader.ts` (599 lines) must end at or under 599 lines.
  Signatures:

  ```ts
  // Per-layer preparation of one package config.json's fields (profile key already removed).
  export function preparePackageLayer(
    fields: Record<string, unknown>,
    packageDir: string,
    logger: Logger,
    warnDedupe: ConfigWarnDedupe,
  ): Record<string, unknown>; // env resolved, shimmed, legacy-guarded, removed keys stripped
  // Final validation of the merged, profile-overlaid raw config. Returns Zod result.data.
  export function validatePackageConfig(
    rawMerged: Record<string, unknown>,
    packageDir: string,
    profileChain: readonly string[],
    warnDedupe: ConfigWarnDedupe,
  ): NaxConfig; // throws NaxError PER_PACKAGE_PROFILE_INVALID
  ```

  The caller creates one `warnDedupe` per package resolution and passes it to both functions and to
  `loadPackageProfileLayers` (`loadPackageOverrideData` takes it as a parameter instead of creating its own, and
  returns `{ fields, layers, chain }` so the chain reaches `validatePackageConfig`). `resolveEnvVarsWarnOnFailure`
  (file-local in `loader.ts:70`, used by the root chain too) moves to `package-layer.ts` and is exported for
  `loader.ts`, so `package-layer.ts` never imports `loader.ts`. The interim `stripRemovedConfig(merged)` pass in
  `loadConfigForWorkdir` (`loader.ts:~528`) stays where it is.
  `validatePackageConfig` owns only the guards, `validatePermissionsBlock`, the strip and `safeParse`; it does not
  call `applyWorkflowMode`. `loadConfigForWorkdir` keeps its own `pinRootOnlyKeysRaw`, `profile`/`profileChain`
  stamp, `applyWorkflowMode` and cache write around the call. `loadPackageOverrideWithConfig` keeps its second
  whitelist `mergePackageConfig(rootConfig, resolved)`, then applies
  `pinRootOnlyKeysRaw(merged, rootConfig, packageDir, warnDedupe.warn)` before `validatePackageConfig` (the same order
  as `loader.ts:554`, so a package's root-only `execution.*` value is warned about and dropped, never validated), then
  applies the `review.commands` bridge to the validated config; `hydrate` keeps its own `pinRootOnlyKeys` and
  `applyWorkflowMode`.
- `createPackageRegistry().hydrate(packageDirs, loadOverride?)` (`runtime/packages.ts:210`). Baseline: the loop
  awaits each package in order, so the first rejection skips every later package and `hydrated` is never set.
  `run-setup.ts:300-314` catches the rejection and warns `Per-package config hydration failed — using root config`.
  Target: `hydrate` hydrates every package it can, sets `hydrated = true`, and then rejects with the first package's
  error when any package failed (later failures are logged at warn on the `packages` stage with their `packageDir`).
  A failed package is not hydrated and resolves to the root config. `run-setup.ts` is unchanged: it still warns and
  continues, now with the validation error in its `error` field.
- `validateProjectName(name)` (`init.ts:42`) and the `name` refine in `NaxConfigSchema` (`schemas.ts:103`).
  Baseline: both reserve the inline list `["global", "_archive"]`. Target: both read one exported constant
  `RESERVED_PROJECT_NAMES` in `src/config/paths/index.ts` (next to `globalConfigDir`) =
  `["global", "profiles", "runs", "events", "plugins", "acp", "memory", "hooks", "_archive"]` — every directory nax
  itself creates under `globalConfigDir()` (`runtime/paths.ts:37`, `config/profile.ts:83`, `utils/paths.ts:33`,
  `utils/paths.ts:40`, `cli/plugins.ts:25`, `agents/acp/open-context.ts:62`, `memory/paths.ts:115`, `cli/init.ts:291`,
  `commands/migrate.ts:64`). A doc comment on the constant lists these sites. `validateProjectName` keeps its reserved check before the `_` prefix check and
  returns `name '<name>' is reserved`; the schema refine's message names the rejected value.
  `migrateCommand` is unchanged: it already validates through `validateProjectName`.
- `signalIfUnchanged(proc, signal)` (private, `pid-registry.ts:328`). Baseline: skips when `parentPid` or `startedAt`
  differs from the snapshot. Target: skips only when `startedAt` differs (the PID was reused). A changed `parentPid`
  alone is signalled, for both `TERM` and `KILL`. The skip warn keeps its fields.
- `isPublishableBranch(branch, defaultBranch?)` (`workflow/finalize.ts:75`, with `PROTECTED_BRANCHES`). Target: moves
  to `src/utils/git.ts` unchanged; `finalize.ts` imports it from there and keeps re-exporting it, so its existing
  importers (`test/unit/workflow/finalize.test.ts`, `publish-protection.test.ts`) keep working. A plugin must not
  import from `src/workflow/`.
- `_autoPrDeps` and `autoPrPlugin` (`src/plugins/builtin/auto-pr/index.ts`). Target: `_autoPrDeps` gains
  `readDefaultBranch(workdir: string): Promise<string | undefined>`, whose default runs
  `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` through `_autoPrDeps.run` (the hardened runner; the
  literal argv carries the file's `nax-git-env-allow` annotation, as `GIT_REMOTE_CMD` does) and
  strips `origin/`, returning `undefined` on a non-zero exit, an empty answer or a throw. `shouldRun` returns `false`
  after the `enabled` and story-summary checks and before any remote or forge lookup when
  `isPublishableBranch(context.branch, await _autoPrDeps.readDefaultBranch(context.workdir))` is false, logging one
  warn naming the branch. `execute` makes the same check first and returns
  `{ success: false, message }` naming the branch without running `git push`.

### Failure Handling

| Story | Condition | Behaviour |
|:---|:---|:---|
| US-001 | `test: {}` block present but its braces never close | `extractBalancedBlock` returns `null`; the vitest source is returned with `patterns: []` |
| US-002 | Unbalanced braces in a pattern | every `{`, `}`, `,` matched literally, as today |
| US-003 | Scan exceeds `maxScanFiles` | warn, return `[]`, caller runs the full suite |
| US-004 | Package config fails a guard or the schema | `loadPackageOverrideWithConfig` throws; `hydrate` hydrates the other packages, caches nothing for the failed one, then rejects with the first error; `run-setup` warns and continues |
| US-004 | Package config names an unset env var | same warn-and-keep behaviour as `loadConfigForWorkdir` (`resolveEnvVarsWarnOnFailure`) |
| US-007 | Default-branch lookup fails | treated as unknown: only `""`, `main` and `master` are protected |

## Out of Scope

- M18, M23 and the other review findings (M1-M14, L1-L37). M1-M14, M18 and M23 shipped in F1-F3; the LOW findings belong to F5.
- An existing project already named one of the newly reserved names. Its `.nax/config.json` stops validating and must be renamed by hand; no migration is added.
- A repo with no `name` in its config whose directory is named like a reserved name. `getProjectKey` (`config/project-key.ts:25`) falls back to the directory's basename without `validateProjectName`, so it can still collide.
- `trust` from the review's M20 repro: nax writes `~/.nax/trust.json`, a file, so no directory collides; it is not reserved.
- Making nax's own path helpers (`profile.ts`, `utils/paths.ts`, `plugins.ts`, `memory/paths.ts`, `open-context.ts`) read their directory names from `RESERVED_PROJECT_NAMES`. The constant is a list for validation only.
- Making `nax migrate --reclaim` refuse a `~/.nax/<name>` directory that has no `.identity` file.
- Validating `loadPackageOverride` (`loader.ts:384`), the declared-values reader the finish quality gate uses for command provenance. It keeps returning the declared fields unvalidated.
- Brace expansion in the other glob converters (`src/utils/path-filters.ts`, `src/test-runners/conventions.ts`). They are separate matchers with their own callers.
- Extglob syntax (`?(x)`, `+(x)`, `@(x)`, `!(x)`) and character ranges in rule `appliesTo`. Only `{a,b}` groups are expanded.
- A runtime chunk scope path that contains a literal brace group with a comma (for example a file named `{a,b}.ts`). After US-002 it is read as a glob by attribution.
- Raising or removing `execution.smartTestRunner.maxScanFiles`, or scanning test files in a stable order.
- Vitest configs whose `test.include` is not a literal string array (a variable, a spread, a function call). They keep returning `patterns: []`.
- Killing a reparented descendant that was not in the snapshot `killPidTree` took before the TERM pass.
- Making an invalid package config fatal at run start. `run-setup` keeps its non-fatal catch, so the failed package runs on the root config after one warn carrying the validation error.
- Deduplicating test files that two `testFilePatterns` both match. Each match counts toward `maxScanFiles`, so overlapping patterns can escalate to the full suite sooner.
- Braces inside string literals in a vitest or vite config (for example `exclude: ["a/}"]`). They are counted as structure, as `extractBalancedBlock` counts them today.
- Vitest `test.projects` / workspace entries and an `alias` or other object holding a `test:` key before the config's own `test` block. Only the first `test: {` block's top-level `include` is read.
- US-007 only: a branch protection list configured by the user. Only `""`, `main`, `master` and the remote default branch are protected, as in the workflow publisher.

## Stories

Seven stories, all `Workdir: packages/nax`, none depending on another. This is a bundle of independent fixes the user
split out of the review as one feature (F4).

### US-001: Vitest detection reads only `test.include`

Workdir: packages/nax. No dependencies.

Fix review M15. `parseVitestConfig` and `parseViteConfig` read `include` only from the top level of the `test: {}`
block, through one shared file-local helper, so `coverage.include` and any other nested `include` are never taken as
test-file patterns.

### US-002: Brace globs in a rule `appliesTo` match

Workdir: packages/nax. No dependencies.

Fix review M16. `globToRegex` compiles balanced `{a,b}` groups (nested allowed) to alternations, so rule selection
(`ruleMatchesScopeFiles`) and chunk attribution (`pathMatchesScope`) match `src/**/*.{ts,tsx}`. `nax rules lint`'s
`classifyPattern` treats a segment containing `{` as a wildcard segment, so lint agrees with runtime.

### US-003: The import-grep fallback escalates to the full suite at its cap

Workdir: packages/nax. No dependencies.

Fix review M17. When the test-file scan holds more than `maxScanFiles` files, `importGrepFallback` warns and returns
`[]` without reading any file, so `selectScopedTests` runs the full suite instead of a partial scoped set.

### US-004: Package configs hydrated by the registry are validated

Workdir: packages/nax. No dependencies.

Fix review M19. Extract the per-layer preparation and the final validation from `loadConfigForWorkdir` into
`src/config/package-layer.ts` (`preparePackageLayer`, `validatePackageConfig`), and call both from
`loadPackageOverrideWithConfig`, so the registry's `hydrate` path rejects an invalid package config with
`PER_PACKAGE_PROFILE_INVALID` exactly as `loadConfigForWorkdir` does.

### US-005: Project names that collide with nax's own `~/.nax` directories are reserved

Workdir: packages/nax. No dependencies.

Fix review M20. Add `RESERVED_PROJECT_NAMES` to `src/config/paths/index.ts` and use it in `validateProjectName` and
the `NaxConfigSchema` `name` refine, so `nax init`, config validation and `nax migrate --reclaim` / `--merge` all
refuse `global`, `profiles`, `runs`, `events`, `plugins`, `acp`, `memory`, `hooks` and `_archive`.

### US-006: The tree kill signals a descendant whose parent already died

Workdir: packages/nax. No dependencies.

Fix review M21. `signalIfUnchanged` treats a process as the same one when its `startedAt` is unchanged, whatever its
`parentPid`, so a reparented descendant gets both SIGTERM and SIGKILL. A changed `startedAt` (PID reuse) is still
skipped with the existing warn.

### US-007: Auto-PR never pushes or opens a PR from a protected branch

Workdir: packages/nax. No dependencies.

Fix review M22. Move `isPublishableBranch` to `src/utils/git.ts` (re-exported from `workflow/finalize.ts`), add
`readDefaultBranch` to `_autoPrDeps`, and refuse in both `shouldRun` and `execute` when the run's branch is `""`,
`main`, `master` or the remote's default branch.

### Context Files

**US-001**

- `packages/nax/src/test-runners/detect/framework-configs.ts`
- `packages/nax/src/test-runners/detect/index.ts`
- `packages/nax/test/unit/test-runners/detect.test.ts`
- `packages/nax/test/unit/test-runners/detect/framework-configs-python.test.ts` — the `_frameworkConfigDeps` stub pattern for `detectFromFrameworkConfigs`

**US-002**

- `packages/nax/src/context/engine/scope-path-match/index.ts`
- `packages/nax/src/context/engine/effectiveness.ts`
- `packages/nax/src/cli/rules-lint.ts`
- `packages/nax/test/unit/context/engine/scope-path-match.test.ts`
- `packages/nax/test/unit/cli/rules-lint.test.ts`

**US-003**

- `packages/nax/src/verification/smart-runner.ts`
- `packages/nax/src/test-runners/scoped-selection.ts`
- `packages/nax/test/unit/verification/import-grep-fallback.test.ts`
- `packages/nax/test/unit/test-runners/scoped-selection.test.ts`

**US-004**

- `packages/nax/src/config/loader.ts`
- `packages/nax/src/config/package-profile.ts`
- `packages/nax/src/runtime/packages.ts`
- `packages/nax/src/execution/lifecycle/run-setup.ts`
- `packages/nax/test/integration/runtime/package-profile-registry.test.ts` — drives the real `hydrate` path with profile fixtures; must stay green
- `packages/nax/test/unit/runtime/packages-overlay.test.ts`

**US-005**

- `packages/nax/src/config/paths/index.ts`
- `packages/nax/src/cli/init.ts`
- `packages/nax/src/config/schemas.ts`
- `packages/nax/src/commands/migrate.ts`
- `packages/nax/test/unit/commands/migrate.test.ts`

**US-006**

- `packages/nax/src/execution/pid-registry.ts`
- `packages/nax/test/unit/execution/pid-registry.test.ts`

**US-007**

- `packages/nax/src/plugins/builtin/auto-pr/index.ts`
- `packages/nax/src/workflow/finalize.ts`
- `packages/nax/src/utils/git.ts`
- `packages/nax/test/unit/plugins/builtin/auto-pr-acceptance.test.ts`
- `packages/nax/test/unit/workflow/publish-protection.test.ts`

### Creates

**US-001**

- `packages/nax/test/unit/test-runners/detect/framework-configs-vitest.test.ts` — the US-001 cases; `detect.test.ts` is 612 lines. ACs on `detectTestFilePatterns` copy its `_frameworkDefaultsDeps.readText` and `_fileScanDeps.spawn` stubs and cache isolation (`detect.test.ts:94-109`).

**US-002**

- `packages/nax/test/unit/context/engine/scope-path-match-braces.test.ts` — the brace cases for `globToRegex`, `ruleMatchesScopeFiles`, `pathMatchesScope` and the lint classifier; `rules-lint.test.ts` is 783 lines, past the 650 target.

**US-004**

- `packages/nax/src/config/package-layer.ts` — `preparePackageLayer` and `validatePackageConfig`, shared by `loadConfigForWorkdir` and `loadPackageOverrideWithConfig`.
- `packages/nax/test/unit/config/package-override-validation.test.ts` — the `loadPackageOverrideWithConfig` and `hydrate` validation cases; `loader-legacy-shim.test.ts` is 732 lines.

**US-005**

- `packages/nax/test/unit/config/reserved-project-names.test.ts` — the reserved-name cases for `validateProjectName`, the schema and `migrateCommand`; `init.test.ts` is 733 lines.

**US-006**

- `packages/nax/test/unit/execution/pid-registry-reparent.test.ts` — the reparented-descendant cases; `pid-registry.test.ts` is 640 lines.

**US-007**

- `packages/nax/test/unit/plugins/builtin/auto-pr-protected-branch.test.ts` — the protected-branch cases for `shouldRun` and `execute`.

### Modifies

**US-007**

- `packages/nax/test/unit/plugins/builtin/auto-pr-acceptance.test.ts` — its `let saved: typeof _autoPrDeps` snapshot in `beforeEach` is a seven-field literal; adding the required `readDefaultBranch` field to `_autoPrDeps` fails `bun run typecheck` (tsconfig.test.json). Add `readDefaultBranch: _autoPrDeps.readDefaultBranch` to the snapshot and restore it in `afterEach`; no assertion changes.
- `packages/nax/test/unit/plugins/builtin/auto-pr-bug8.test.ts` — same seven-field `saved: typeof _autoPrDeps` snapshot in `beforeEach`; add `readDefaultBranch` to the snapshot and its restore; no assertion changes.

No other story changes an existing test. The vitest tests use configs with no nested `include`; no test asserts a
literal brace match in `globToRegex` or lint; the two `importGrepFallback` cap tests assert at most N reads, which
returning `[]` without reading satisfies; the pid-registry identity test changes both `parentPid` and `startedAt`,
which still skips; the `validateProjectName` tests assert `global` and `_archive` are reserved, which still holds;
the other auto-PR tests use the branch `nax/auto-pr`, which stays publishable; and the `isPublishableBranch` tests
import it from `@/workflow/finalize`, which keeps re-exporting it.

### Seams

- US-004: `validatePackageConfig` is new and exported from `src/config/package-layer.ts`; its consumer is `loadPackageOverrideWithConfig`, reached from the registry's `hydrate` with no `loadOverride` (as `run-setup.ts:306` calls it). The seam AC drives `hydrate` against a temp repo.
- Regression guards that already pass before the fix: US-001 AC3; US-002 AC3, AC6, AC7, AC8, AC12, AC15; US-003 AC4, AC5; US-004 AC8, AC10, AC13, AC17; US-005 AC4, AC5, AC7; US-006 AC4, AC5, AC6; US-007 AC6, AC11. Every story keeps at least one fail-first AC.
- US-004: `preparePackageLayer` is new and exported; its consumers are `loadConfigForWorkdir` and `loadPackageOverrideWithConfig`. AC3 (same rejection from both) and the env and shim ACs cover it through both entry points. Tests that call `loadConfigForWorkdir` isolate `NAX_GLOBAL_CONFIG_DIR`, call `_clearRootConfigCache`, and write a root `.nax/config.json`, as `test/integration/runtime/package-profile-registry.test.ts:31-48` does; log assertions use the `initLogger` plus `addSink` pattern in `loader-legacy-shim.test.ts:261-295`.
- US-005: `RESERVED_PROJECT_NAMES` is new and exported; its consumers are `validateProjectName` and the `NaxConfigSchema` `name` refine, reached from `migrateCommand` and `NaxConfigSchema.safeParse`.
- US-007: `_autoPrDeps.readDefaultBranch` is new; its consumers are `autoPrPlugin`'s `shouldRun` and `execute`, the post-run action entry points.

## Acceptance Criteria

### US-001

1. [unit] `detectFromFrameworkConfigs` on a workdir whose `vitest.config.ts` is `defineConfig({ test: { coverage: { include: ["src/**/*.ts"] } } })` returns a source with `framework: "vitest"` whose `patterns` is `[]`.
2. [unit] `detectTestFilePatterns` on a workdir whose `vitest.config.ts` is `defineConfig({ test: { coverage: { include: ["src/**/*.ts"] }, include: ["test/**/*.test.ts"] } })` returns `patterns` equal to `["test/**/*.test.ts"]`.
3. [unit] `detectTestFilePatterns` on a workdir whose `vitest.config.ts` is `defineConfig({ test: { include: ["test/**/*.test.ts"], coverage: { include: ["src/**/*.ts"] } } })` returns `patterns` equal to `["test/**/*.test.ts"]`.
4. [unit] `detectFromFrameworkConfigs` on a workdir whose `vitest.config.ts` is `defineConfig({ plugins: [], include: ["src/**/*.ts"] })` (an `include` outside any `test` block) returns a source with `framework: "vitest"` whose `patterns` is `[]`.
5. [unit] `detectTestFilePatterns` on a workdir whose `vite.config.ts` is `defineConfig({ test: { coverage: { include: ["src/**/*.ts"] }, include: ["test/**/*.test.ts"] } })` returns `patterns` equal to `["test/**/*.test.ts"]`.
6. [unit] `detectFromFrameworkConfigs` on a workdir whose `vite.config.ts` is `defineConfig({ test: { coverage: { include: ["src/**/*.ts"] } } })` returns a source with `framework: "vitest"` whose `patterns` is `[]`.
7. [unit] `detectFromFrameworkConfigs` on a workdir whose `vitest.config.ts` is `defineConfig({ test: { include: ["test/**/*.test.ts"]` (the `test` block never closes) returns a source with `framework: "vitest"` whose `patterns` is `[]`.

### US-002

1. [unit] `globToRegex("src/**/*.{ts,tsx}")` matches `src/a.ts`.
2. [unit] `globToRegex("src/**/*.{ts,tsx}")` matches `src/deep/b.tsx`.
3. [unit] `globToRegex("src/**/*.{ts,tsx}")` does not match `src/a.js`.
4. [unit] `globToRegex("src/{a,b/{c,d}}.ts")` matches `src/b/d.ts` and does not match `src/b.ts`.
5. [unit] `globToRegex("src/{lib,app}/**/*.ts")` matches `src/app/x/y.ts`.
6. [unit] `globToRegex("src/{a.ts")` (unbalanced) matches the path `src/{a.ts` and does not match `src/a.ts`.
7. [unit] `globToRegex("src/a,b*.ts")` (a comma outside any group) matches `src/a,b1.ts` and does not match `src/a.ts`.
8. [unit] `globToRegex("src/{a}.ts")` (a group with no comma) matches the path `src/{a}.ts` and does not match `src/a.ts`.
9. [unit] `globToRegex("src/a{,.test}.ts")` (an empty alternative) matches both `src/a.ts` and `src/a.test.ts`.
10. [unit] `globToRegex("src/{a.b,c}.ts")` matches `src/a.b.ts` and does not match `src/aXb.ts` (a `.` inside a group stays literal).
11. [integration] `ruleMatchesScopeFiles(["src/**/*.{ts,tsx}"], ["packages/app/src/index.tsx"])` returns `true`.
12. [integration] `ruleMatchesScopeFiles(["src/**/*.{ts,tsx}"], ["src/readme.md"])` returns `false`.
13. [integration] `pathMatchesScope(["src/**/*.{ts,tsx}"], "src/index.ts")` returns `true`, the same answer `ruleMatchesScopeFiles` gives for that file.
14. [integration] `_rulesLintDeps.globHasMatch("src/{a,b}.ts", tmp)` on a temp directory holding only `src/b.ts` returns `"match"`.
15. [integration] `_rulesLintDeps.globHasMatch("src/{a,b}.ts", tmp)` on a temp directory holding only `src/c.ts` returns `"no-match"`.

Verification note: `bun run check:complexity` (no function over its baseline; new helpers at 20 or less).

### US-003

1. [unit] `importGrepFallback(["src/x.ts"], "/repo", ["test/**/*.test.ts"], 5)` with the glob stub yielding 6 files, each of whose `text()` contains `/x`, returns `[]`.
2. [unit] In the same 6-file case, the `_bunDeps.file` stub's `text()` is called 0 times.
3. [unit] In the same 6-file case, one warn is logged on the `smart-runner` stage with data `{ cap: 5 }`.
4. [unit] `importGrepFallback(["src/x.ts"], "/repo", ["test/**/*.test.ts"], 5)` with the glob stub yielding exactly 5 files, each containing the text `/x`, returns all 5 paths.
5. [unit] In the exactly-5-files case, no warn is logged on the `smart-runner` stage.
6. [unit] `importGrepFallback` with two patterns whose stubbed globs yield 3 files each (each file's `text()` containing `/x`) and `maxScanFiles` 5 returns `[]` (the cap counts files across patterns).
7. [integration] `selectScopedTests` with `smartRunnerConfig` `{ enabled: true, fallback: "import-grep", maxScanFiles: 2 }`, `storyGitRef` set, `_scopedSelectionDeps.getChangedTestFiles` returning `[]`, `getChangedNonTestFiles` returning `["src/x.ts"]`, `mapSourceToTests` returning `[]`, and `_scopedSelectionDeps.importGrepFallback` left at its default (the real `importGrepFallback`) over a `_bunDeps.glob` stub yielding 3 test files that each contain `/x`, returns `isFullSuite: true` with `effectiveCommand` equal to `fallbackFullSuiteCommand`.

Verification note: `bun run check:file-sizes` (`smart-runner.ts` at or under 600 lines).

### US-004

1. [unit] `loadPackageOverrideWithConfig` on a temp repo whose `.nax/mono/packages/api/config.json` is `{"execution":{"costLimit":-5}}` rejects with a `NaxError` whose code is `PER_PACKAGE_PROFILE_INVALID`.
2. [unit] The rejection in AC1 has a message naming the package `packages/api` and the path `execution.costLimit`.
3. [unit] `loadConfigForWorkdir` on the same temp repo and package rejects with the same code and the same message as AC1.
4. [unit] `loadPackageOverrideWithConfig` on a package config whose `execution.permissions.run` block carries both `allowedTools` and `allow` rejects with a `NaxError` whose code is `CONFIG_PERMISSIONS_ALLOW_ALIAS_CONFLICT` (what `validatePermissionsBlock` throws, as `loadConfigForWorkdir` does for the same file).
5. [unit] `loadPackageOverrideWithConfig` on a package config `{"quality":{"commands":{"test":"$NAX_F4_TEST_CMD"}}}` with env var `NAX_F4_TEST_CMD=bun run test:pkg` returns `config.quality.commands.test` equal to `bun run test:pkg`.
6. [unit] `loadPackageOverrideWithConfig` on a package config `{"routing":{"strategy":"manual"}}` resolves with `config.routing.strategy` equal to `keyword` (the `applyConfigCompatShims` migration `loadConfigForWorkdir` applies), not a schema rejection.
7. [unit] In the AC6 case, the `routing.strategy="manual" was removed` warning is emitted once.
8. [unit] `loadPackageOverrideWithConfig` on a valid package config `{"quality":{"commands":{"test":"bun run test:pkg"}}}` returns `overlay.quality.commands.test` equal to `bun run test:pkg` and `config.quality.commands.test` equal to `bun run test:pkg`.
9. [unit] `loadPackageOverrideWithConfig` on a package config whose `profile` names a package profile that sets `execution.costLimit` to `-1` rejects with code `PER_PACKAGE_PROFILE_INVALID`.
10. [unit] `loadPackageOverrideWithConfig` on a valid package config keeps `config.review.commands` equal to the root config's `review.commands` merged with only the package-declared review commands (the existing bridge).
11. [integration] `createPackageRegistry(createConfigLoader(rootConfig), tmp).hydrate(["packages/api"])` with no `loadOverride`, on a temp repo whose `.nax/mono/packages/api/config.json` is `{"execution":{"costLimit":-5}}`, rejects with code `PER_PACKAGE_PROFILE_INVALID`.
12. [integration] After the rejected `hydrate` in AC11, `resolve("packages/api").hasOverride` is `false`.
13. [unit] `loadPackageOverrideWithConfig` on a package config `{"quality":{"commands":{"test":"$NAX_F4_UNSET"}}}` with `NAX_F4_UNSET` unset resolves with `config.quality.commands.test` equal to `$NAX_F4_UNSET`.
14. [unit] In the AC13 case, one warn is logged whose text names `per-package config "packages/api"`.
15. [integration] `hydrate(["packages/api", "packages/web"])` with no `loadOverride`, on a temp repo where `packages/api`'s config is `{"execution":{"costLimit":-5}}` and `packages/web`'s is `{"quality":{"commands":{"test":"bun run test:web"}}}`, rejects with code `PER_PACKAGE_PROFILE_INVALID`.
16. [integration] After the rejection in AC15, `resolve("packages/web").config.quality.commands.test` is `bun run test:web` and `resolve("packages/web").hasOverride` is `true`.
17. [integration] `hydrate(["packages/api"])` with no `loadOverride`, on a temp repo whose package config is `{"quality":{"commands":{"test":"bun run test:pkg"}}}`, resolves and `resolve("packages/api").config.quality.commands.test` is `bun run test:pkg`.
18. [unit] Importing `validatePackageConfig` from `src/config/package-layer.ts` and calling it with a merged raw config whose `execution.costLimit` is `-5`, package `packages/api` and an empty profile chain throws code `PER_PACKAGE_PROFILE_INVALID`; called with a valid merged raw config it returns a `NaxConfig` whose `execution.costLimit` equals the input's.

19. [unit] `loadPackageOverrideWithConfig` on a package config `{"execution":{"approvalTimeout":5}}` (root-only, below the schema minimum) resolves, with `config.execution.approvalTimeout` equal to the root config's value.
20. [unit] In the AC19 case, one warn is logged whose text names `execution.approvalTimeout is root-only` and `packages/api`.
21. [integration] In the AC15 two-failure variant, where `packages/web`'s config is also `{"execution":{"costLimit":-5}}`, `hydrate` rejects with the `packages/api` error and logs one warn on the `packages` stage whose data carries `packageDir: "packages/web"`.

Verification note: `bun run typecheck` and `bun run check:file-sizes` (`loader.ts` at or under 599 lines).

### US-005

1. [unit] `RESERVED_PROJECT_NAMES` imported from `src/config/paths/index.ts` equals `["global", "profiles", "runs", "events", "plugins", "acp", "memory", "hooks", "_archive"]`.
2. [unit] `validateProjectName` returns `{ valid: false, error: "name 'profiles' is reserved" }` for `profiles`.
3. [unit] `validateProjectName` returns `valid: false` with an error naming the name and `reserved` for each of `runs`, `events`, `plugins`, `acp`, `memory` and `hooks`.
4. [unit] `validateProjectName("global")` and `validateProjectName("_archive")` each return `valid: false` with an error containing `reserved`.
5. [unit] `validateProjectName("my-profiles")` returns `{ valid: true }`.
6. [unit] `NaxConfigSchema.safeParse` on a config with `name: "runs"` fails with an issue on path `name` whose message contains `runs` and `reserved`.
7. [unit] `NaxConfigSchema.safeParse` on a config with `name: "my-runs"` succeeds.
8. [integration] `migrateCommand({ workdir: tmpRepo, reclaim: "profiles" })`, with `NAX_GLOBAL_CONFIG_DIR` set to a fresh temp directory holding `profiles/a.json` (restored after the test), rejects with code `MIGRATE_INVALID_NAME`.
9. [integration] After the rejection in AC8, `profiles/a.json` still exists under the temp directory and no `_archive` directory was created.
10. [integration] `migrateCommand({ workdir: tmpRepo, merge: "events" })` rejects with code `MIGRATE_INVALID_NAME`.

### US-006

1. [unit] `killAll()` with a registered root whose `ps -eo` snapshot lists a descendant `D` (ppid = the root's child `C`), where the per-pid `ps -o` lookup for `D` returns ppid `1` and the snapshot's start time, sends `kill -TERM D`.
2. [unit] In the AC1 case, `killAll()` also sends `kill -KILL D`.
3. [unit] `killAll()` where the per-pid lookup for `D` returns ppid `1` and the snapshot's start time only after the TERM pass (its first lookup returns the snapshot ppid), sends `kill -KILL D`.
4. [unit] `killAll()` where the per-pid lookup for `D` returns the snapshot ppid and a different start time does not send `kill -TERM D` or `kill -KILL D`.
5. [unit] In the AC4 case, exactly one of the warns logged on the `pid-registry` stage has a message starting `Skipping SIGTERM for PID`, and its data carries `expectedStartedAt` and `currentStartedAt`.
6. [unit] `killAll()` where the per-pid lookup for `D` fails (non-zero exit) sends no signal to `D`.

### US-007

1. [unit] `autoPrPlugin`'s post-run action `shouldRun` with `autoPr.enabled: true`, a completed story summary, and `context.branch` `main` returns `false`.
2. [unit] In the AC1 case, `_autoPrDeps.getRemoteUrl` and `_autoPrDeps.hasOpenPr` are not called.
3. [unit] In the AC1 case, one warn is logged through `context.logger.warn` whose data carries `branch: "main"`.
4. [unit] `shouldRun` returns `false` for `context.branch` `master` and for `context.branch` `""`.
5. [unit] `shouldRun` with `context.branch` `develop` and `_autoPrDeps.readDefaultBranch` resolving `develop` returns `false`.
6. [unit] `shouldRun` with `context.branch` `feat/x`, `_autoPrDeps.readDefaultBranch` resolving `main`, and the forge stubs on their happy path returns `true`.
7. [unit] `execute` with `context.branch` `main` resolves `{ success: false }` with a message naming `main`, and `_autoPrDeps.run` receives no `git push` call.
8. [unit] `execute` with `context.branch` `develop` and `_autoPrDeps.readDefaultBranch` resolving `develop` resolves `{ success: false }` and runs no `git push`.
9. [unit] The default `_autoPrDeps.readDefaultBranch("/repo")`, with `_autoPrDeps.run` stubbed to answer `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` with exit 0 and stdout `origin/trunk\n`, resolves `trunk`.
10. [unit] The default `_autoPrDeps.readDefaultBranch` resolves `undefined` when `_autoPrDeps.run` answers that command with a non-zero exit, and when it throws.
11. [unit] `shouldRun` with `context.branch` `feat/x` and `_autoPrDeps.readDefaultBranch` resolving `undefined` (lookup failed) does not return `false` for the branch check, reaching `_autoPrDeps.getRemoteUrl`.
12. [unit] `isPublishableBranch` imported from `src/utils/git.ts` returns `false` for `""`, `main` and `master`, `false` for `release` with default branch `release`, and `true` for `feat/x` with default branch `main`.
