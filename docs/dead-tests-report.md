# Dead Tests Report

Generated: 2026-03-10T10:49:48.119Z

## REMOVED

The following test file was deleted during TH-004 cleanup due to redundancy:

- ~~test/unit/verdict.test.ts~~ — REMOVED (24 tests for `src/tdd/verdict` covered by test/unit/tdd-verdict.test.ts which has 40 comprehensive tests for the same module including all critical coercion paths)

## Scanner False Positive Notice

**All 12 entries below are false positives.** The scanner checks for `.js` files on disk, but this project uses `.ts` source files. Bun resolves `.js` imports to `.ts` at runtime, so all "missing" modules actually exist. "Dead feature" references (`worktree`, `dispatcher`) appear only in test data string literals, not real imports. The `src/worktree/` module still exists and is actively used.

Found **12** test file(s) with issues (all false positives — see notice above):

## test/unit/optimizer/rule-based.optimizer.test.ts

### Missing Imports

- `src/config/schema.js` — module not found
- `src/optimizer/rule-based.optimizer.js` — module not found
- `src/optimizer/types.js` — module not found

**Recommendation:** Review this test file. 
Either fix the imports/references, update the test, or delete it if no longer needed.

## test/unit/optimizer/noop.optimizer.test.ts

### Missing Imports

- `src/config/schema.js` — module not found
- `src/optimizer/types.js` — module not found
- `src/optimizer/noop.optimizer.js` — module not found

**Recommendation:** Review this test file. 
Either fix the imports/references, update the test, or delete it if no longer needed.

## test/unit/worktree-manager.test.ts

### Dead Feature References

- **worktree** — references removed feature

**Recommendation:** Review this test file. 
Either fix the imports/references, update the test, or delete it if no longer needed.

## test/unit/formatters.test.ts

### Missing Imports

- `src/logger/formatters.js` — module not found
- `src/logger/types.js` — module not found

**Recommendation:** Review this test file. 
Either fix the imports/references, update the test, or delete it if no longer needed.

## test/unit/verification/smart-runner-discovery.test.ts

### Missing Imports

- `src/other/module` — module not found
- `src/utils/helper` — module not found
- `src/completely/different` — module not found

**Recommendation:** Review this test file. 
Either fix the imports/references, update the test, or delete it if no longer needed.

## test/unit/scripts/check-dead-tests.test.ts

### Missing Imports

- `src/config/missing` — module not found

### Dead Feature References

- **dispatcher** — references removed feature

**Recommendation:** Review this test file. 
Either fix the imports/references, update the test, or delete it if no longer needed.

## test/unit/scripts/check-test-overlap.test.ts

### Missing Imports

- `src/mymodule` — module not found
- `src/other` — module not found

**Recommendation:** Review this test file. 
Either fix the imports/references, update the test, or delete it if no longer needed.

## test/unit/logging/formatter.test.ts

### Missing Imports

- `src/logger/types.js` — module not found
- `src/logging/types.js` — module not found

**Recommendation:** Review this test file. 
Either fix the imports/references, update the test, or delete it if no longer needed.

## test/integration/worktree/worktree-merge.test.ts

### Dead Feature References

- **worktree** — references removed feature

**Recommendation:** Review this test file. 
Either fix the imports/references, update the test, or delete it if no longer needed.

## test/integration/worktree/manager.test.ts

### Dead Feature References

- **worktree** — references removed feature

**Recommendation:** Review this test file. 
Either fix the imports/references, update the test, or delete it if no longer needed.

## test/integration/execution/parallel.test.ts

### Dead Feature References

- **worktree** — references removed feature

**Recommendation:** Review this test file. 
Either fix the imports/references, update the test, or delete it if no longer needed.

## test/e2e/plan-analyze-run.test.ts

### Missing Imports

- `src/index` — module not found

**Recommendation:** Review this test file. 
Either fix the imports/references, update the test, or delete it if no longer needed.

---

## Summary

- Total files with issues: 12
- Dead imports: 17
- Dead references: 5