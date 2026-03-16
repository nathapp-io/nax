# ENH-001: Standardize test output logging — single source of truth

**Type:** Enhancement
**Component:** `src/utils/log-test-output.ts` (new), `verify.ts`, `acceptance.ts`, `regression.ts`
**Filed:** 2026-03-16
**Status:** Implemented in `feat/log-test-output-ssot`

## Problem

Test output is logged inconsistently across pipeline stages:

| Stage | Error log | Output included? | Level |
|:------|:----------|:-----------------|:------|
| `verify.ts` | `"Tests failed"` — no output | Last 20 lines | `debug` |
| `acceptance.ts` — crash | `"Tests errored..."` | **Full output** | `error` ❌ |
| `acceptance.ts` — failure | `"Acceptance tests failed"` | **Full output** | `error` ❌ |
| `regression.ts` | `"Full-suite regression detected"` | **None** | `warn` ❌ |

The acceptance stage bakes the full test output (can be 100KB+) into the `error` log entry.
The regression stage logs nothing about the failing tests.
Neither matches the `verify.ts` pattern which is the most debuggable.

## Solution

Single utility function `logTestOutput()` in `src/utils/log-test-output.ts`:
- Summary (exitCode, storyId) at the existing `error`/`warn` level — no raw output
- Last N lines at `debug` level — only when debug is enabled
- `storyId` is optional — works for deferred acceptance/regression (no per-story context)

## Implementation

### `src/utils/log-test-output.ts` (new)

```typescript
import type { Logger } from "../logger";

/**
 * Log test output consistently across all pipeline stages.
 * Summary at caller's level; tail preview at debug level.
 * storyId is optional — works for deferred runs without story context.
 */
export function logTestOutput(
  logger: Logger | null | undefined,
  stage: string,
  output: string | undefined,
  opts: { storyId?: string; tailLines?: number } = {},
): void {
  if (!logger || !output) return;
  const tailLines = opts.tailLines ?? 20;
  const lines = output.split("\n").slice(-tailLines).join("\n");
  logger.debug(stage, "Test output (tail)", {
    ...(opts.storyId !== undefined && { storyId: opts.storyId }),
    output: lines,
  });
}
```

### `acceptance.ts` — remove `output` from both error log calls, add `logTestOutput()`

### `regression.ts` — add `logTestOutput()` after the warn log

### `verify.ts` — replace inline tail logic with `logTestOutput()`
