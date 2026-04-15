# FEAT-015 — Test File Pattern Detection & SSOT

**Status:** Proposal
**Target:** v0.40.0
**Issue:** #461
**Date:** 2026-04-15

---

## 1. Problem

`testFilePatterns` is user-configurable at `config.execution.smartTestRunner.testFilePatterns`, but test-file knowledge is scattered across the codebase in multiple forms with no shared source of truth.

### 1.1 Classification bypass

Several sites classify test files without consulting config:

- `isTestFile(filePath)` in `src/test-runners/detector.ts` — hardcoded broad regex
- Inline checks in `src/context/auto-detect.ts:175` — `lower.includes(".test.") || lower.includes(".spec.")`
- Inline checks in `src/plugins/loader.ts:241` — `!filename.endsWith(".test.ts") && !filename.endsWith(".spec.ts")`
- Basename stripping in `src/review/diff-utils.ts:165` — hardcoded `.test.ts/.spec.ts/_test.go` regex
- Variant generation in `src/context/test-scanner.ts:130` — hardcoded `.test.ts/.spec.ts/.jsx/...` variants

### 1.2 Duplicate config keys for the same concept

Two config keys encode "what is a test file" with different defaults and formats:

| Config path | Format | Default |
|:---|:---|:---|
| `execution.smartTestRunner.testFilePatterns` | glob array | `["test/**/*.test.ts"]` |
| `context.testCoverage.testPattern` | single glob string | `"**/*.test.{ts,js,tsx,jsx}"` |

These can disagree — user setting one does not affect the other.

### 1.3 Stale derived defaults

`review.semantic.excludePatterns` and `review.adversarial.excludePatterns` default to a hardcoded list `[":!*.test.ts", ":!*.spec.ts", ":!*_test.go", ":!test/", ...]`. If the user sets `testFilePatterns: ["**/*.integration.ts"]`, their integration tests are *not* excluded from review diff because the default exclude list doesn't know about the custom pattern.

### 1.4 Four callers don't thread config

`tdd/orchestrator.ts`, `pipeline/stages/autofix-adversarial.ts`, `tdd/isolation.ts`, and `review/diff-utils.ts` all call `isTestFile(path)` without the `config` argument even though one is in scope.

### 1.5 TypeScript-centric defaults

`DEFAULT_TEST_FILE_PATTERNS = ["test/**/*.test.ts"]` is wrong for Go (`**/*_test.go`), Python (`test_*.py`), Rust, Java, and polyglot monorepos. No path to auto-detect per-project.

### 1.6 Monorepo per-package context ignored

Per-package overrides under `.nax/mono/<pkg>/config.json` are not consulted. A TS frontend and Go backend in one repo cannot be classified correctly under a single root pattern list.

**Goal:** one resolver, one classifier, three formats (glob/pathspec/regex), sourced from user config with auto-detection fallback, honouring monorepo per-package context. Eliminate all inline test-file classification.

---

## 2. Design — SSOT Architecture

### 2.1 Three pattern formats, one source

Test-file knowledge is used in three incompatible formats across the codebase. The SSOT must produce all three from a single input:

| Format | Example | Used by |
|:---|:---|:---|
| **Glob** | `**/*.test.ts` | Smart runner, file matchers, test-scanner |
| **Pathspec** | `:!*.test.ts` | Git diff exclusion in review |
| **Regex** | `/\.test\.ts$/` | Path classification, basename stripping |

Plus a fourth derived artefact:

| Artefact | Example | Used by |
|:---|:---|:---|
| **Test dirs** | `["test", "__tests__"]` | Directory scans, `context.testCoverage.testDir` auto-detect |

### 2.2 Resolver → Classifier pipeline

```
┌────────────────────────────────────────────────────────────────┐
│ resolveTestFilePatterns(config, packageDir?)                   │
│   1. packageDir + .nax/mono/<pkg>/config.json override        │
│   2. root config.execution.smartTestRunner.testFilePatterns   │
│   3. detectTestFilePatterns(packageDir ?? workdir)            │
│   4. DEFAULT_TEST_FILE_PATTERNS fallback                      │
│                                                                │
│   Returns: ResolvedTestPatterns { globs, pathspec, regex,     │
│             testDirs }                                         │
└────────────────────────────────────────────────────────────────┘
                             │
             ┌───────────────┼──────────────────┐
             ▼               ▼                  ▼
    ┌────────────────┐ ┌──────────────┐ ┌──────────────────────┐
    │ classifier     │ │ excludePat-  │ │ test-scanner variant │
    │ (path)→boolean │ │ terns default│ │ generator            │
    └────────────────┘ └──────────────┘ └──────────────────────┘
```

### 2.3 New modules

| Module | Responsibility |
|:---|:---|
| `src/test-runners/resolver.ts` | Layered lookup; returns `ResolvedTestPatterns` (all three formats + dirs) |
| `src/test-runners/detect.ts` | Signal-based detection (framework configs, manifests, file scan) |
| `src/test-runners/classifier.ts` | Build `(path) => boolean` from resolved patterns |
| `src/test-runners/detector.ts` | `isTestFile()` becomes backward-compat thin wrapper |
| `src/commands/detect.ts` | `nax detect [--apply]` CLI |

### 2.4 API surface

```typescript
// src/test-runners/resolver.ts
export interface ResolvedTestPatterns {
  /** Glob form — for file matchers: ["**\/*.test.ts"] */
  readonly globs: readonly string[];
  /** Git pathspec form for diff exclusion: [":!*.test.ts", ":!test/"] */
  readonly pathspec: readonly string[];
  /** Regex form for path classification: [/\.test\.ts$/] */
  readonly regex: readonly RegExp[];
  /** Directory names extracted from globs: ["test", "__tests__"] */
  readonly testDirs: readonly string[];
  /** How the patterns were resolved (resolver layer — distinct from DetectionSource.type which is a detection-tier label) */
  readonly resolution: "per-package" | "root-config" | "detected" | "fallback";
}

export function resolveTestFilePatterns(
  config: NaxConfig,
  packageDir?: string,
): Promise<ResolvedTestPatterns>;

/**
 * Resolve the effective review excludePatterns.
 * When user set excludePatterns explicitly → returned as-is (user override wins).
 * When omitted → derived from resolved test patterns + noise dirs.
 */
export function resolveReviewExcludePatterns(
  userExplicit: readonly string[] | undefined,
  resolvedTestPatterns: ResolvedTestPatterns,
): readonly string[];

// src/test-runners/detect.ts
export interface DetectionResult {
  patterns: readonly string[];
  confidence: "high" | "medium" | "low" | "empty";
  sources: readonly DetectionSource[];
}
export interface DetectionSource {
  type: "framework-config" | "manifest" | "file-scan" | "directory";
  path: string;
  patterns: readonly string[];
}
export function detectTestFilePatterns(workdir: string): Promise<DetectionResult>;

// src/test-runners/classifier.ts
export function createTestFileClassifier(
  resolved: ResolvedTestPatterns,
): (path: string) => boolean;

// src/test-runners/detector.ts — backward-compat
export function isTestFile(
  filePath: string,
  testFilePatterns?: readonly string[],
): boolean;
```

### 2.5 Dependency injection (`_deps` pattern)

Project convention requires all modules with external I/O to export an injectable `_deps` for test mocking. `mock.module()` is banned.

```typescript
// src/test-runners/resolver.ts
export const _resolverDeps = {
  fileExists: (path: string) => Bun.file(path).exists(),
  readJson: async (path: string) => JSON.parse(await Bun.file(path).text()),
  detectTestFilePatterns,  // injectable so resolver tests don't run real detection
};

// src/test-runners/detect.ts
export const _detectDeps = {
  spawn: Bun.spawn,           // git ls-files, glob walks
  file: Bun.file,              // manifest reads
  readJson: async (p: string) => JSON.parse(await Bun.file(p).text()),
  readToml: parseToml,         // pyproject.toml / Cargo.toml
  readYaml: parseYaml,         // pnpm-workspace.yaml
};
```

Test pattern (mirrors existing `_diffUtilsDeps`, `_isolationDeps`, etc.):

```typescript
import { _resolverDeps } from "../../../src/test-runners/resolver";

let origReadJson: typeof _resolverDeps.readJson;
beforeEach(() => {
  origReadJson = _resolverDeps.readJson;
  _resolverDeps.readJson = mock(async () => ({ testFilePatterns: ["**/*.spec.ts"] }));
});
afterEach(() => { _resolverDeps.readJson = origReadJson; });
```

### 2.6 Error handling (NaxError)

All throws must use `NaxError` with code + context. Error cases:

| Condition | Code | Context |
|:---|:---|:---|
| `.nax/mono/<pkg>/config.json` read fails (permission / corrupt) | `MONO_CONFIG_READ_FAILED` | `{ packageDir, stage: "resolver", cause }` |
| Cache file corrupt (`JSON.parse` fails) | (no throw — log debug, treat as miss) | — |
| Manifest parse fails during detection | `MANIFEST_PARSE_FAILED` | `{ manifestPath, stage: "detect", cause }` |
| Invalid glob pattern user-provided | `INVALID_TEST_GLOB` | `{ pattern, stage: "resolver" }` |
| `--apply` write fails | `CONFIG_WRITE_FAILED` | `{ targetPath, cause }` → exits with code 2 |

Returns (non-throws):
- Missing `.nax/mono/<pkg>/config.json` → `null`, fall through to root config
- Detection yields zero signals → `{ confidence: "empty", patterns: [] }`, caller falls through to fallback

### 2.7 `packageDir` discovery

Callers pass `packageDir` when they know it. Two sources:

1. **Pipeline context:** `ctx.packageDir` already threaded for monorepo-aware stages. Pipeline callers pass `ctx.packageDir`.
2. **Walk-up from file path:** when a classification site has only a file path (no package context), use the utility:

```typescript
// src/test-runners/resolver.ts
export async function findPackageDir(filePath: string, workdir: string): Promise<string | undefined> {
  // Walks up from filePath looking for the nearest .nax/mono/<pkg>/ match,
  // or nearest package.json/go.mod/pyproject.toml. Returns undefined when at workdir root.
}
```

Callers that operate on individual files (e.g. classifier built once per file) should resolve patterns once per story/package, not per file. See §2.8 for the caller pattern.

### 2.8 Caller pattern — async resolver, sync classifier

`resolveTestFilePatterns` is async (reads files). `createTestFileClassifier` returns a sync `(path) => boolean`. Callers **resolve once, classify many**:

```typescript
// ✅ Correct — resolve once per story
async function processStory(ctx: PipelineContext) {
  const resolved = await resolveTestFilePatterns(ctx.rootConfig, ctx.packageDir);
  const isTest = createTestFileClassifier(resolved);

  const testFiles = changedFiles.filter(isTest);
  const sourceFiles = changedFiles.filter((f) => !isTest(f));
  // ...
}

// ❌ Wrong — resolves per file, O(N) async calls
async function processStoryBadly(files: string[], ctx: PipelineContext) {
  for (const f of files) {
    const resolved = await resolveTestFilePatterns(ctx.rootConfig, ctx.packageDir);
    // ...
  }
}
```

Resolver MUST be called from async contexts. Pipeline stages are already async; non-async utility functions that currently call `isTestFile()` sync must either:
- Accept a pre-built classifier as a parameter (preferred for hot paths)
- Become async and call the resolver themselves

### 2.9 Logging

All logs from resolver/detector emitted via `getSafeLogger()`:

- Stage prefix: `"resolver"` or `"detect"`
- Include `storyId` when called from pipeline context (pipeline callers pass it as an options arg)
- Include `packageDir` when monorepo-scoped
- Detection tier + confidence logged at `info` when detection actually runs (not cache hit)

```typescript
// Inside resolver/detect
logger.info("detect", "Test patterns detected", {
  storyId,                // when available
  packageDir,             // when monorepo
  confidence: result.confidence,
  patternCount: result.patterns.length,
  tier: result.sources[0]?.type,
});
```

### 2.10 File size budget

Expected module line counts (project convention: 400-line hard limit):

| Module | Est. LOC | Action |
|:---|:---|:---|
| `resolver.ts` | ~150 | Single file |
| `classifier.ts` | ~60 | Single file |
| `detect/index.ts` | ~80 | Orchestrator |
| `detect/framework-configs.ts` | ~200 | Tier 1 parsers (vitest/jest/pytest/etc.) |
| `detect/framework-defaults.ts` | ~80 | Tier 2 map |
| `detect/file-scan.ts` | ~120 | Tier 3 `git ls-files` bucketing |
| `detect/directory-scan.ts` | ~80 | Tier 4 fallback |
| `detect/workspace.ts` | ~150 | Monorepo workspace discovery |
| `detect/cache.ts` | ~100 | Cache read/write/invalidate |
| `commands/detect.ts` | ~200 | CLI |

Pre-planned splits prevent "refactor later when it exceeds 400 lines" churn.

---

## 3. Detection Methodology

Detection produces a prioritized candidate list. Higher-tier sources override lower-tier ones for the same language/ecosystem. Multiple languages in one project produce a union.

### 3.1 Signal tiers

**Tier 1 — Framework config files (high confidence)**

| Source | Extract |
|:---|:---|
| `vitest.config.*` | `test.include` |
| `jest.config.*`, `package.json#jest` | `testMatch`, `testRegex` |
| `pyproject.toml [tool.pytest.ini_options]` | `testpaths`, `python_files` |
| `pytest.ini`, `setup.cfg` | `testpaths`, `python_files` |
| `.mocharc.*` | `spec` globs |
| `playwright.config.*` | `testDir`, `testMatch` |
| `cypress.config.*` | `specPattern` |

**Tier 2 — Framework declared, no explicit config (medium confidence)**

| Signal | Default patterns |
|:---|:---|
| `vitest` in `devDependencies` | `**/*.{test,spec}.?(c\|m)[jt]s?(x)` |
| `jest` in `devDependencies` | `**/__tests__/**/*.[jt]s?(x)`, `**/?(*.)+(spec\|test).[jt]s?(x)` |
| `bun test` in `scripts.test` | `**/*.test.{ts,tsx,js,jsx}` |
| `pytest` in `project.dependencies` | `test_*.py`, `*_test.py` |
| `go.mod` present | `**/*_test.go` |
| `Cargo.toml` present | `tests/**/*.rs` |

**Tier 3 — File system evidence (low confidence)**

Walk `git ls-files`, bucket by common test-file suffix, rank by count. Suffixes above threshold (≥5 files or ≥10 % of any suffix) enter the result as globs.

**Tier 4 — Directory convention fallback**

Check for `test/`, `tests/`, `__tests__/`, `spec/`. Extract file extensions within. Emits generic globs (`test/**/*.<ext>`).

### 3.2 Algorithm

```
detectTestFilePatterns(workdir) → DetectionResult:
  1. languages := detect language manifests in workdir
  2. for each language:
     a. try Tier 1 → if found, confidence[lang] = "high"
     b. else Tier 2 → confidence[lang] = "medium"
     c. cross-check against Tier 3 scan; log warning on mismatch
  3. if no languages OR no Tier 1-2 results → Tier 3 drives; confidence = "low"
  4. if still empty → Tier 4 → confidence = "low" or "empty"
  5. normalize:
       - dedupe by suffix
       - sort deterministically
       - skip patterns that don't convert cleanly (jest testRegex)
  6. confidence = worst of per-language confidences
```

### 3.3 Conflict handling

- **High tier vs file scan disagree:** high tier stands, warning emitted in `DetectionResult.sources`.
- **Regex can't convert to glob:** skip and log; user can add manually via `nax detect` output.
- **Empty project (no tests yet):** use Tier 2 defaults from declared framework; fall back to language-ecosystem defaults if no framework declared.
- **Multiple frameworks (jest + playwright):** union both. Playwright's `testDir` usually scopes differently, safe to include both.
- **Excluded dirs:** always filter out `node_modules/`, `dist/`, `build/`, `.nax/`, `coverage/`, `.git/`.

### 3.4 Monorepo detection

Workspace roots detected from:

- `pnpm-workspace.yaml`
- `package.json#workspaces`
- `lerna.json`
- `rush.json`, `nx.json`, `turbo.json`
- Nested `go.mod`, `pyproject.toml`, `Cargo.toml` (independent packages without workspace declaration)
- Existing `.nax/mono/` layout

For each workspace, run the single-package algorithm. Result: `{ root: DetectionResult, packages: Record<string, DetectionResult> }`.

---

## 4. Storage Model

### 4.1 Layering order (highest priority first)

```
1. .nax/mono/<pkg>/config.json   ← per-package override (monorepo)
2. .nax/config.json              ← project root
3. Auto-detected (ephemeral)     ← computed at runtime
4. Language-agnostic fallback    ← broad regex in detector.ts
```

### 4.2 Config shape — concrete examples

**Before (current state):**

```jsonc
// .nax/config.json
{
  "execution": {
    "smartTestRunner": {
      // Zod supplies DEFAULT_TEST_FILE_PATTERNS = ["test/**/*.test.ts"]
      // when absent. No way to distinguish "user omitted" from "user chose default".
    }
  }
}
```

**After — single-package project, user omits (detection handles it):**

```jsonc
// .nax/config.json
{
  "execution": {
    "smartTestRunner": {
      // testFilePatterns omitted → resolver runs detectTestFilePatterns()
      // For a Go repo, this yields ["**/*_test.go"] at runtime.
    }
  }
}
```

**After — single-package project, user explicit override:**

```jsonc
// .nax/config.json
{
  "execution": {
    "smartTestRunner": {
      "testFilePatterns": ["src/**/*.spec.ts", "test/**/*.integration.ts"]
    }
  }
}
```

**After — `nax detect --apply` on a Go project (persisted):**

```jsonc
// .nax/config.json
{
  "execution": {
    "smartTestRunner": {
      "testFilePatterns": ["**/*_test.go"]
    }
  }
}
```

**After — monorepo, root config only (inherited by all packages):**

```jsonc
// .nax/config.json
{
  "execution": {
    "smartTestRunner": {
      "testFilePatterns": ["**/*.test.ts"]
    }
  }
}
// No .nax/mono/<pkg>/config.json overrides — every package uses root patterns.
```

**After — polyglot monorepo, per-package overrides (`nax detect --apply`):**

```jsonc
// .nax/config.json — root: TS frontend lives here
{
  "execution": {
    "smartTestRunner": {
      "testFilePatterns": ["**/*.test.ts", "**/*.spec.ts"]
    }
  }
}

// .nax/mono/api/config.json — Go service
{
  "execution": {
    "smartTestRunner": {
      "testFilePatterns": ["**/*_test.go"]
    }
  }
}

// .nax/mono/ml/config.json — Python
{
  "execution": {
    "smartTestRunner": {
      "testFilePatterns": ["tests/**/*.py", "**/test_*.py"]
    }
  }
}
```

**After — user explicit "no patterns" (empty array):**

```jsonc
// .nax/config.json
{
  "execution": {
    "smartTestRunner": {
      "testFilePatterns": []
      // Explicit empty is semantically distinct from omitted:
      // resolver returns [] as-is, classifier always returns false.
      // Useful for disabling test-file aware logic in unusual setups.
    }
  }
}
```

**After — `review.excludePatterns` derives from test patterns when omitted:**

```jsonc
// User sets testFilePatterns for integration tests; excludePatterns omitted
{
  "execution": {
    "smartTestRunner": {
      "testFilePatterns": ["**/*.integration.ts"]
    }
  },
  "review": {
    "semantic": {
      // excludePatterns omitted → derived from testFilePatterns + noise dirs:
      //   [":!**/*.integration.ts", ":!.nax/", ":!.nax-pids"]
      // Integration tests are excluded from semantic review diff.
    }
  }
}
```

**After — user explicit `excludePatterns` wins (user override):**

```jsonc
// User wants to INCLUDE test files in review + also exclude vendor/
{
  "review": {
    "semantic": {
      "excludePatterns": [":!vendor/", ":!.nax/"]
      // User's list used as-is. Test files are NOT excluded because
      // user did not list them. testFilePatterns has no effect here.
    }
  }
}
```

**After — `context.testCoverage.testPattern` deprecated (aliased):**

```jsonc
// Legacy config still loads with a warning; aliased to testFilePatterns
{
  "context": {
    "testCoverage": {
      "testPattern": "**/*.spec.ts"
      // DEPRECATED — migrate to:
      //   execution.smartTestRunner.testFilePatterns: ["**/*.spec.ts"]
      // Migration shim logs a warning at config load, uses the value
      // as-if it had been set in smartTestRunner.testFilePatterns.
    }
  }
}
```

### 4.3 Schema changes

```typescript
// src/config/schemas.ts

const SmartTestRunnerConfigSchema = z.object({
  // ...
  // Was: .default(DEFAULT_TEST_FILE_PATTERNS)
  // Becomes: optional, resolver handles detection when undefined.
  testFilePatterns: z.array(z.string()).optional(),
});

const SemanticReviewConfigSchema = z.object({
  // ...
  // Was: .default([":!test/", ":!tests/", ":!*_test.go", ":!*.test.ts", ...])
  // Becomes: optional; resolveReviewExcludePatterns() derives from
  // resolved testFilePatterns + noise dirs when user omits.
  excludePatterns: z.array(z.string()).optional(),
});

// Same change for AdversarialReviewConfigSchema.

const TestCoverageConfigSchema = z.object({
  // ...
  // DEPRECATED — migration shim aliases to smartTestRunner.testFilePatterns.
  testPattern: z.string().optional(),
});
```

**Rationale:**
- `.default()` erases the distinction between "user omitted" and "user set to default value". Optional + runtime resolution preserves the semantics so derivation can kick in only when the user has not made a choice.
- `excludePatterns` default had hardcoded test globs that go stale when the user sets non-default `testFilePatterns`. Deriving on omission fixes the staleness while preserving user override freedom.
- `context.testCoverage.testPattern` is a duplicate of `testFilePatterns` with a different default and single-string format. Consolidating eliminates disagreement between the two keys.

### 4.4 `excludePatterns` resolution

User-facing behavior:

| `review.semantic.excludePatterns` | Behavior |
|:---|:---|
| Omitted | Derived from `ResolvedTestPatterns.pathspec` + well-known test dirs + nax noise dirs. Stays in sync with custom `testFilePatterns`. |
| Explicit list (any length, incl. empty) | Used as-is. User override wins. |

**Parity requirement:** the derived list for a TS project with default `testFilePatterns` must equal the current hardcoded default (no silent behavior change). Current default is:

```
[":!test/", ":!tests/", ":!*_test.go", ":!*.test.ts", ":!*.spec.ts",
 ":!**/__tests__/", ":!.nax/", ":!.nax-pids"]
```

Derivation must therefore cover both the user-configured patterns AND a fixed list of well-known test dirs/suffixes that are always excluded regardless of project language (to avoid including other languages' test files in a TS project's review).

```typescript
// src/test-runners/resolver.ts — constants co-located with the resolver
const WELL_KNOWN_TEST_DIRS = ["test", "tests", "__tests__"] as const;
const WELL_KNOWN_TEST_SUFFIXES = ["*.test.ts", "*.spec.ts", "*_test.go"] as const;
const NAX_NOISE_PATHS = [".nax/", ".nax-pids"] as const;

function resolveReviewExcludePatterns(
  userExplicit: readonly string[] | undefined,
  resolved: ResolvedTestPatterns,
): readonly string[] {
  if (userExplicit !== undefined) return userExplicit;

  const result = new Set<string>();

  // 1. Project's resolved test patterns (from user config / detection)
  for (const p of resolved.pathspec) result.add(p);
  for (const d of resolved.testDirs) result.add(`:!${d}/`);

  // 2. Well-known test dirs/suffixes — always excluded to handle
  //    polyglot repos and edge cases where detection missed something.
  //    Prevents regression vs. current hardcoded default.
  for (const d of WELL_KNOWN_TEST_DIRS) result.add(`:!${d}/`);
  for (const s of WELL_KNOWN_TEST_SUFFIXES) result.add(`:!${s}`);

  // 3. nax noise paths
  for (const p of NAX_NOISE_PATHS) result.add(`:!${p}`);

  return [...result];
}
```

**Parity proof for TS default** — user omits `testFilePatterns`, fallback produces `["test/**/*.test.ts"]`:

| Source | Contributes |
|:---|:---|
| `resolved.pathspec` from `["test/**/*.test.ts"]` | `:!*.test.ts` |
| `resolved.testDirs` | `:!test/` |
| `WELL_KNOWN_TEST_DIRS` | `:!test/`, `:!tests/`, `:!__tests__/` |
| `WELL_KNOWN_TEST_SUFFIXES` | `:!*.test.ts`, `:!*.spec.ts`, `:!*_test.go` |
| `NAX_NOISE_PATHS` | `:!.nax/`, `:!.nax-pids` |
| **Deduped union** | `[":!*.test.ts", ":!test/", ":!tests/", ":!__tests__/", ":!*.spec.ts", ":!*_test.go", ":!.nax/", ":!.nax-pids"]` |

Matches current hardcoded default (order may differ; pathspec order is not semantically significant for git diff exclusion).

**Why not derive noise exclusively from `testFilePatterns`?** Because a user configuring `testFilePatterns: ["**/*.integration.ts"]` still doesn't want `.spec.ts` files reviewed if they exist in vendored code, `__tests__` dirs from dependencies extracted into the repo, etc. Well-known noise is always noise.

### 4.5 `context.testCoverage.testPattern` migration shim

Runs at the raw-JSON layer, **before** Zod parse, so the shim can distinguish "user omitted" from "user set to default". Returns a new object (no mutation, per project convention).

```typescript
// src/config/migrations.ts
export function migrateLegacyTestPattern(
  raw: Record<string, unknown>,
  logger: Logger,
): Record<string, unknown> {
  const legacyPattern = raw?.context?.testCoverage?.testPattern;
  if (legacyPattern === undefined) return raw;

  logger.warn("config",
    "context.testCoverage.testPattern is deprecated — migrate to " +
    "execution.smartTestRunner.testFilePatterns",
    { legacyPattern });

  const smartRunnerPatterns = raw?.execution?.smartTestRunner?.testFilePatterns;
  if (smartRunnerPatterns !== undefined) {
    // User set both — smartTestRunner wins. Drop legacy, no alias.
    const { testPattern: _drop, ...testCoverageRest } = raw.context.testCoverage;
    return {
      ...raw,
      context: { ...raw.context, testCoverage: testCoverageRest },
    };
  }

  // Alias into smartTestRunner.testFilePatterns
  return {
    ...raw,
    execution: {
      ...raw.execution,
      smartTestRunner: {
        ...raw.execution?.smartTestRunner,
        testFilePatterns: [legacyPattern],
      },
    },
    context: {
      ...raw.context,
      testCoverage: { ...raw.context.testCoverage, testPattern: undefined },
    },
  };
}
```

Legacy configs continue to work. New configs should use `testFilePatterns` only.

### 4.6 Persistence policy

- **Pipeline runs (`nax run`, `nax generate`):** **reads** only. Resolver reads config + runs detection in-memory; ephemeral cache writes to `.nax/cache/` are allowed (cache is not user-tracked config). Never writes `.nax/config.json` or `.nax/mono/<pkg>/config.json`.
- **`nax detect`:** prints, no writes.
- **`nax detect --apply`:** writes user config files. Monorepo mode writes per-package configs; single-package mode writes root config.

**Why no silent config writes:** surprise changes to user-tracked config files create merge conflicts and "why did this appear?" confusion. Opt-in via `--apply` is safer. `.nax/cache/` is `.gitignore`'d in the standard nax setup, so cache writes don't have the same concern.

### 4.7 Caching

Detection cost: filesystem walk + 2–6 file parses. Cache by `(workdir, [manifest mtimes])`. Invalidate on manifest mtime change.

- **Location:** `.nax/cache/test-patterns.json` (workdir-local; gitignored)
- **Lazy creation:** resolver calls `Bun.write()` which creates parent dirs; no explicit `mkdir`
- **Concurrency:** parallel `nax run` invocations may race on cache write. Accept last-write-wins — cache content is derived, not source of truth; a lost write rebuilds cheaply on next read. No file lock.
- **Corrupt cache:** on `JSON.parse` failure, log at `debug`, treat as cache miss, rewrite.
- **Schema:**

```jsonc
{
  "workdir": "/abs/path",
  "mtimes": {
    "package.json": 1728000000,
    "vitest.config.ts": 1728000001
  },
  "result": { "patterns": [...], "confidence": "high", "sources": [...] }
}
```

---

## 5. Callers to Update

### 5.1 Classification sites (replace with classifier)

| Call site | Current | New |
|:---|:---|:---|
| `tdd/orchestrator.ts:196` | `session1.filesChanged.filter(isTestFile)` | `.filter(classifier)` from `resolveTestFilePatterns(config)` |
| `pipeline/stages/autofix-adversarial.ts:32-33` | `isTestFile(f.file ?? "")` | Classifier from `ctx.rootConfig` + `ctx.packageDir` |
| `tdd/isolation.ts:69,98` | `isTestFile(f)` | Classifier from threaded `testFilePatterns` param |
| `review/diff-utils.ts:157-158` | `.filter(isTestFile)` | Classifier from threaded param |
| `context/auto-detect.ts:175` | Inline `lower.includes(".test.") \|\| lower.includes(".spec.") \|\| lower.includes("/test/")` | Classifier from `config` in scope |
| `plugins/loader.ts:241` | Inline `!filename.endsWith(".test.ts") && !filename.endsWith(".spec.ts")` | Classifier (plugin loader needs access to config) |

### 5.2 Pattern-format consumers (replace hardcoded lists)

| Call site | Current | New |
|:---|:---|:---|
| `config/schemas.ts:291-302` — `SemanticReviewConfigSchema.excludePatterns` default | Hardcoded `[":!*.test.ts", ":!*.spec.ts", ":!test/", ...]` | Optional; resolved via `resolveReviewExcludePatterns()` at use site |
| `config/schemas.ts` — `AdversarialReviewConfigSchema.excludePatterns` default | Same hardcoded list | Same change |
| `review/orchestrator.ts:252-253` | Inline `":!*.test.ts", ":!*.spec.ts"` in diff pathspec | Consume `resolved.pathspec` |
| `review/runner.ts:291-292` | Same inline pathspec | Same |
| `context/test-scanner.ts:130` — `deriveTestPatterns()` | Hardcoded `.test.ts/.spec.ts/.jsx` variants | Generate from `resolved.globs` suffixes |
| `context/test-scanner.ts:118` — `COMMON_TEST_DIRS` | Hardcoded dir list | `resolved.testDirs` with fallback for discovery |
| `review/diff-utils.ts:165` — basename stripping | Hardcoded `.test\.(ts\|js)$\|_test\.go$` regex | Use `resolved.regex` to strip |

### 5.3 Config key migration

| Call site | Current | New |
|:---|:---|:---|
| `config/schemas.ts:423` — `TestCoverageConfigSchema.testPattern` | `.default("**/*.test.{ts,js,tsx,jsx}")` | `.optional()` + deprecation shim aliases to `smartTestRunner.testFilePatterns` |
| `context/builder.ts:184` — reads `tcConfig?.testPattern` | Single-string glob | After migration, `testFilePatterns[0]` or join as needed |
| `context/greenfield.ts:103` — `testPattern` parameter | Default `"**/*.{test,spec}.{ts,js,tsx,jsx}"` | Passed through from resolved patterns |

### 5.4 Downstream callers (threading only)

Sites that already have config in scope and simply need to resolve + thread:

- `tdd/session-runner.ts:237,239` — threads `testFilePatterns` into `verifyTestWriterIsolation` / `verifyImplementerIsolation`
- `tdd/rectification-gate.ts:259` — threads into `verifyImplementerIsolation`
- `review/adversarial.ts:197` — threads into `computeTestInventory`
- `review/semantic.ts` — threads into `resolveReviewExcludePatterns` for effective diff exclusion
- `context/builder.ts` — threads into `test-scanner.ts` and `greenfield.ts`

### 5.5 Untouched by this change (scope boundary)

- `src/test-runners/parser.ts` — parses framework output format, not file paths
- `src/acceptance/test-path.ts` — language-based acceptance test filename (different concept)
- `src/analyze/scanner.ts` — display-only framework detection (could optionally consume detected patterns but not required)
- Prompt text (`src/prompts/builders/*.ts`) — hardcoded examples in LLM instructions. Separate cleanup task if needed; low priority.

---

## 6. CLI — `nax detect`

### 6.1 Output

```
$ nax detect
Workdir: /home/user/my-repo

Detected patterns:
  root             ["**/*.test.ts", "**/*.spec.ts"]     (high, vitest.config.ts)
  packages/api     ["**/*_test.go"]                      (medium, go.mod)
  packages/ml      ["tests/**/*.py", "test_*.py"]        (high, pyproject.toml)

Currently effective (from config):
  root             ["test/**/*.test.ts"]                 (Zod default)
  packages/api     ["test/**/*.test.ts"]                 (inherits root)

Run `nax detect --apply` to write detected patterns to .nax/ configs.
```

### 6.2 Flags

- `--apply` — write detected patterns to `.nax/config.json` (root) and `.nax/mono/<pkg>/config.json` (per-package). Skips writes when detection is `empty` confidence. Skips writes for configs where the user has already set `testFilePatterns` explicitly (unless `--force`).
- `--json` — machine-readable output for scripting.
- `--package <dir>` — restrict detection to a single package directory.
- `--force` — used with `--apply`: overwrite even when the user has explicitly set `testFilePatterns`. Without `--force`, `--apply` is additive-only (writes only to configs that currently have the field omitted).

### 6.3 Exit codes

| Code | Meaning |
|:---|:---|
| 0 | Detection successful |
| 1 | Detection empty (no signals found) |
| 2 | Write failed (`--apply` only) |

---

## 7. Files Affected

### 7.1 New files

| File | Purpose |
|:---|:---|
| `src/test-runners/resolver.ts` | `resolveTestFilePatterns()`, `resolveReviewExcludePatterns()` |
| `src/test-runners/detect.ts` | Signal-based detection (Phase 2) |
| `src/test-runners/classifier.ts` | `createTestFileClassifier(resolved)` |
| `src/commands/detect.ts` | `nax detect` command (Phase 2) |

### 7.2 Existing files — Phase 1 (plumbing)

| File | Change |
|:---|:---|
| `src/test-runners/conventions.ts` | Extend to produce pathspec + regex forms alongside globs |
| `src/test-runners/detector.ts` | `isTestFile(path, patterns?)` — backward-compat thin wrapper |
| `src/test-runners/index.ts` | Export resolver, detect, classifier |
| `src/config/schemas.ts` | `testFilePatterns` → optional; `excludePatterns` → optional (semantic + adversarial); `testPattern` → optional (with deprecation shim) |
| `src/config/loader.ts` (or wherever migration happens) | Deprecation shim for `context.testCoverage.testPattern` → `testFilePatterns` |
| `src/tdd/orchestrator.ts` | Use classifier |
| `src/tdd/isolation.ts` | Add `testFilePatterns?` param to both isolation functions |
| `src/tdd/session-runner.ts` | Resolve and thread |
| `src/tdd/rectification-gate.ts` | Resolve and thread |
| `src/pipeline/stages/autofix-adversarial.ts` | Use classifier from `ctx.rootConfig` |
| `src/review/diff-utils.ts` | Add `testFilePatterns?` param to `computeTestInventory`; replace hardcoded basename regex with `resolved.regex` |
| `src/review/adversarial.ts` | Resolve and thread; use `resolveReviewExcludePatterns()` for effective exclude list |
| `src/review/semantic.ts` | Use `resolveReviewExcludePatterns()` |
| `src/review/orchestrator.ts` | Replace inline pathspec `":!*.test.ts"` with resolved pathspec |
| `src/review/runner.ts` | Same |
| `src/context/auto-detect.ts` | Replace inline test check with classifier |
| `src/context/test-scanner.ts` | Replace `COMMON_TEST_DIRS` + hardcoded variant generation with `resolved.testDirs` + generated variants |
| `src/context/greenfield.ts` | Accept resolved patterns |
| `src/context/builder.ts` | Thread resolved patterns into test-scanner |
| `src/plugins/loader.ts` | Replace inline check with classifier (requires config access — may need a small refactor) |

### 7.3 Existing files — Phase 2 (detection + CLI)

| File | Change |
|:---|:---|
| `src/test-runners/detect.ts` | Replace stub with full four-tier detection |
| `src/test-runners/detect/*.ts` | New sub-modules per §2.10 split plan |
| `src/commands/detect.ts` | Full `nax detect` implementation |
| `src/cli/index.ts` | Register `detect` command |

**Runtime artefacts** (not source files):

- `.nax/cache/test-patterns.json` — cache read/written by resolver. Gitignored. Created lazily by `Bun.write()`.

---

## 8. Implementation Plan — Two Phases

### Phase 1 — SSOT Plumbing (no auto-detection yet)

**Scope:** threads resolver + classifier through every classification site. No behavior change for users with default config. Eliminates all inline test-file classification.

Phase 1 work (grouped by concern):

1. **Core SSOT modules**
   - `resolver.ts` — layered lookup returning `ResolvedTestPatterns` (all four artefacts: globs, pathspec, regex, testDirs); exports `_resolverDeps`
   - `classifier.ts` — `createTestFileClassifier(resolved)`
   - `detect.ts` — stub returning `{ confidence: "empty" }` (real detection lands in Phase 2); exports `_detectDeps` shape
   - Extend `conventions.ts` with `toPathspec()`, `toDirNames()` helpers
   - `isTestFile(path, patterns?)` backward-compat wrapper in `detector.ts`
   - `resolveReviewExcludePatterns()` with parity-preserving derivation (§4.4)
   - `findPackageDir()` utility (§2.7)

2. **Schema changes + migration**
   - `testFilePatterns: z.array(z.string()).optional()`
   - `excludePatterns` on semantic + adversarial → `.optional()`
   - `context.testCoverage.testPattern: .optional()` + deprecation shim at raw-JSON layer (§4.5) — immutable, returns new object
   - `NaxError` codes registered: `MONO_CONFIG_READ_FAILED`, `MANIFEST_PARSE_FAILED`, `INVALID_TEST_GLOB`, `CONFIG_WRITE_FAILED`

3. **Thread through classification sites (Section 5.1)**
   - 4 original callers (orchestrator, autofix-adversarial, isolation, diff-utils)
   - `context/auto-detect.ts` — replace inline check with classifier
   - `plugins/loader.ts` — `isPluginFile()` accepts classifier as parameter; `loadPlugins()` (called from `execution/lifecycle/run-setup.ts:217` with config in scope) builds the classifier and passes it down. No architectural refactor needed.

4. **Thread through pattern-format consumers (Section 5.2)**
   - `review/orchestrator.ts` + `review/runner.ts` — inline pathspec → `resolved.pathspec`
   - `review/semantic.ts` + `review/adversarial.ts` — use `resolveReviewExcludePatterns()`
   - `context/test-scanner.ts` — `COMMON_TEST_DIRS` → `resolved.testDirs`; `deriveTestPatterns()` → generated from `resolved.globs`
   - `context/builder.ts` + `context/greenfield.ts` — thread resolved patterns
   - `review/diff-utils.ts` basename stripping → `resolved.regex`

5. **Tests** (see §9 for full plan)
   - Unit: resolver layering, classifier from each format, `resolveReviewExcludePatterns` parity proof, migration shim immutability
   - Integration: user sets custom `testFilePatterns` → flows through isolation + review exclude + context scanner
   - Regression: TS default configs produce identical effective `excludePatterns` as before

**Risk:** medium. Much broader than initial framing because several inline-classification sites and duplicate config keys are being migrated in one pass. Mitigated by:
- Default behavior preserved when user has no explicit config (detect stub returns empty, fallback is `DEFAULT_TEST_FILE_PATTERNS`, derived `excludePatterns` matches current hardcoded default for TS projects)
- Deprecation shim keeps legacy `testPattern` configs working with a warning
- Wide test coverage including regression checks for default behavior

### Phase 2 — Auto-detect + `nax detect` + persistence

**Scope:** make the detect stub real; add CLI command; wire cache; handle monorepo per-package writes.

- Implement four-tier detection in `detect.ts` (framework config → framework default → file scan → directory convention)
- Workspace detection for monorepos (`pnpm-workspace.yaml`, nested manifests, etc.)
- Cache: `.nax/cache/test-patterns.json`, invalidated on manifest mtime change
- `nax detect [--apply] [--json] [--package <dir>] [--force]`
- Monorepo per-package write logic (writes to `.nax/mono/<pkg>/config.json`)
- Detection runs automatically during pipeline when user has no explicit config — **reads only**, writes one info log line per run with the detected patterns + confidence + tier, but does NOT persist to user config files. Persistence requires explicit `nax detect --apply`.
- Tests: fixture repos for TS (vitest/jest/bun), Go, Python, Rust, polyglot monorepo

**Risk:** medium. Detection heuristics can guess wrong on unusual setups. Mitigated by:
- `nax detect` visibility — user can always see what detection produced
- Explicit `--apply` opt-in for persistence (no silent config writes)
- Cache invalidation tied to manifest changes, not time
- Fallback chain ends at `DEFAULT_TEST_FILE_PATTERNS` so behavior degrades gracefully

---

## 9. Test Plan

### 9.1 Unit tests

**`resolver.test.ts`**
- Returns per-package override when `.nax/mono/<pkg>/config.json` has explicit patterns
- Returns root config when no per-package override
- Falls through to detect when no explicit config
- Falls through to `DEFAULT_TEST_FILE_PATTERNS` when detect returns empty
- Respects `testFilePatterns: []` as explicit "no patterns" (distinct from undefined)
- `ResolvedTestPatterns` contains consistent globs, pathspec, regex, testDirs
- `resolveReviewExcludePatterns()` returns user explicit list as-is when set
- `resolveReviewExcludePatterns()` derives from test patterns + noise dirs when omitted
- `resolveReviewExcludePatterns()` returns `[]` when user explicitly sets `[]`

**`classifier.test.ts`**
- Classifies `.test.ts` as test for `["**/*.test.ts"]`
- Classifies `_test.go` as test for `["**/*_test.go"]`
- Rejects source files
- Empty pattern list → always false
- Classifier from custom pattern `["**/*.integration.ts"]` classifies `foo.integration.ts` as test

**`config-migration.test.ts`**
- Legacy `context.testCoverage.testPattern` aliases to `smartTestRunner.testFilePatterns`
- Deprecation warning logged once at config load
- Alias skipped when `smartTestRunner.testFilePatterns` is already set explicitly
- Shim returns a new object (input unchanged — immutability check)
- Shim drops legacy `testPattern` key from output

**`review-excludepatterns.test.ts`** — parity regression
- TS default config → derived `excludePatterns` ⊇ current hardcoded default (every hardcoded entry present in derived set)
- Custom `testFilePatterns: ["**/*.integration.ts"]` → `:!*.integration.ts` present in derived list
- User explicit `excludePatterns: []` → returns `[]` (user wins)
- User explicit `excludePatterns: [":!vendor/"]` → returns as-is (no test exclusions auto-added)
- Derived list order: stable across calls (Set-based dedup, documented non-order)

**`cache.test.ts`** (Phase 2)
- Fresh workdir → cache miss, detection runs
- Second call with unchanged mtimes → cache hit, detection NOT called
- Manifest mtime change → cache invalidated, detection re-runs
- Corrupt cache JSON → log debug, rebuild, no throw
- Concurrent writes (two resolvers write same path) → last-write-wins, no lock error

**`plugin-loader-integration.test.ts`**
- `loadPlugins()` with custom `testFilePatterns` → plugin files matching pattern are NOT loaded as plugins
- Default config → `foo.test.ts` excluded from plugins (backward compat with existing behavior)

**`detect.test.ts`** (fixture-based)
- `vitest.config.ts` with `test.include` → high confidence
- `package.json#jest.testMatch` → high confidence
- `jest` in deps, no config → medium confidence, default patterns
- `go.mod` only → `**/*_test.go`, medium
- `pyproject.toml` with `[tool.pytest.ini_options]` → high
- File scan only (no manifest) → low confidence
- Empty workdir → `confidence: "empty"`
- Polyglot (TS + Go) → union of patterns
- Monorepo (`pnpm-workspace.yaml` + 2 packages) → per-package results

**`detector.test.ts`**
- `isTestFile(path, patterns)` with explicit patterns uses them
- `isTestFile(path)` without patterns uses broad regex (backward compat)

### 9.2 Integration tests

- End-to-end: set `testFilePatterns: ["src/**/*.spec.ts"]` in config → isolation check classifies `src/foo.spec.ts` as test → TDD session passes
- Monorepo fixture: root has TS, `packages/go-svc/` has Go; both packages classified correctly during `nax run`

### 9.3 CLI tests

- `nax detect` on TS fixture prints vitest patterns
- `nax detect --apply` writes config; second run reads from written config
- `nax detect --json` produces parseable JSON
- `nax detect --apply` on monorepo writes per-package configs

---

## 10. Backward Compatibility

| Scenario | Behavior |
|:---|:---|
| Existing `.nax/config.json` with explicit `testFilePatterns` | Unchanged — resolver returns it as-is |
| Config without `testFilePatterns` (Phase 1) | Falls back to `DEFAULT_TEST_FILE_PATTERNS` (identical to current behavior) |
| Config without `testFilePatterns` (Phase 2) | Auto-detect runs; if empty, falls back to `DEFAULT_TEST_FILE_PATTERNS` |
| Callers still passing `isTestFile(path)` without patterns | Still work — broad regex fallback stays in `detector.ts` |
| Monorepo using `.nax/mono/<pkg>/config.json` without `testFilePatterns` | Inherits from root config (explicit or detected) |
| Legacy `context.testCoverage.testPattern` set | Warning logged; value aliased to `smartTestRunner.testFilePatterns` |
| Legacy hardcoded `excludePatterns` default was in user's head | Derived default produces the same list for TS projects with default `testFilePatterns` — no behavior change |
| User relied on review including test files by omission | Still works — user must set `excludePatterns: []` explicitly (previously had to override the hardcoded list anyway) |
| User had custom `testFilePatterns` but default `excludePatterns` | **Behavior improves.** Previously integration tests were included in review diff; now they're excluded because derivation stays in sync. User can revert by setting `excludePatterns` explicitly. |

No breaking changes to public API. Schema changes are forward-compatible:
- Old configs with explicit `testFilePatterns` / `excludePatterns` continue to work (user override always wins)
- Old configs without them get the same effective defaults as before for TS projects
- Legacy `testPattern` configs keep working via deprecation shim

**Known behavior changes (intentional improvements):**
1. User-defined `testFilePatterns` now influences review diff exclusion (bug fix).
2. User-defined `testFilePatterns` now influences plugin file filtering and auto-detect context scanning (bug fix — these previously ignored config).
3. Phase 2: polyglot projects get language-appropriate patterns auto-detected instead of TS-centric default (bug fix).

---

## 11. Performance

Detection runs at most once per workdir per pipeline run (cached). Cost breakdown per cold detection:

| Step | Operation | Est. cost |
|:---|:---|:---|
| Manifest read × 2–6 | `Bun.file().text()` + parse | ~5ms |
| `git ls-files` (Tier 3) | Single spawn; bounded to tracked files | 10–100ms depending on repo size |
| File scan bucketing | Pure JS over ls-files output | <10ms |
| Workspace walk (monorepo) | `N × cold detection` for N packages | 50ms–1s for typical monorepo |
| Cache write | `Bun.write()` | <5ms |

**Bounds:**
- Tier 3 file scan is capped to `git ls-files` output — no full filesystem walk on untracked junk
- No node_modules / vendor walk
- Monorepo detection is sequential today; parallelism deferred to v2 if needed

**Warm cache:** single file read + mtime comparison. <5ms.

Acceptable overhead for pipeline startup (which already takes seconds for config load, plugin discovery, etc.). If a future profile shows this in the hot path, the cache can be promoted to in-process memo keyed by `(workdir, runId)`.

---

## 12. Open Questions

1. **Cache invalidation across nax runs** — resolved: survive, invalidate on manifest mtime change only. See §4.7.
2. **Should `nax run` emit a log line when detection kicks in?** — resolved: yes, one info line per run, per §2.9.
3. **Broad regex in `detector.ts` — remove or keep as safety net?**
   - Goal (§1) says "eliminate all inline classification." The broad regex IS inline.
   - Resolution: keep in Phase 1 **only** as the backward-compat fallback for `isTestFile(path)` calls without `patterns` arg. All Phase 1 callers are migrated to the classifier path, so the regex becomes unreachable from production code paths once Phase 1 lands.
   - **Remove** in Phase 2 alongside detection going live — at that point the resolver always returns a non-empty list (detection fallback chain ends at `DEFAULT_TEST_FILE_PATTERNS`), so the "called without patterns" path no longer exists.
4. **ADR required?** — Yes. See `docs/adr/ADR-009-test-file-pattern-ssot.md` for the architectural record (SSOT rule, resolution chain, three-format output, user-override policy, no-silent-writes). This spec remains the implementation reference.
5. **Should `nax detect --apply --migrate` also strip deprecated `testPattern` key?** — yes, when `--apply` writes a new `testFilePatterns`, the write function removes any co-located legacy `testPattern` to prevent config drift. Flag not required — migration is implicit with `--apply`.

---

## 13. References

- `docs/adr/ADR-009-test-file-pattern-ssot.md` — architectural decision record
- Issue #461 — original proposal
- `src/test-runners/conventions.ts` — existing SSOT for glob-based patterns
- `src/test-runners/detector.ts` — current hardcoded broad regex list
- `.claude/rules/project-conventions.md` — logging, file size, Bun-native constraints, storyId requirement
- `.claude/rules/forbidden-patterns.md` — `mock.module()` banned; `_deps` pattern required
- `.claude/rules/error-handling.md` — `NaxError` usage
- `.claude/rules/test-architecture.md` — test file placement mirroring `src/`
