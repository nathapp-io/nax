# SPEC: Plan-Stage Source Roots (replace static file tree with tool-led navigation)

## Summary

Replace the `nax plan` stage's static codebase file tree (~12k tokens, hardcoded to `<workdir>/src`, depth 3) with a short auto-detected "Source Roots" section (~80–200 tokens) and lift the prompt restriction that prevents the planning agent from using its already-available Read/Grep/Glob tools. The new section is monorepo-aware via `discoverWorkspacePackages()` and language-agnostic via `detectLanguage()`. Cuts ~12k tokens per plan run, fixes a latent bug where the tree is empty for Go/Python/Rust/polyglot projects, and aligns the plan stage with how the agent already works in every other run-kind op.

## Motivation

Today's plan prompt has three connected problems:

1. **Bloat.** [`scanCodebase()`](../../src/analyze/scanner.ts) emits a depth-3 tree of `<workdir>/src` and inlines it via [`buildCodebaseContext()`](../../src/cli/plan-helpers.ts). On the nax repo this is ~12k of 28k total prompt tokens — the single largest section.
2. **Wrong for non-TS/non-`src` layouts.** The `srcPath = join(workdir, "src")` hardcode in `scanner.ts:30` makes the tree empty (`"No src/ directory"`) for Go (`cmd/`, `internal/`), Python (top-level package), Rust (`crates/*/src/`), and any monorepo without a root `src/`. Violates [`monorepo-awareness.md`](../../.claude/rules/monorepo-awareness.md) Rule 4 (no hardcoded source prefix).
3. **Contradicts the agent's capabilities.** [`planInteractiveOp`](../../src/operations/plan.ts) is `kind: "run"` — the agent has Read/Grep/Glob. Yet [plan-builder.ts:209](../../src/prompts/builders/plan-builder.ts#L209) instructs *"file names and structure only — no file content. Do NOT assert specific line numbers."* The static tree exists to compensate for a restriction the prompt itself imposes.

The result is that planning agents work blind in projects nax claims to support, pay a 12k-token surcharge per run, and observed spec→code drift (e.g. the `verifiedBy`/`intent` field misplacement in `enhanced-debate-phase-2/prd.json`) traces partly to the agent never seeing real type shapes.

## Design

### Replaces today's `## Codebase Structure` + `## Dependencies` + `## Test Setup` sections

```markdown
## Source Roots

You have Read, Grep, and Glob tools — explore on demand. Cite findings as `path:line`.
Budget: aim for ≤ 10 file reads per story.

- packages/api  (typescript, framework: NestJS, tests: jest)
- packages/web  (typescript, framework: Next.js, tests: vitest)
- cmd/worker    (go, tests: go-test)
```

Single-package fallback:

```markdown
## Source Roots

You have Read, Grep, and Glob tools — explore on demand. Cite findings as `path:line`.
Budget: aim for ≤ 10 file reads per story.

- .  (typescript, framework: bun, tests: bun:test)
```

Total size: ~80–200 tokens regardless of repo size (vs ~12k today).

**Dropped sections:** `## Dependencies` (full npm package list) and `## Test Setup` (hardcoded test pattern list) are intentionally removed along with the file tree. Both were rendered by `buildCodebaseContext()` in `src/cli/plan-helpers.ts`. Framework and test runner are now captured in the `SourceRoot` entries — sufficient for planning decisions. The agent can `Glob("package.json")` to read full deps when a story genuinely requires it.

### Types to add

```typescript
// src/analyze/types.ts
export interface SourceRoot {
  /** Relative path from workdir (e.g. "packages/api", "cmd/worker", "."). */
  path: string;
  /** Detected language; undefined when no language markers are present. */
  language: "typescript" | "javascript" | "go" | "rust" | "python" | undefined;
  /** Detected framework label (e.g. "NestJS", "Next.js"); empty string when unknown. */
  framework: string;
  /** Detected test runner label (e.g. "jest", "vitest", "go-test", "pytest"); empty string when unknown. */
  testRunner: string;
}
```

### APIs to add

```typescript
// src/analyze/scanner.ts
/**
 * Discover source roots in a workdir. Monorepo-aware (via discoverWorkspacePackages),
 * language-agnostic (via detectLanguage), and capped at MAX_SOURCE_ROOTS entries.
 *
 * Returns a single "." root for single-package projects.
 */
export async function scanSourceRoots(workdir: string): Promise<SourceRoot[]>;
```

```typescript
// src/cli/plan-helpers.ts
/** Render the source-roots section emitted into the planning prompt. */
export function buildSourceRootsSection(roots: SourceRoot[]): string;
```

### Algorithm

```
scanSourceRoots(workdir):
  packages = discoverWorkspacePackages(workdir)        // existing SSOT
  if packages.length === 0:
    packages = ["."]                                    // single-package fallback
  if packages.length > MAX_SOURCE_ROOTS (30):
    log warn, truncate to 30
  for each pkgPath in packages:
    pkgDir    = join(workdir, pkgPath)
    language  = detectLanguage(pkgDir)                  // existing SSOT
    pkgJson   = read package.json if present
    summary   = buildPackageSummary(pkgPath, pkgJson)   // existing helper — framework + testRunner
    testRunner = summary.testRunner || detectTestFramework(pkgDir) || ""
    emit { path: pkgPath, language, framework: summary.framework, testRunner }
  return roots
```

`detectLanguage`, `discoverWorkspacePackages`, `buildPackageSummary`, and `detectTestFramework` are all existing — no new resolvers are introduced (per [`monorepo-awareness.md`](../../.claude/rules/monorepo-awareness.md) Rule "one source of truth per concept").

### Tool-access contract

Replace the restriction line at [plan-builder.ts:209](../../src/prompts/builders/plan-builder.ts#L209) with the budget line baked into the Source Roots section header. The agent already has tools because the op is `kind: "run"`; this change removes the prompt-level prohibition. The `proposers.fileReadAccess` parameter at [plan-builder.ts:83](../../src/prompts/builders/plan-builder.ts#L83) is preserved unchanged — debate-proposer paths still pass `fileReadAccess: true` to the builder and must continue to receive the full file-read permission block; this parameter becomes meaningful only for that path.

### Integration

- **Existing types to extend:** `CodebaseScan` is **not** modified (kept for the grounder path). `SourceRoot` is new.
- **Integration points:**
  - [`src/cli/plan.ts:98`](../../src/cli/plan.ts#L98) — replace `_planDeps.scanCodebase()` + `buildCodebaseContext()` with `_planDeps.scanSourceRoots()` + `buildSourceRootsSection()`.
  - [`src/cli/plan-decompose.ts:63`](../../src/cli/plan-decompose.ts#L63) — same substitution.
  - [`src/cli/plan-runtime.ts`](../../src/cli/plan-runtime.ts) — replace `scanCodebase` entry in `_planDeps` with `scanSourceRoots`; remove the `scanCodebase` import from this file.
  - [`src/prompts/builders/plan-builder.ts:128-130`](../../src/prompts/builders/plan-builder.ts#L128) — the `codebaseContext` argument now carries the source-roots section string instead of the file tree.
- **Deletions:**
  - `buildCodebaseContext` in [`src/cli/plan-helpers.ts`](../../src/cli/plan-helpers.ts) — remove after migrating the two callers (`plan.ts`, `plan-decompose.ts`). The grounder has its own local `buildCodebaseContext` in `src/debate/pre-phase/grounder.ts` and does not import from `plan-helpers`.
  - The `import { buildCodebaseContext }` lines in `plan.ts` and `plan-decompose.ts`.
- **Kept intact:**
  - `scanCodebase` export in `src/analyze/scanner.ts` — the grounder (`src/debate/pre-phase/grounder.ts`) imports it directly from `@/analyze`; that path is out of scope.
  - `buildCodebaseContext` local function in `src/debate/pre-phase/grounder.ts` — private to the grounder; untouched.
- **Not changed (out of scope):** [`grounder.ts`](../../src/debate/pre-phase/grounder.ts) keeps using `scanCodebase` — replacing the grounder's input is a separate decision tracked as a follow-up.
- **Existing patterns to follow:** [`discoverWorkspacePackages`](../../src/test-runners/detect/workspace.ts) — already the SSOT for monorepo root detection. [`detectLanguage`](../../src/project/detector.ts) — already the SSOT for per-package language detection.

### Approach

This is a **prompt-input substitution**, not an algorithmic change. The plan op's structure, the PRD schema, and the rectification loop are untouched. The agent gains nothing it didn't already have (tools were always available); it loses a redundant static snapshot that was wrong for half the languages nax supports.

### Failure Handling

- **No workspace packages detected AND no `package.json`/`go.mod`/etc.** → `scanSourceRoots` returns `[{ path: ".", language: undefined, framework: "", testRunner: "" }]`. The prompt section still renders with `(unknown)` placeholders. Agent uses tools to figure out the layout.
- **`discoverWorkspacePackages` throws** → caught at the caller; log warning with `storyId` and fall back to `[{ path: ".", language: detectLanguage(workdir), ... }]`. Plan stage continues.
- **`detectLanguage` returns `undefined`** for one root → emit `(unknown)` for that root only; do not fail other roots.
- **More than `MAX_SOURCE_ROOTS` (30) packages** → log warning, truncate to first 30 sorted alphabetically. The agent is instructed to use Glob if it needs sibling packages.
- **No retry needed.** The function is pure file-system probing; failures degrade gracefully.

## Stories

1. **US-001: Add `SourceRoot` type + `scanSourceRoots` function** — no dependencies. Pure addition; no callers yet.
2. **US-002: Wire `scanSourceRoots` into `plan.ts` + `plan-decompose.ts` + `PlanPromptBuilder`** — depends on US-001. Removes the static tree, drops `## Dependencies` / `## Test Setup`, and removes the file-read restriction line.

### Dependencies

- US-001: no dependencies
- US-002: depends on US-001

### Context Files

**US-001:**
- [`src/analyze/types.ts`](../../src/analyze/types.ts) — `CodebaseScan` type; `SourceRoot` is added alongside
- [`src/analyze/scanner.ts`](../../src/analyze/scanner.ts) — existing `scanCodebase` to leave intact; new `scanSourceRoots` added here
- [`src/analyze/index.ts`](../../src/analyze/index.ts) — barrel; export the new symbols
- [`src/test-runners/detect/workspace.ts`](../../src/test-runners/detect/workspace.ts) — `discoverWorkspacePackages` SSOT to reuse
- [`src/project/detector.ts`](../../src/project/detector.ts) — `detectLanguage` and `detectTestFramework` SSOTs to reuse
- [`src/cli/plan-helpers.ts`](../../src/cli/plan-helpers.ts) — `buildPackageSummary` helper to reuse for framework/testRunner inference
- [`test/integration/plan/analyze-scanner.test.ts`](../../test/integration/plan/analyze-scanner.test.ts) — existing scanner integration test patterns to follow

**US-002:**
- [`src/prompts/builders/plan-builder.ts`](../../src/prompts/builders/plan-builder.ts) — `PlanPromptBuilder.build()` and `buildFileReadInstruction()` to revise
- [`src/cli/plan.ts`](../../src/cli/plan.ts) — `scanCodebase` call site at line 98
- [`src/cli/plan-decompose.ts`](../../src/cli/plan-decompose.ts) — `scanCodebase` call site at line 63
- [`src/cli/plan-runtime.ts`](../../src/cli/plan-runtime.ts) — `_planDeps` shape to update
- [`src/cli/plan-helpers.ts`](../../src/cli/plan-helpers.ts) — add `buildSourceRootsSection`; delete `buildCodebaseContext`
- [`src/operations/plan.ts`](../../src/operations/plan.ts) — confirm `kind: "run"` (no change expected, just verification)
- [`test/unit/cli/plan.test.ts`](../../test/unit/cli/plan.test.ts), [`test/unit/cli/plan-callop.test.ts`](../../test/unit/cli/plan-callop.test.ts), [`test/unit/cli/plan-interactive.test.ts`](../../test/unit/cli/plan-interactive.test.ts) — existing mock patterns for `_planDeps.scanCodebase` to update to `scanSourceRoots`
- [`test/unit/cli/plan-debate.test.ts`](../../test/unit/cli/plan-debate.test.ts) — verify grounder path is unchanged

## Acceptance Criteria

### US-001: Add `SourceRoot` type + `scanSourceRoots` function

- `scanSourceRoots(workdir)` returns an array of length 1 when `workdir` contains a single `package.json` declaring TypeScript and no workspace markers
- The single root returned for a TypeScript single-package project has `{ path: ".", language: "typescript" }`
- `scanSourceRoots(workdir)` returns one `SourceRoot` per discovered package when `workdir` contains a pnpm/npm/lerna/turbo/nx workspace
- Each workspace root has `path` equal to the workspace-relative package directory and `language` resolved per package
- `scanSourceRoots(workdir)` returns `[{ path: ".", language: "go", framework: "", testRunner: "go-test" }]` when `workdir` contains a `go.mod` and no `package.json`
- `scanSourceRoots(workdir)` returns `[{ path: ".", language: "python", framework: "", testRunner: "pytest" }]` when `workdir` contains a `pyproject.toml`
- `scanSourceRoots(workdir)` returns `[{ path: ".", language: undefined, framework: "", testRunner: "" }]` when `workdir` contains no `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, or `requirements.txt`
- `scanSourceRoots(workdir)` returns at most 30 entries when the discovered package count exceeds 30
- `scanSourceRoots(workdir)` logs a warning with `count` and `truncatedTo` fields when the discovered package count exceeds 30
- `scanSourceRoots(workdir)` returns the single-root fallback (not throws) when `discoverWorkspacePackages` rejects
- `scanSourceRoots(workdir)` logs a warning with the error message when `discoverWorkspacePackages` rejects

### US-002: Wire `scanSourceRoots` into the plan command

- `buildSourceRootsSection(roots)` returns a string starting with `"## Source Roots"`
- `buildSourceRootsSection(roots)` returns a string containing one `"- <path>  (<language|unknown>, framework: <framework|—>, tests: <testRunner|—>)"` line per root
- `buildSourceRootsSection([])` returns a string containing `"- .  (unknown, framework: —, tests: —)"` so the section is never empty
- `PlanPromptBuilder.build()` produces a `taskContext` that does NOT contain the substring `"## Codebase Structure"`
- `PlanPromptBuilder.build()` produces a `taskContext` that DOES contain `"## Source Roots"`
- `PlanPromptBuilder.build()` produces a `taskContext` that does NOT contain the substring `"file names and structure only"`
- `PlanPromptBuilder.build()` produces a `taskContext` that DOES contain `"You have Read, Grep, and Glob tools"`
- `PlanPromptBuilder.build()` produces a `taskContext` that contains the substring `"≤ 10 file reads per story"`
- `PlanPromptBuilder.build()` produces a `taskContext` that does NOT contain `"## Dependencies"`
- `PlanPromptBuilder.build()` produces a `taskContext` that does NOT contain `"## Test Setup"`
- `PlanPromptBuilder.build()` with `proposers.fileReadAccess: true` produces a `taskContext` whose `buildFileReadInstruction` section contains `"File Read Permission:"`
- `runPlanCommand()` in `src/cli/plan.ts` invokes `_planDeps.scanSourceRoots(workdir)` and passes the rendered section as the `codebaseContext` argument to `PlanPromptBuilder.build()`
- `runPlanDecompose()` in `src/cli/plan-decompose.ts` invokes `_planDeps.scanSourceRoots(workdir)` and passes the rendered section into the decompose prompt context
- `_planDeps` in `src/cli/plan-runtime.ts` exposes `scanSourceRoots` and does not expose `scanCodebase`
- `grounderStrategy` in `src/debate/pre-phase/grounder.ts` continues to call `scanCodebase` (not `scanSourceRoots`) so the grounder facts-manifest path is unchanged

## Rollout

Single PR covering US-001 + US-002. No config flag — the change is a strict improvement (the agent gains tool access it already had; the worst case is one extra turn, which the existing `retry: { maxAttempts: 3 }` on `planInteractiveOp` already covers). If a regression surfaces, revert the wiring change in `plan.ts` and `plan-decompose.ts` — `scanCodebase` remains exported from `src/analyze/scanner.ts` and intact for the grounder, so revert is a 3-line operation.

## Follow-ups (not in this spec)

- Migrate `grounder.ts` from `scanCodebase` to `scanSourceRoots` once we measure whether the grounder's LLM call benefits from the tree or is fine with roots + tools.
- Replace `detectTestPatterns` in `scanner.ts` (currently uses `existsSync("test")`-style hardcoded patterns) with `resolveTestFilePatterns` per [ADR-009](../adr/ADR-009-test-file-pattern-ssot.md). Tracked separately.
- Remove the now-unused `proposers.fileReadAccess` parameter from `PlanPromptBuilder.build()` after debate-proposer paths are confirmed not to rely on it.
