# SPEC: Per-Package Acceptance Tests for Monorepos (ACC-002)

## Summary

Generate per-package acceptance test files instead of a single cross-package file, fixing module resolution failures in monorepo projects where transitive dependencies can't be found from `.nax/`.

**GitHub Issue:** #49 (BUG-088)

## Problem

Acceptance tests are currently generated at `<root>/.nax/features/<feature>/acceptance.test.ts` — a single file covering ALL stories across ALL packages. When a test imports from `apps/api/src/...`, the source file resolves via relative path, but its transitive dependencies (`dotenv`, `supertest`, `@prisma/client`) are installed in `apps/api/node_modules` — unreachable from `.nax/`.

### Module resolution trace (broken)

```
File location:  <root>/.nax/features/vcs-integration/acceptance.test.ts
Import chain:   acceptance.test.ts → ../../../apps/api/src/utils/detect-provider.util.ts → dotenv

Bun resolves 'dotenv' starting from the importing file's directory:
  .nax/features/vcs-integration/node_modules/  → ✗
  .nax/features/node_modules/                  → ✗
  .nax/node_modules/                           → ✗
  <root>/node_modules/                         → ✗ (dotenv is in apps/api/node_modules)
  → Cannot find package 'dotenv'
```

### Why it worked before

When stories had `workdir: "apps/api"`, nax generated the acceptance test inside the package's own `.nax/` or similar path. Module resolution started from within the package directory, where `node_modules` had all dependencies.

The problem appeared when a feature spans multiple packages (e.g., VCS-001–003 in `apps/api`, VCS-004 in `apps/cli`).

## Design

### Core Idea

Group stories by `story.workdir` and generate **one acceptance test file per package**, placed inside each package directory. Each test runs from its package root where `node_modules` provides correct resolution.

### File Layout

```
<root>/
├── .nax/
│   └── features/vcs-integration/
│       ├── prd.json                          # centralized (unchanged)
│       ├── acceptance-refined.json           # centralized (unchanged)
│       └── acceptance-meta.json              # centralized (unchanged)
├── apps/api/.nax-acceptance.test.ts          # stories with workdir=apps/api
├── apps/cli/.nax-acceptance.test.ts          # stories with workdir=apps/cli
└── .nax-acceptance.test.ts                   # stories with workdir="" (root)
```

### Module resolution (fixed)

```
File location:  <root>/apps/api/.nax-acceptance.test.ts
Import chain:   .nax-acceptance.test.ts → ./src/utils/detect-provider.util.ts → dotenv

Bun resolves 'dotenv' starting from:
  apps/api/node_modules/  → ✓ found!
```

### Naming Convention

- `.nax-acceptance.test.ts` (dot-prefixed, matches language via `acceptanceTestFilename()`)
- Not inside `.nax/` — avoids nested `.nax/` directories and CLI confusion
- Gitignored via `**/.nax-acceptance*` at repo root

### Non-Monorepo (Single Package)

No behavioral change. Stories have no `workdir` (or `workdir: ""`), so there's one group → one file at `<root>/.nax-acceptance.test.ts`. Module resolution works from root `node_modules/` as before.

## Stories

---

### US-001: Group stories by workdir and generate per-package acceptance tests

#### Changes

**`src/pipeline/stages/acceptance-setup.ts`:**

1. After collecting `allCriteria` and `refinedCriteria`, group them by story workdir:
   ```ts
   // Group refined criteria by story workdir
   const storiesToProcess = ctx.prd.userStories.filter(s => !s.id.startsWith("US-FIX-"));
   const workdirGroups = new Map<string, { stories: UserStory[], criteria: RefinedCriterion[] }>();

   for (const story of storiesToProcess) {
     const wd = story.workdir ?? "";
     if (!workdirGroups.has(wd)) {
       workdirGroups.set(wd, { stories: [], criteria: [] });
     }
     workdirGroups.get(wd)!.stories.push(story);
   }

   // Assign refined criteria to their workdir group
   for (const rc of refinedCriteria) {
     const story = storiesToProcess.find(s => s.id === rc.storyId);
     const wd = story?.workdir ?? "";
     workdirGroups.get(wd)?.criteria.push(rc);
   }
   ```

2. For each group, generate a separate acceptance test file:
   ```ts
   for (const [workdir, group] of workdirGroups) {
     const packageDir = workdir ? path.join(ctx.workdir, workdir) : ctx.workdir;
     const testPath = path.join(packageDir, acceptanceTestFilename(language));
     // filename: .nax-acceptance.test.ts (via updated acceptanceTestFilename)

     await _acceptanceSetupDeps.generate(group.stories, group.criteria, {
       featureName: ctx.prd.feature,
       workdir: packageDir,       // package root, not repo root
       featureDir: ctx.featureDir, // metadata stays centralized
       ...
     });
   }
   ```

3. Store the list of generated test paths in `ctx.acceptanceTestPaths` (new field) for the acceptance runner.

**`src/acceptance/generator.ts`:**

4. Update `acceptanceTestFilename()` to return `.nax-acceptance.test.ts` (or language equivalent) instead of `acceptance.test.ts`:
   ```ts
   export function acceptanceTestFilename(language?: string): string {
     switch (language?.toLowerCase()) {
       case "python": return ".nax-acceptance.test.py";
       case "go": return ".nax-acceptance_test.go";
       case "rust": return ".nax-acceptance.rs";
       default: return ".nax-acceptance.test.ts";
     }
   }
   ```

5. Update the generator prompt's path anchor instruction — tell the LLM that the test file lives at `<package-root>/.nax-acceptance.test.ts` and imports are relative to the package root (no `../../../../` traversal needed):
   ```
   Path anchor: This test file lives at <package-root>/.nax-acceptance.test.ts.
   Import from package sources using relative paths like ./src/... .
   ```

6. RED gate: run each test file from its package directory:
   ```ts
   for (const { testPath, packageDir } of ctx.acceptanceTestPaths) {
     const cmd = buildAcceptanceRunCommand(testPath, testFramework, commandOverride);
     const { exitCode } = await _acceptanceSetupDeps.runTest(testPath, packageDir, cmd);
     // All must fail (RED) for the gate to pass
   }
   ```

#### Acceptance Criteria

1. Given a PRD with stories in `apps/api` (workdir="apps/api") and `apps/cli` (workdir="apps/cli"), when acceptance setup runs, then two test files are generated: `apps/api/.nax-acceptance.test.ts` and `apps/cli/.nax-acceptance.test.ts`
2. Given a single-package project (no story workdirs), when acceptance setup runs, then one test file is generated at `<root>/.nax-acceptance.test.ts` (backward compatible)
3. Given a generated per-package test file at `apps/api/.nax-acceptance.test.ts`, when it imports from `./src/utils/detect-provider.util.ts` which transitively requires `dotenv`, then the import resolves successfully from `apps/api/node_modules/`
4. Given generated test files, when the RED gate runs, then each file is executed from its respective package directory (cwd = package root)
5. Given `acceptanceTestFilename()` is called with no language, then it returns `.nax-acceptance.test.ts`

#### Files

- `src/pipeline/stages/acceptance-setup.ts` — grouping + per-package generation + RED gate
- `src/acceptance/generator.ts` — `acceptanceTestFilename()` rename + prompt update
- `src/pipeline/types.ts` — add `acceptanceTestPaths` to `PipelineContext`
- `test/unit/pipeline/stages/acceptance-setup.test.ts`
- `test/unit/acceptance/generator.test.ts`

---

### US-002: Per-package acceptance runner (post-implementation)

#### Changes

**`src/pipeline/stages/acceptance.ts`:**

1. Read `ctx.acceptanceTestPaths` (populated by acceptance-setup). If not set, fall back to single-file behavior for backward compatibility.

2. For each test path + package dir pair, run the acceptance test from the package directory:
   ```ts
   const testGroups = ctx.acceptanceTestPaths ?? [{
     testPath: path.join(ctx.featureDir, acceptanceTestFilename(language)),
     packageDir: ctx.workdir,
   }];

   let allPassed = true;
   const failedGroups: string[] = [];

   for (const { testPath, packageDir } of testGroups) {
     const testCmdParts = buildAcceptanceRunCommand(testPath, testFramework, commandOverride);
     logger.info("acceptance", "Running acceptance command", {
       cmd: testCmdParts.join(" "),
       packageDir,
     });
     const proc = Bun.spawn(testCmdParts, { cwd: packageDir, ... });
     // ... existing output parsing + AC matching logic
     if (exitCode !== 0) {
       allPassed = false;
       failedGroups.push(packageDir);
     }
   }
   ```

3. Feature passes only if ALL package tests pass. On failure, regenerate only the failed group's test file (not all groups).

4. Retry logic: when regenerating after failure, only regenerate the failed group's stories/criteria.

**`acceptance-meta.json`:**

5. Update metadata to include per-package info:
   ```json
   {
     "generatedAt": "...",
     "acFingerprint": "sha256:...",
     "storyCount": 4,
     "acCount": 24,
     "generator": "nax",
     "testFiles": [
       { "workdir": "apps/api", "path": "apps/api/.nax-acceptance.test.ts", "acCount": 18 },
       { "workdir": "apps/cli", "path": "apps/cli/.nax-acceptance.test.ts", "acCount": 6 }
     ]
   }
   ```

#### Acceptance Criteria

1. Given per-package test files exist, when the acceptance stage runs post-implementation, then each file is run from its respective package directory
2. Given one package's test passes and another fails, when acceptance evaluates results, then only the failed package's test is regenerated on retry
3. Given a project with no `acceptanceTestPaths` in context (pre-ACC-002 run), when acceptance stage runs, then it falls back to single-file behavior at the existing path
4. Given all per-package tests pass, when acceptance evaluates, then the feature acceptance passes
5. Given `acceptance-meta.json` is written after generation, then it includes a `testFiles` array with workdir, path, and acCount per group

#### Files

- `src/pipeline/stages/acceptance.ts` — per-package runner + aggregation
- `test/unit/pipeline/stages/acceptance.test.ts`

---

### US-003: Gitignore and test exclusion

#### Changes

1. **Precheck** — add `.nax-acceptance*` to the list of expected gitignore patterns in `src/precheck/checks-git.ts`. If not present, emit a warning (not a blocker):
   ```
   [warn] .nax-acceptance* files should be gitignored. Add '**/.nax-acceptance*' to .gitignore.
   ```

2. **Review runner** — update `NAX_RUNTIME_PATTERNS` in `src/review/runner.ts` to exclude `.nax-acceptance*` files from the uncommitted-changes check:
   ```ts
   /\.nax-acceptance[^/]*$/,
   ```

3. **Documentation** — add a note to `docs/guides/configuration.md` about monorepo acceptance test exclusion:
   ```
   For monorepo projects using jest/vitest, add to each package's test config:
     testPathIgnorePatterns: [".nax-acceptance"]
   This prevents the acceptance test from running during normal `npm test` / `npx turbo test`.
   ```

#### Acceptance Criteria

1. When precheck runs and `.gitignore` does not contain `.nax-acceptance`, then a warning is emitted (not a blocking error)
2. When review runs and `.nax-acceptance.test.ts` has uncommitted changes, then the review stage does not fail with "uncommitted changes" (treated as nax runtime file)
3. When the nax docs are built, then the configuration guide includes monorepo acceptance test exclusion guidance

#### Files

- `src/precheck/checks-git.ts` — gitignore pattern
- `src/review/runner.ts` — NAX_RUNTIME_PATTERNS
- `docs/guides/configuration.md` — monorepo guidance
- `test/unit/precheck/checks-git.test.ts`

---

## Implementation Order

```
US-001 (setup + generation) → US-002 (runner) → US-003 (gitignore + exclusion)
```

US-001 and US-002 are sequential (runner needs the new context fields). US-003 is independent but best done last.

## Migration / Backward Compatibility

- **Single-package projects**: no change. One group with `workdir=""`, file at `<root>/.nax-acceptance.test.ts` instead of `<root>/.nax/features/<feature>/acceptance.test.ts`. The file moves but behavior is identical.
- **Existing `.nax/features/<feature>/acceptance.test.ts`**: fingerprint mismatch triggers regeneration. Old file backed up automatically.
- **Old acceptance-meta.json without `testFiles`**: acceptance runner falls back to single-file mode.

## Status

- **Spec:** Draft
- **GitHub Issue:** #49
