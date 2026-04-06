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
| `setTimeout` / `setInterval` for delays | `Bun.sleep()` | Bun-native equivalent. **Exception:** `setTimeout` is permitted (not `setInterval`) when the timer handle must be cancelled mid-flight via `clearTimeout` (e.g. kill/drain races). Document this at the call-site. |
| Hardcoded timeouts in logic | Config values from schema | Hardcoded values can't be tuned per-environment |
| `import from "src/module/internal-file"` | `import from "src/module"` (barrel) | Prevents singleton fragmentation (BUG-035) |
| Files > 400 lines | Split by concern | Unmaintainable; violates project convention |

## Test Files

| ❌ Forbidden | ✅ Use Instead | Why |
|:---|:---|:---|
| Test files in `test/` root | `test/unit/`, `test/integration/`, etc. | Orphaned files with no clear ownership |
| Standalone bug-fix test files (`*-bug026.test.ts`) | Add to existing relevant test file | Fragments test coverage, creates ownership confusion |
| `TEST_COVERAGE_*.md` in test/ | `docs/` directory | Test dir is for test code only |
| `rm -rf` in test cleanup | `mkdtempSync` + OS temp dir | Accidental deletion risk |
| Tests depending on alphabetical file execution order | Independent, self-contained test files | Cross-file coupling causes phantom failures |
| Copy-pasted mock setup across files | `test/helpers/` shared factories | DRY; single place to update when interfaces change |
| Spawning full `nax` process in tests | Mock the relevant module | Prechecks fail in temp dirs; slow; flaky |
| Real signal sending (`process.kill`) | Mock `process.on()` | Can kill the test runner |
