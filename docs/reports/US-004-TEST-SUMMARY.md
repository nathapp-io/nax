# US-004: Reporter plugins receive lifecycle events — Test Summary

**Status:** ✅ PASSED
**Date:** 2026-02-27
**Commit:** 26181a1

## Overview

This story implements reporter lifecycle events that fire at appropriate points in the runner loop. All reporter calls are fire-and-forget (errors logged, never block pipeline).

## Implementation Summary

### Changes Made

1. **Moved PRD initialization** (runner.ts:205)
   - Moved `prd` declaration before try block to make it accessible in finally block
   - Ensures `prd` is available for onRunEnd event even on failure/abort

2. **Consolidated onRunEnd calls** (runner.ts:1417-1439)
   - Moved onRunEnd reporter events to finally block
   - Removed duplicate calls from success paths (parallel and sequential)
   - Guarantees onRunEnd fires even when run fails or is aborted

3. **Added dry-run onStoryComplete events** (runner.ts:666-684)
   - Added missing onStoryComplete events for dry-run mode
   - Ensures reporters receive events consistently across all execution modes

### Key Design Decisions

- **Finally block placement**: onRunEnd must fire even on exceptions, so it's placed in the finally block before teardown and lock release
- **Error isolation**: Each reporter call is wrapped in try/catch to prevent one reporter's failure from affecting others
- **Event ordering**: onRunEnd fires before plugin teardown to ensure reporters can still access plugin state

## Test Results

All 9 tests in `test/integration/reporter-lifecycle.test.ts` pass:

### AC1: onRunStart fires once at run start ✅
- Verified event contains: runId, feature, totalStories, startTime
- Verified event fires exactly once per run

### AC2: onStoryComplete fires after each story ✅
- Verified event contains: runId, storyId, status, durationMs, cost, tier, testStrategy
- Verified event fires for each story execution (including dry-run)
- Verified correct status values (completed, failed, skipped, paused)

### AC3: onRunEnd fires once at run end ✅
- Verified event contains: runId, totalDurationMs, totalCost, storySummary
- Verified storySummary contains: completed, failed, skipped, paused counts
- Verified correct counts match PRD state

### AC4: Reporter errors never block execution ✅
- Verified failing reporter doesn't abort run
- Verified run completes successfully despite reporter errors
- Verified errors are logged (not thrown)

### AC5: Multiple reporters all receive events ✅
- Verified two reporters both receive onRunStart, onStoryComplete, onRunEnd
- Verified second reporter receives events even if first reporter fails
- Verified no short-circuiting on error (all reporters always execute)

### AC6: Events fire even when run fails or is aborted ✅
- Verified onRunStart and onRunEnd fire when stories are pre-failed
- Verified onRunEnd fires in finally block (even on exception)
- Verified storySummary reflects actual failure state

## Additional Test Coverage

- **onStoryComplete for different outcomes**: Verified events for completed, failed, skipped, paused stories
- **Multiple stories**: Verified consistent runId across all events in same run
- **Dry-run mode**: Verified reporters receive events in dry-run mode

## Verification Command

```bash
bun test test/integration/reporter-lifecycle.test.ts
```

**Result:** 9 pass, 0 fail, 48 expect() calls

## Integration with Existing Code

- **US-001 (Plugin loading)**: Uses pluginRegistry.getReporters() to retrieve all loaded reporters
- **US-002 (Context provider injection)**: No conflicts, reporters operate independently
- **US-003 (Review plugins)**: No conflicts, different lifecycle hooks

## Notes

- Reporter events are fire-and-forget by design
- All reporter methods are optional (IReporter interface)
- Reporter errors are logged at WARN level (not ERROR) since they're non-critical
- onRunEnd always fires in finally block, even if try block throws
- PRD must be accessible in finally block, so it's initialized before try

## Acceptance Criteria Status

| AC | Description | Status |
|----|-------------|--------|
| 1  | onRunStart fires once at run start with runId, feature, totalStories, startTime | ✅ |
| 2  | onStoryComplete fires after each story with storyId, status, durationMs, cost, tier, testStrategy | ✅ |
| 3  | onRunEnd fires once at run end with runId, totalDurationMs, totalCost, storySummary counts | ✅ |
| 4  | Reporter errors are caught and logged but never block execution | ✅ |
| 5  | Multiple reporters all receive events (not short-circuited on error) | ✅ |
| 6  | Events fire even when the run fails or is aborted (onRunEnd still fires) | ✅ |

**Overall Status:** ✅ ALL ACCEPTANCE CRITERIA MET
