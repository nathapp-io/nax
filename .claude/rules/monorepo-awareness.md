# Monorepo & Language-Agnostic Awareness

> nax orchestrates AI agents across **polyglot monorepos**. Every subsystem (context, verification, review, TDD, acceptance) can run against a TS frontend in one package and a Go backend in another, sometimes in the same run. Code that silently assumes a single-language, single-package layout is a latent bug.

This document is the SSOT for "how do I handle paths / languages / packages?" rules. When in doubt, consult the resolver or registry listed below — never reintroduce a hardcoded assumption.

## Path Variable Vocabulary

| Variable | Meaning | Usually from |
|:---|:---|:---|
| `repoRoot` | Absolute path where `.nax/` lives | `ctx.workdir`, `ContextRequest.repoRoot` |
| `packageDir` | Absolute path to the story's package; equals `repoRoot` for single-package | `ContextRequest.packageDir`, `join(ctx.workdir, ctx.story.workdir)` |
| `story.workdir` | **Relative** path from `repoRoot` to the package (e.g. `packages/lib`) | `UserStory.workdir` |
| `projectDir` | Absolute path where session/manifest artifacts are written | `ctx.projectDir` |

**Rule:** use `packageDir` for anything scoped to one package. Use `repoRoot` for `.nax/` reads/writes and cross-package scanning. Never use `process.cwd()` in source code (CLI entry points excepted — see below).

## Source-Code Rules

### 1. No `process.cwd()` outside CLI entry points

| ❌ Forbidden in | ✅ Permitted in |
|:---|:---|
| `src/context/`, `src/pipeline/`, `src/verification/`, `src/review/`, `src/tdd/`, `src/acceptance/`, `src/agents/`, `src/plugins/`, `src/execution/` (anywhere called inside a run) | `src/cli/*.ts`, `src/commands/*.ts`, `src/config/loader.ts` as the bootstrap default |

Reason: a run may be launched from any cwd (parent shell, editor, CI worker); the only authoritative anchor is the workdir passed into the pipeline.

Correct pattern:

```typescript
// ✅ Parameter, defaulted only at the CLI boundary
export async function stageFn(ctx: PipelineContext): Promise<StageResult> {
  const target = ctx.packageDir ?? ctx.workdir;
  // ...
}

// ✅ CLI entry point — single bootstrap line, documented
const workdir = options.dir ?? process.cwd();
```

### 2. No hardcoded test-file patterns

Covered by [forbidden-patterns.md](./forbidden-patterns.md) → **Test-File Classification Convention**. Summary: all `.test.ts` / `.spec.ts` / `_test.go` / `test/unit/` literals outside `src/test-runners/` are banned. Use `resolveTestFilePatterns(config, workdir, packageDir)` (ADR-009 SSOT). Per-package overrides live in `.nax/mono/<packageDir>/config.json`.

### 3. No hardcoded test runner commands

| ❌ Forbidden | ✅ Use Instead |
|:---|:---|
| `const cmd = "bun test"` as the truth | `config.quality.commands.test` (per-package via `.nax/mono/<pkg>/config.json`) |
| `cmd.startsWith("bun test")` for language detection | `config.quality.language` or `detectLanguage(packageDir)` |
| `"go test"`, `"pytest"`, `"cargo test"` literals | Same — config-driven |

Reason: `bun test` works only for TS. Go packages run `go test ./...`, Python runs `pytest`, Rust runs `cargo test`. A single-run config cannot encode all three without per-package layering.

A fallback string (`?? "bun test"`) is permitted **only** at the outermost pipeline boundary (e.g. `src/execution/lifecycle/run-regression.ts`) where the error path is a friendly "no test command configured" warning. Deeper consumers must have the command passed in.

### 4. No hardcoded source-file prefix

| ❌ Forbidden | ✅ Use Instead |
|:---|:---|
| `filePath.startsWith("src/")` | Strip via `relative(packageDir, absolutePath)` first; source location varies per language (`src/` for TS, no convention for Go/Python) |
| `path.match(/^src\//)` for classification | Use `packageDir` as the anchor; grep for imports, not paths |

**Permitted exception:** mirror-layout rewrites where a glob of the form `test/unit/**/*.test.ts` and a source of the form `<pkg>/src/<inner>` need to be composed — the `src/` anchor is semantically required. Document this at the call site. Current permitted site: `deriveSiblingTestCandidates()` in `src/context/engine/providers/code-neighbor.ts` (mirrored TS-style layouts only).

### 5. Package detection goes through one resolver

Every file that needs to know "what package is this file in?" or "what packages does this repo have?" must call one of:

| Need | API |
|:---|:---|
| "Which packages exist in the repo?" | `discoverWorkspacePackages(repoRoot)` — `src/test-runners/detect/workspace.ts` |
| "Which package does this file belong to?" | `findPackageDir(filePath, repoRoot)` — `src/test-runners/resolver.ts` |
| "What language is this package?" | `detectLanguage(packageDir)` — `src/project/detector.ts` |
| "What test framework?" | `detectTestFramework(packageDir)` — `src/test-runners/detect/framework.ts` |

Do not duplicate package-boundary marker lookups (`package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`) in new code. Extend the existing detectors.

### 6. Glob scans must pass `cwd` explicitly

| ❌ Forbidden | ✅ Use Instead |
|:---|:---|
| `new Bun.Glob(pattern).scan()` — no cwd | `new Bun.Glob(pattern).scanSync({ cwd, absolute: false })` |
| `new Bun.Glob(pattern).scan(process.cwd())` | `new Bun.Glob(pattern).scan(packageDir)` or `repoRoot` |

Glob without cwd defaults to `process.cwd()`, which re-introduces the cwd-contamination bug.

When scanning may exceed many files, cap it:

```typescript
const MAX_GLOB_FILES = 200;
let count = 0;
for (const file of g.scanSync({ cwd, absolute: false })) {
  if (count >= MAX_GLOB_FILES) {
    logger.debug("subsystem", "Glob cap reached — results truncated", { storyId, cap: MAX_GLOB_FILES });
    break;
  }
  // ...
  count++;
}
```

### 7. Provider scope must be declared

Every context provider and verification strategy must declare which anchor it uses:

| Scope | Anchor | Examples |
|:---|:---|:---|
| `repo-scoped` | `repoRoot` | `StaticRulesProvider`, `FeatureContextProvider` |
| `package-scoped` | `packageDir` | `GitHistoryProvider`, `CodeNeighborProvider`, `SessionScratchProvider` |
| `cross-package` | `extraGlobWorkdirs` via `resolveExtraGlobWorkdirs()` | `CodeNeighborProvider` when `crossPackageDepth > 0` |

Declare scope in the file header comment. Add a one-line justification for anything cross-package.

### 8. Absolute paths stay internal

Paths persisted to disk (`descriptor.json`, `context-manifest-*.json`, session scratch) must be either:
- **Relative** to `projectDir` or `repoRoot` (portable) — preferred
- **Absolute** with an explicit note that the artifact is machine-local (e.g. runtime socket paths)

New JSON schemas under `.nax/` require path-handling review. See [#530](https://github.com/nathapp-io/nax/issues/530) for the pending descriptor migration.

### 9. Log `packageDir` when doing cross-package work

When a subsystem handles multiple packages, every `logger.*` call must include both `storyId` and `packageDir` so parallel runs can be correlated:

```typescript
// ✅ Correct — parallel-mode correlation works
logger.debug("provider", "Scanning cross-package reverse deps", {
  storyId: ctx.story.id,
  packageDir,
  extraDirs: extraGlobWorkdirs,
});

// ❌ Wrong — cannot attribute across concurrent stories in the same JSONL file
logger.debug("provider", "Scanning", { extraDirs });
```

## Design Rules

### A. New features must support per-package config

If a feature introduces a new config key that could reasonably differ per package (commands, patterns, budgets, thresholds), the resolution order must be:

1. Per-package — `.nax/mono/<packageDir>/config.json`
2. Root — `<workdir>/.nax/config.json`
3. Detection — project-type-aware default
4. Fallback — canonical safe default

This matches the ADR-009 resolver pattern. Extend `src/config/` rather than shortcutting.

### B. New feature language-neutrality checklist

Before merging a feature that touches source files, verify:

- [ ] No hardcoded extension list (`.ts`, `.tsx`, `.js`, `.jsx`)
- [ ] No hardcoded test marker (`.test`, `.spec`, `_test`, `test_`)
- [ ] No hardcoded import syntax (`import { x } from "./y"`)
- [ ] No hardcoded test runner command
- [ ] No hardcoded package-manager command (`bun install`, `npm ci`, `go mod tidy`)
- [ ] Language-specific logic is gated behind `detectLanguage()` or config, not a naked regex

The feature can still have a language-specific implementation (e.g. JS/TS-only forward-dep parser) — but it must **declare and document** that scope and return `empty` gracefully for other languages, not silently no-op or crash.

### C. One source of truth per concept

Consolidate. Every new concept gets one resolver/registry and only one:

| Concept | Resolver |
|:---|:---|
| Test-file patterns | `resolveTestFilePatterns()` |
| Test framework | `detectTestFramework()` |
| Package language | `detectLanguage()` |
| Package directory from file | `findPackageDir()` |
| Workspace packages | `discoverWorkspacePackages()` |
| Permissions profile | `resolvePermissions()` |

If a new file needs to answer "X?", search for an existing resolver before writing `COMMON_X = [...]` constants. The second inline constant is a bug waiting to happen.

## Current Known Violations (2026-04-18 audit)

These are tracked and will be cleaned up incrementally. Do not add to this list.

| Site | Violation | Tracking |
|:---|:---|:---|
| `src/context/test-scanner.ts:121,148-150,189` | `COMMON_TEST_DIRS` + `.spec.ts` literals — ADR-009 | [#533](https://github.com/nathapp-io/nax/issues/533) |
| `src/verification/smart-runner.ts:199,336-337` | Hardcoded `test/unit/` + `test/integration/` layout | [#534](https://github.com/nathapp-io/nax/issues/534) |
| `src/context/builder.ts:265` | `workdir \|\| process.cwd()` fallback | [#535](https://github.com/nathapp-io/nax/issues/535) |
| `src/prompts/sections/role-task.ts:24-28` | Language detection by `cmd.startsWith("bun test")` | [#536](https://github.com/nathapp-io/nax/issues/536) |

## References

- ADR-009 — Test-file pattern SSOT (`docs/adr/ADR-009-test-file-pattern-ssot.md`)
- Amendment C AC-54 — Dual workdir scoping (`docs/specs/SPEC-context-engine-v2.md`)
- [forbidden-patterns.md](./forbidden-patterns.md) — Full banned-pattern list
- [config-patterns.md](./config-patterns.md) — Per-package config layering
- Resolver: `src/test-runners/resolver.ts`
- Detectors: `src/project/detector.ts`, `src/test-runners/detect/`
