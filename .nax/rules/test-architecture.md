---
priority: 30
appliesTo:
  - "test/**/*.test.ts"
stages:
  - "context"
  - "execution"
  - "tdd-test-writer"
  - "tdd-implementer"
  - "tdd-verifier"
  - "rectify"
  - "review"
  - "review-semantic"
  - "review-adversarial"
  - "autofix"
  - "single-session"
  - "tdd-simple"
  - "no-test"
  - "batch"
  - "review-dialogue"
  - "debate"
  - "queue-check"
  - "routing"
  - "constitution"
  - "prompt"
  - "optimizer"
  - "completion"
  - "acceptance-setup"
  - "regression"
  - "decompose"
---
# Test Architecture

## Directory Structure

Tests **must** mirror the `src/` directory structure:

```
src/routing/strategies/foo.ts    → test/unit/routing/strategies/foo.test.ts
src/execution/runner.ts          → test/unit/execution/runner.test.ts
src/pipeline/stages/verify.ts   → test/unit/pipeline/stages/verify.test.ts
src/verification/smart-runner.ts → test/unit/verification/smart-runner.test.ts
```

## Test Categories

| Category | Location | Purpose |
|:---|:---|:---|
| Unit | `test/unit/<mirror-of-src>/` | Test individual functions/classes in isolation |
| Integration | `test/integration/<feature>.test.ts` | Test multiple modules working together |
| UI | `test/ui/` | TUI component tests |
| E2E | `test/e2e/*.e2e.test.ts` | Independent end-to-end suite. **Excluded from `bun run test`** — run via `bun run test:e2e`. For full-flow orchestration tests with scripted agents. |

## Placement Rules

1. **Never create test files in `test/` root.** Always place in the appropriate subdirectory.
2. **Never create standalone bug-fix test files** like `test/execution/post-verify-bug026.test.ts`. Add tests to the existing relevant test file instead. If the relevant file would exceed 400 lines, split the file by describe block — not by bug number.
3. **Never create `TEST_COVERAGE_*.md` or documentation files in `test/`.** Put docs in `docs/`.
4. **Unit test directories must exist under `test/unit/`**, mirroring `src/`. Do not create top-level test directories like `test/execution/` or `test/context/` — use `test/unit/execution/` and `test/unit/context/`.

## File Naming

- Test files: `<source-file-name>.test.ts` — must match the source file name exactly.
- One test file per source file (for unit tests).
- If a test file needs splitting, split by describe block into `<module>-<concern>.test.ts`.

## Temp Files & Fixtures

- Follow `docs/guides/testing-rules.md` for temp-directory behavior.
- Use `makeTempDir()` + `cleanupTempDir()` from `test/helpers/temp.ts` for `beforeEach`/`afterEach` lifecycle management.
- Use `withTempDir()` from `test/helpers/temp.ts` for single-test inline setup with auto-cleanup.
- Do not call `mkdtempSync(join(tmpdir(), "nax-test-"))` directly from test files.
- Integration tests needing git: always `git init` + `git add .` + `git commit` in the temp fixture before testing.

## Process/Spawn Mocking Architecture

Source modules that call `Bun.spawn`, `Bun.sleep`, or `process.kill` export an injectable `_deps` object so tests can mock at the module level without touching globals. This prevents cross-file contamination (see `docs/architecture/conventions.md` §2 for the full `_deps` reference table).

**Pattern (in source file):**
```typescript
export const _myDeps = { spawn: Bun.spawn as typeof Bun.spawn };

export async function myFunc() {
  const proc = _myDeps.spawn(["git", "diff"], { ... });
  ...
}
```

**Pattern (in test file):**
```typescript
import { _myDeps } from "../../../src/my-module";

let origSpawn: typeof _myDeps.spawn;
beforeEach(() => { origSpawn = _myDeps.spawn; _myDeps.spawn = mock(...); });
afterEach(() => { _myDeps.spawn = origSpawn; });
```

Shared TDD orchestrator tests use `test/integration/tdd/_tdd-test-helpers.ts` which wraps `saveDeps()`, `restoreDeps()`, and `mockGitSpawn()` for convenience.

## Importing the code under test

A test may value-import a `src/` internal directly through the `@/` alias, even
when that directory has a barrel that does not re-export it:

```typescript
import { applyConfigCompatShims } from "@/config/compat-shims";
```

This is deliberate (GitHub #1647). Before it, a test of any non-barrelled
internal was unwritable: the then-active `check:deep-relatives` ratchet rejected
the `../../../src/...` form and `check:alias-internals` rejected the `@/...`
form, so the two gates were jointly unsatisfiable. That ratchet has since been
retired. Prefer the barrel (`@/config`) when the symbol is
exported from it; reach for the internal path only when it is not.

`@test/<dir>/<internal>` remains forbidden — shared helpers and fixtures are a
real public API for tests, so import them from their barrel (`@test/helpers`).

See `project-conventions.md` for the full path-alias rules and
the import-cycle ratchet.
