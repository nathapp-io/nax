# SPEC: Language & Project-Type Awareness (QUALITY-002)

**Status:** Implemented
**Author:** Nax Dev
**Date:** 2026-03-25
**Priority:** High — currently nax is JS/TS-only downstream of context injection

## Problem

nax's context injector already detects 7+ languages (Node/Bun, Go, Rust, Python, PHP, Ruby, Java/Kotlin), but everything downstream is hardcoded to TypeScript/Bun:

- Command auto-detection falls back to `bun run <check>` only
- AC quality rules assume function-return assertion patterns
- Acceptance test generator produces JS test files (jest/vitest/bun:test)
- TDD test-writer creates `.test.ts` files
- Hermetic test guidance references JS mocking patterns
- Review runner only checks `package.json` for scripts

A Go developer running `nax init` gets TypeScript-shaped output. A React developer gets backend-shaped acceptance criteria.

## Goals

1. Auto-detect project language from manifest files (leverage existing `src/context/injector.ts`)
2. Auto-detect project type from dependencies and directory structure
3. Adapt AC quality rules, test commands, acceptance generation, and TDD patterns per language+type
4. Support monorepo packages with different languages/types
5. Allow explicit override via config (auto-detect is default)

## Non-Goals

- Runtime/toolchain installation (nax assumes tools are installed)
- Language-specific compilation/build orchestration
- IDE integration
- Supporting every language — start with Tier 1 (TS/JS, Go, Rust, Python), expand later

## Design

### 1. Project Profile

New top-level config section:

```typescript
interface ProjectProfile {
  /** Auto-detected or explicit project language */
  language?: "typescript" | "javascript" | "go" | "rust" | "python" | "ruby" | "java" | "kotlin" | "php";
  /** Auto-detected or explicit project type */
  type?: "library" | "cli" | "api" | "web" | "tui" | "mobile" | "monorepo";
  /** Auto-detected or explicit test framework */
  testFramework?: string;  // "bun:test" | "jest" | "vitest" | "go-test" | "cargo-test" | "pytest" | etc.
  /** Auto-detected or explicit lint tool */
  lintTool?: string;  // "biome" | "eslint" | "golangci-lint" | "clippy" | "ruff" | etc.
}
```

Added to `NaxConfig`:
```typescript
interface NaxConfig {
  // ... existing fields
  project?: ProjectProfile;
}
```

Per-package override in monorepo:
```json
// .nax/mono/packages/web/config.json
{
  "project": {
    "type": "web",
    "testFramework": "vitest"
  }
}
```

### 2. Auto-Detection (Phase 1)

Extend existing `src/context/injector.ts` detection into a new `src/project/detector.ts`:

| Signal | Language | Type |
|:-------|:---------|:-----|
| `package.json` | `typescript` (if `typescript` dep) or `javascript` | — |
| `go.mod` | `go` | — |
| `Cargo.toml` | `rust` | — |
| `pyproject.toml` / `requirements.txt` | `python` | — |
| `react` / `next` / `vue` / `nuxt` dep | — | `web` |
| `react-native` dep | — | `mobile` |
| `ink` / `blessed` / `tui-rs` dep | — | `tui` |
| `express` / `fastify` / `hono` / `gin` / `actix` | — | `api` |
| `bin` field in package.json / `[[bin]]` in Cargo.toml | — | `cli` |
| `workspaces` in package.json / `[workspace]` in Cargo.toml | — | `monorepo` |
| No framework deps, exports field | — | `library` |

Detection runs once at the start of `nax run` and `nax plan`. Result is cached in `RunContext` and passed through the pipeline.

### 3. Command Auto-Detection (Phase 2)

Replace the JS-only `resolveCommand()` fallback in `src/review/runner.ts`:

| Language | Test | Lint | Typecheck | Build |
|:---------|:-----|:-----|:----------|:------|
| **TypeScript** | `bun test` / `npm test` | `biome check` / `eslint` | `tsc --noEmit` | `bun run build` |
| **JavaScript** | `npm test` | `eslint` | — | `npm run build` |
| **Go** | `go test ./...` | `golangci-lint run` | `go vet ./...` | `go build ./...` |
| **Rust** | `cargo test` | `cargo clippy -- -D warnings` | — (compiler does it) | `cargo build` |
| **Python** | `pytest` | `ruff check .` | `mypy .` / `pyright` | — |
| **Ruby** | `bundle exec rspec` | `rubocop` | — | — |
| **Java** | `mvn test` / `gradle test` | `checkstyle` | — | `mvn compile` |

Resolution order (unchanged): explicit config → review.commands → quality.commands → **language-aware fallback** → skip.

The language-aware fallback replaces the current `bun run ${check}` fallback. It checks for the presence of the tool binary before returning the command.

### 4. AC Quality Rules Per Language+Type (Phase 3)

`AC_QUALITY_RULES` in `src/config/test-strategy.ts` becomes a function:

```typescript
function getAcQualityRules(profile: ProjectProfile): string
```

#### Language-Specific AC Patterns

**Go:**
```
- "[function] returns (value, error) where error is [specific error type] when [condition]"
- "When [action], [function] calls [interface method] with [args]"
- "[struct] implements [interface] — [method] returns [value] for [input]"
```

**Rust:**
```
- "[function] returns Result<[Ok type], [Err type]> where Err is [variant] when [condition]"
- "When [action], [struct].[method] emits [event/value] via [channel/callback]"
- "[trait] impl for [struct]: [method] returns [value] for [input]"
```

**Python:**
```
- "[function] returns [type] when [condition]"
- "When [action], [class].[method] raises [ExceptionType] with message containing '[text]'"
- "[class] instance created with [params] has [attribute] == [value]"
```

#### Type-Specific AC Patterns

**Web (React/Vue/Svelte):**
```
- "When user clicks [element], component renders [expected state]"
- "Given [prop/state], [Component] renders [element] with [content/attribute]"
- "When [async action] completes, loading indicator disappears and [data] is displayed"
- "[Component] with [prop]=[value] matches snapshot"
```

**TUI (Ink/tui-rs/bubbletea):**
```
- "When user presses [key], [component] transitions to [state]"
- "Given [input], rendered output contains [expected text] at [position/region]"
- "After [action], stdout contains [expected line]"
```

**Mobile (React Native):**
```
- "When user taps [element], navigation goes to [screen]"
- "Given [state], [Screen] renders [component] with accessibility label '[label]'"
- "When [gesture], animation [property] reaches [value]"
```

**CLI:**
```
- "When invoked with [args], exit code is [0/1] and stdout contains '[text]'"
- "Given [env/config], [command] writes [output] to [stdout/stderr/file]"
- "When [flag] is set, [command] skips [step] and outputs [message]"
```

**API:**
```
- "POST /[endpoint] with [body] returns [status code] and response body contains [field]=[value]"
- "When [header] is missing, endpoint returns 401 with error '[message]'"
- "GET /[endpoint]?[query] returns paginated response with [count] items"
```

### 5. Acceptance Test Generation Per Language (Phase 3)

Extend `src/acceptance/generator.ts` to generate language-appropriate test files:

| Language | Test file | Import pattern | Assert pattern |
|:---------|:----------|:---------------|:---------------|
| **TypeScript** | `acceptance.test.ts` | `import { describe, test, expect } from "bun:test"` | `expect(x).toBe(y)` |
| **Go** | `acceptance_test.go` | `import "testing"` | `if got != want { t.Errorf(...) }` |
| **Rust** | `tests/acceptance.rs` | `#[cfg(test)] mod tests { use super::*; }` | `assert_eq!(got, want)` |
| **Python** | `test_acceptance.py` | `import pytest` | `assert x == y` |

### 6. TDD File Convention Per Language (Phase 3)

`src/tdd/test-writer.ts` adapts file naming and structure:

| Language | Source → Test mapping |
|:---------|:---------------------|
| **TypeScript** | `src/foo.ts` → `test/unit/foo.test.ts` |
| **Go** | `pkg/foo/bar.go` → `pkg/foo/bar_test.go` (same dir) |
| **Rust** | `src/foo.rs` → inline `#[cfg(test)]` or `tests/foo.rs` |
| **Python** | `src/foo.py` → `tests/test_foo.py` |

### 7. Hermetic Test Guidance Per Language (Phase 3)

Extend `quality.testing.mockGuidance` auto-generation:

| Language | Default guidance |
|:---------|:----------------|
| **TypeScript** | "Use injectable `_deps` pattern for external calls. Mock with `bun:test` mock.module()" |
| **Go** | "Define interfaces for external dependencies. Use constructor injection. Test with interface mocks." |
| **Rust** | "Use trait objects or generics for external deps. Mock with `mockall` crate. Use `#[cfg(test)]` modules." |
| **Python** | "Use dependency injection or `unittest.mock.patch`. Mock external calls with `pytest-mock` fixtures." |

### 8. Merge Integration

Add `project` to `mergePackageConfig()` as a mergeable section:

```typescript
project: {
  ...root.project,
  ...packageOverride.project,
},
```

This lets monorepo packages declare different languages/types:
```
.nax/
  config.json          → { "project": { "language": "typescript" } }
  mono/
    packages/api/
      config.json      → { "project": { "type": "api" } }
    packages/web/
      config.json      → { "project": { "type": "web", "testFramework": "vitest" } }
    packages/cli-go/
      config.json      → { "project": { "language": "go", "type": "cli" } }
```

## Implementation Plan

### Phase 1: Detection & Config (3 stories)

**US-001: ProjectProfile type and config**
- Add `ProjectProfile` interface to `runtime-types.ts`
- Add `project?: ProjectProfile` to `NaxConfig`
- Add schema validation, defaults (all undefined = auto-detect), merge support
- Add config-descriptions entries

**US-002: Language auto-detection**
- Create `src/project/detector.ts` with `detectProjectProfile(workdir)`
- Reuse manifest detection from `src/context/injector.ts` (extract shared helpers)
- Return `ProjectProfile` with detected language, type, testFramework, lintTool
- Wire into `nax run` and `nax plan` — detect once, store in `RunContext`

**US-003: Explicit config overrides auto-detection**
- When `project.language` is set in config, skip detection for that field
- When `project.type` is set, skip type detection
- Log detected profile at start of run: `"Detected: typescript/web (vitest, biome)"`

### Phase 2: Command Resolution (2 stories)

**US-004: Language-aware command fallback**
- Replace `bun run ${check}` fallback in `resolveCommand()` with language-aware table
- Check tool binary exists before returning command (e.g., `which golangci-lint`)
- Fall through to null (skip) if tool not found

**US-005: Precheck language validation**
- Precheck warns if detected language tools are missing (e.g., "Go project detected but `golangci-lint` not found")
- Suggests install commands

### Phase 3: Quality Adaptation (4 stories)

**US-006: Language+type-aware AC quality rules**
- Convert `AC_QUALITY_RULES` constant → `getAcQualityRules(profile)` function
- Add per-language and per-type AC pattern examples
- Wire into plan prompt builder

**US-007: Language-aware acceptance test generation**
- Extend `src/acceptance/generator.ts` to produce Go/Rust/Python test files
- Use detected `testFramework` for import/assert patterns
- Respect file naming conventions per language

**US-008: Language-aware TDD patterns**
- Extend TDD test-writer to use language-appropriate file paths and test structure
- Go: same-directory `_test.go`; Rust: inline `#[cfg(test)]` or `tests/`; Python: `tests/test_*.py`

**US-009: Language-aware hermetic test guidance**
- Auto-generate `quality.testing.mockGuidance` per detected language if not explicitly configured
- Include language-idiomatic mocking patterns

## Migration

- **No breaking changes** — `project` field is optional, everything defaults to current behavior
- Auto-detection is purely additive — existing TS/Bun projects work identically
- Projects that already set explicit `quality.commands` are unaffected by command fallback changes

## Cost Estimate

- Phase 1: ~$5-7 (3 stories, config + detection)
- Phase 2: ~$3-5 (2 stories, command resolution)
- Phase 3: ~$8-12 (4 stories, quality adaptation with language templates)
- **Total: ~$16-24** across 9 stories (suggest splitting into 2-3 nax runs)

## Decisions

1. **`nax init` detects language** — uses the same `detectProjectProfile()` from `src/project/detector.ts` (SSOT). Pre-populates `project.language`, `project.type`, and `quality.commands` in the generated config.
2. **Monorepo root has no language** — root config sets `project.type: "monorepo"` only. Individual packages declare their own language/type via `.nax/mono/<pkg>/config.json`.
3. **Polyglot = per-package** — one language per package, enforced by schema. If a directory has both Go and TypeScript, split into monorepo packages.
4. **Unsupported languages = explicit commands** — no `"custom"` language enum. Leave `project.language` unset and configure `quality.commands` manually. Promote to first-class when demand warrants (Zig, Elixir, Scala, etc.).
