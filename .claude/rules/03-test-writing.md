---
paths:
  - "test/**/*.test.ts"
---

# Test Writing Rules

**Full rules:** `docs/guides/testing-rules.md` — read that first.

This file contains the nax-specific injectable deps table that Claude Code needs when mocking subprocesses.

## Injectable `_deps` Available in nax Source

Use these instead of mutating `Bun.spawn` globally (see testing-rules.md §2):

| Module | Deps export | Covers |
|:---|:---|:---|
| `src/tdd/isolation.ts` | `_isolationDeps.spawn` | `git diff` in `getChangedFiles` |
| `src/tdd/cleanup.ts` | `_cleanupDeps.spawn/sleep/kill` | `ps`, `Bun.sleep`, `process.kill` in `cleanupProcessTree` |
| `src/tdd/session-runner.ts` | `_sessionRunnerDeps.spawn/getChangedFiles/verifyTestWriterIsolation/verifyImplementerIsolation/captureGitRef/cleanupProcessTree/buildPrompt` | All session runner dependencies |
| `src/tdd/rectification-gate.ts` | `_rectificationGateDeps.executeWithTimeout/parseBunTestOutput/shouldRetryRectification` | Gate logic |
| `src/utils/git.ts` | `_gitDeps.spawn` | All git commands |
| `src/verification/executor.ts` | `_executorDeps.spawn` | Shell test command execution |
| `src/verification/strategies/acceptance.ts` | `_acceptanceDeps.spawn` | Acceptance test runner |

For orchestrator/multi-module tests, use the shared helper:
```typescript
import { saveDeps, restoreDeps, mockGitSpawn, mockAllSpawn } from "./_tdd-test-helpers";
```
