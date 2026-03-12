# Dead Tests Report

Generated: 2026-03-12T09:27:58.825Z

Found **7** test file(s) with issues:

## test/unit/worktree-manager.test.ts

### Dead Feature References

- **worktree** — references removed feature

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

---

## Summary

- Total files with issues: 7
- Dead imports: 6
- Dead references: 5