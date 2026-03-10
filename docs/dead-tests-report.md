# Dead Tests Report

Generated: 2026-03-10T09:57:51.495Z

Found **12** test file(s) with issues:

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