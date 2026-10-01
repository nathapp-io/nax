# Dead Code Analysis Report

Generated: 2026-05-21 | Total tests: 10,168 (8,909 unit + 1,238 integration)

---

## Summary

| Category | Count | Action |
|:---|:---|:---|
| Dead src/ files | 1 | DELETE |
| Deprecated shims (active callers) | 2 | MIGRATE callers, then delete shim |
| Broken test imports | 1 | FIX import path |
| Dead-checker false positives | 16/22 | FIX REMOVED_FEATURES list |
| Deprecated routing functions in use | 1 (routeTask) | NOT dead — still actively used |

---

## SAFE TO DELETE (no callers)

### `src/worktree/dispatcher.ts` — 6 lines
- Exports only `DispatchResult` interface
- **Zero imports** anywhere in `src/` or `test/`
- Leftover stub from a migration — `DispatchResult` was never wired up
- **Action:** Delete file

---

## DEPRECATED SHIMS (callers must migrate first)

### `src/verification/parser.ts`
- Documented as `@deprecated — Import from "src/test-runners" instead`
- Still re-exported via `src/verification/index.ts`
- **Active callers (need updating before deletion):**
  - `test/unit/utils/test-output-parser.test.ts:2` — imports `parseTestOutput`, `formatFailureSummary`, `TestFailure`
  - `test/unit/execution/rectification.test.ts:10` — imports `type TestFailure`
- **Replacement:** `src/test-runners` (all symbols re-exported from there)
- **Action:** Update 2 test imports → then delete shim

### `src/config/validate.ts`
- Documented as `@deprecated — Use NaxConfigSchema.safeParse() instead`
- Re-exported via `src/config/index.ts` with deprecation comment
- **Active callers:**
  - `test/unit/config/validate.test.ts` — full suite testing `validateConfig()`
  - `src/config/index.ts` — still re-exports it for backward compat
- **Note:** `validateConfig()` has specific agent-key validation logic not in `safeParse()`. Low priority.
- **Action:** Keep for now — function has distinct behavior

---

## BROKEN TEST IMPORTS (type-only, TypeScript erases at runtime but path is wrong)

### `test/unit/prompts/loader.test.ts:15`
```ts
import type { PromptRole } from "../../../src/prompts/types";
//                                                    ^^^^^^ doesn't exist
```
- `src/prompts/types.ts` does not exist
- Correct path: `src/prompts/core/types` (or `src/prompts` barrel which re-exports `PromptRole`)
- **Action:** Fix import to `from "../../../src/prompts/core/types"`

---

## FALSE POSITIVES IN `scripts/check-dead-tests.ts`

The `REMOVED_FEATURES` constant incorrectly lists active features, causing 16 false positive flags:

```ts
const REMOVED_FEATURES = [
  "worktree",    // ← ACTIVE: src/worktree/ is used by parallel execution
  "dispatcher",  // ← ACTIVE: DispatchEventBus in src/runtime/dispatch-events.ts
  ...
];
```

### Falsely flagged "worktree" tests (12 files) — DO NOT DELETE
These tests have valid imports from `src/worktree/` which still exists:
- `test/integration/worktree/worktree-merge.test.ts`
- `test/integration/worktree/manager.test.ts`
- `test/integration/execution/parallel-batch-executor.test.ts`
- `test/unit/config/worktree-dependencies-schema.test.ts`
- `test/unit/prd/prd-reset-failed.test.ts`
- `test/unit/worktree/dependencies.test.ts`
- `test/unit/execution/pipeline-result-handler.test.ts`
- `test/unit/execution/lifecycle/paused-story-prompts.test.ts`
- `test/unit/execution/lifecycle/run-initialization.test.ts`
- `test/unit/execution/parallel-batch.test.ts`
- `test/unit/execution/worktree-manager.test.ts`
- `test/unit/execution/iteration-runner-worktree.test.ts`

### Falsely flagged "dispatcher" tests (4 files) — DO NOT DELETE
These tests import from still-active `src/runtime/dispatch-events`:
- `test/unit/debate/selectors/pick.test.ts`
- `test/unit/agents/manager-dispatch-emission.test.ts`
- `test/unit/runtime/dispatch-events.test.ts`
- `test/unit/scripts/check-dead-tests.test.ts`

### Tests with fixture import strings (NOT actual dead imports) — DO NOT DELETE
The dead-tests checker misidentifies string literals inside test content as real imports:
- `test/unit/acceptance/fix-diagnosis.test.ts` — `src/math.ts` etc. are strings passed to `loadSourceFilesForDiagnosis()`
- `test/unit/scripts/check-dead-tests.test.ts` — fixture imports for testing the checker itself
- `test/unit/scripts/check-test-overlap.test.ts` — fixture imports
- `test/unit/prompts/sections/acceptance.test.ts` — `src/foo` is a fixture string
- `test/unit/verification/smart-runner.test.ts` — `src/auth/service` is a fixture string
- `test/unit/verification/smart-runner-discovery.test.ts` — multiple fixture strings

---

## NOT DEAD (confirmed active)

| Item | Status |
|:---|:---|
| `src/worktree/` (entire module except `dispatcher.ts`) | Active — used by `parallel-batch.ts`, `pipeline-result-handler.ts` |
| `routeTask` in `src/routing/router.ts` | Active — used by `parallel-worker.ts`, `merge-conflict-rectify.ts` |
| `src/config/validate.ts` | Active caller (test suite + distinct logic) |
| `src/verification/parser.ts` | Still has callers — shim keeps working |

---

## EXECUTION PLAN

### Batch 1 — Zero-risk (delete dead file, fix checker script)
1. Delete `src/worktree/dispatcher.ts`
2. Remove "worktree" and "dispatcher" from `REMOVED_FEATURES` in `scripts/check-dead-tests.ts`
3. Run test suite to verify

### Batch 2 — Fix broken import
4. Fix `test/unit/prompts/loader.test.ts` import path
5. Run targeted test to verify

### Batch 3 — Migrate deprecated verification shim
6. Update `test/unit/utils/test-output-parser.test.ts` → import from `src/test-runners`
7. Update `test/unit/execution/rectification.test.ts` → import from `src/test-runners`
8. Delete `src/verification/parser.ts`
9. Run test suite to verify
