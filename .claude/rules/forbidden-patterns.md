# Forbidden Patterns

> Quick lookup table. For root-cause rationale and security context, see `docs/architecture/conventions.md` §2 and `docs/architecture/design-patterns.md` §12.

These patterns are **banned** from the nax codebase. Violations must be caught during implementation, not after.

## Source Code

| ❌ Forbidden | ✅ Use Instead | Why |
|:---|:---|:---|
| `mock.module()` | Dependency injection (`_deps` pattern) | Leaks globally in Bun 1.x, poisons other test files |
| `console.log` / `console.error` in src/ | Project logger (`src/logger`) | Unstructured output breaks test capture and log parsing |
| `fs.readFileSync` / `fs.writeFileSync` | `Bun.file()` / `Bun.write()` | Bun-native project — no Node.js file APIs |
| `child_process.spawn` / `child_process.exec` | `Bun.spawn()` / `Bun.spawnSync()` | Bun-native project — no Node.js process APIs |
| `setTimeout` / `setInterval` for delays | `Bun.sleep()` | Bun-native equivalent for `src/` code. **Exception:** `setTimeout` is permitted (not `setInterval`) when the timer handle must be cancelled mid-flight via `clearTimeout` (e.g. kill/drain races). Document this at the call-site. Tests follow `docs/guides/testing-rules.md` and must not use `Bun.sleep()`. |
| Hardcoded timeouts in logic | Config values from schema | Hardcoded values can't be tuned per-environment |
| `import from "src/module/internal-file"` | `import from "src/module"` (barrel) | Prevents singleton fragmentation (BUG-035) |
| Test files > 800 lines | Split by concern | Violates the hard limit in `docs/guides/testing-rules.md` / `docs/guides/testing-conventions.md` |
| Prompt-building functions outside `src/prompts/builders/` | Add a method to the appropriate builder class | Orphan prompts scatter LLM instruction logic across subsystems, making them impossible to audit, test, or optimise centrally (see Prompt Builder Convention below) |
| Inline test-file classification outside `src/test-runners/` | `resolveTestFilePatterns(config, workdir, packageDir)` SSOT | ADR-009 — nax is language-agnostic and monorepo-aware. Hardcoded `test/unit/`, `.test.ts`, `_test.go`, `\.spec\.` regexes fragment the truth and break under polyglot monorepos (see Test-File Classification Convention below) |

## Prompt Builder Convention

**All LLM prompt-building logic lives in `src/prompts/builders/` — no exceptions.**

An "orphan prompt" is any function or template string outside `src/prompts/builders/` that:
- Returns a multi-line string sent to an LLM agent
- Contains `You are`, `## Instructions`, `Fix `, `Your task`, `IMPORTANT:`, or similar instructional text
- Is named `build*Prompt`, `create*Prompt`, `make*Prompt`, or similar

### ❌ Wrong — prompt assembled in a pipeline stage

```typescript
// src/pipeline/stages/autofix.ts
function buildFixPrompt(checks: ReviewCheckResult[]): string {
  return `You are fixing lint errors.\n\n${checks.map(...).join("\n")}`;
}
```

### ✅ Correct — static method on the relevant builder

```typescript
// src/prompts/builders/rectifier-builder.ts
export class RectifierPromptBuilder {
  static continuation(checks: ReviewCheckResult[], ...): string {
    // prompt assembly lives here
  }
}
```

### Builder registry

| Builder class | Handles |
|:---|:---|
| `RectifierPromptBuilder` | All rectification prompts: TDD failures, verify failures, review findings, autofix retries |
| `ReviewPromptBuilder` | Semantic and adversarial review prompts |
| `TddPromptBuilder` | TDD session prompts (test-writer, implementer, verifier) |
| `AcceptancePromptBuilder` | Acceptance test generation, diagnosis, refinement, fix execution |
| `DebatePromptBuilder` | Multi-agent debate and review-dialogue prompts |
| `OneShotPromptBuilder` | Single-turn utility prompts (router, decomposer, auto-approver) |

If no existing builder fits, create `src/prompts/builders/<domain>-builder.ts` and export from `src/prompts/index.ts`.

### Wrapper functions are also banned

Thin wrappers that do nothing but delegate to a builder add indirection without value:

```typescript
// ❌ Wrong — pointless wrapper in src/acceptance/fix-executor.ts
function buildSourceFixPrompt(...): string {
  return new AcceptancePromptBuilder().buildSourceFixPrompt(...);
}

// ✅ Correct — call the builder directly at the use site
const prompt = new AcceptancePromptBuilder().buildSourceFixPrompt(...);
```

## Test Files

| ❌ Forbidden | ✅ Use Instead | Why |
|:---|:---|:---|
| Test files in `test/` root | `test/unit/`, `test/integration/`, etc. | Orphaned files with no clear ownership |
| Standalone bug-fix test files (`*-bug026.test.ts`) | Add to existing relevant test file | Fragments test coverage, creates ownership confusion |
| `TEST_COVERAGE_*.md` in test/ | `docs/` directory | Test dir is for test code only |
| `rm -rf` in test cleanup | `test/helpers/temp.ts` helpers (`makeTempDir()` / `cleanupTempDir()` / `withTempDir()`) | Accidental deletion risk; temp-dir handling is centralized and portable |
| Tests depending on alphabetical file execution order | Independent, self-contained test files | Cross-file coupling causes phantom failures |
| Copy-pasted mock setup across files | `test/helpers/` shared factories | DRY; single place to update when interfaces change |
| Spawning full `nax` process in tests | Mock the relevant module | Prechecks fail in temp dirs; slow; flaky |
| Real signal sending (`process.kill`) | Mock `process.on()` | Can kill the test runner |

## Test-File Classification Convention

**All "is this a test file?" / "where is the sibling test?" logic goes through `resolveTestFilePatterns(config, workdir, packageDir)` — no exceptions.**

nax orchestrates polyglot monorepos. Hardcoding TS-centric patterns anywhere outside `src/test-runners/` will silently break Go / Python / Rust / polyglot repos and stale out when users configure custom `testFilePatterns`. Enforced by ADR-009.

### ❌ Wrong — inline regex in a provider / pipeline stage / review module

```typescript
// src/context/engine/providers/code-neighbor.ts
function siblingTestPath(filePath: string): string | null {
  const m = filePath.match(/^src\/(.+)\.(ts|tsx|js|jsx)$/);
  // ...
  return `test/unit/${m[1]}.test.${m[2]}`;
}

// src/review/diff-utils.ts
const isTest = /\.test\.ts$/.test(path);

// src/pipeline/stages/foo.ts
if (path.endsWith(".spec.ts")) { ... }
```

Banned patterns to grep for when reviewing PRs:
- Hardcoded directory names: `test/unit/`, `test/integration/`, `__tests__/`
- Hardcoded extensions: `.test.ts`, `.spec.ts`, `_test.go`, `_test.py`
- Inline regex: `/\.test\.ts$/`, `/\.(test|spec)\.(tsx?|jsx?)$/`

### ✅ Correct — consult the resolver SSOT

```typescript
import { resolveTestFilePatterns } from "../../test-runners/resolver";

const resolved = await resolveTestFilePatterns(config, workdir, story.workdir);

// Classification — use .regex
const isTest = resolved.regex.some((re) => re.test(filePath));

// Diff exclusion — use .pathspec
const args = ["git", "diff", ...resolved.pathspec];

// Directory listing — use .testDirs + .globs
for (const glob of resolved.globs) { /* ... */ }
```

### Threading into providers

`ContextRequest` carries `resolvedTestPatterns?: ResolvedTestPatterns`. Providers that need sibling-test derivation MUST read it from the request — never re-derive from `filePath` alone.

### Scope

Applies to `src/context/`, `src/pipeline/`, `src/review/`, `src/tdd/`, `src/verification/`, `src/acceptance/`, `src/plugins/`, `src/analyze/`. The only module permitted to hold raw patterns is `src/test-runners/`.
