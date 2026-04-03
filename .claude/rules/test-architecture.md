---
paths:
  - "test/**/*.test.ts"
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

- Use `mkdtempSync(join(tmpdir(), "nax-test-"))` for temporary directories.
- Clean up in `afterAll()` — never leave files in `test/tmp/`.
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
