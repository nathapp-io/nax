# BUG-21: Escalation fails when PRD story has null/missing attempts field

**Severity:** High
**Component:** src/execution/runner.ts (escalation logic)
**Found:** 2026-02-23
**Status:** Open

## Summary

When a story attempts field is null or missing in the PRD, escalation breaks. The agent returns finalAction: escalate but the story is immediately marked as failed instead of being re-queued at a higher model tier.

## Reproduction

1. Create a PRD with stories that do NOT include an attempts field (or set it to null)
2. Run nax run -f feature --headless
3. When a story fails and returns finalAction: escalate, observe:
   - Log shows Story failed - max attempts reached immediately
   - No actual escalation to next tier occurs
   - PRD shows attempts: null after the run

## Root Cause

The runner increments story.attempts via:
    attempts: s.attempts + 1
But if s.attempts is null or undefined, this produces NaN, breaking subsequent comparisons.

Pre-iteration tier check (line ~338):
    if (tierCfg && story.attempts >= tierCfg.attempts)
null >= 5 evaluates to false in JS, so this check is silently skipped.

Post-execution canEscalate check (line ~704):
    const canEscalate = storiesToEscalate.every((s) => s.attempts < maxAttempts);
null < 10 is true in JS, so canEscalate is true. But then attempts: s.attempts + 1 yields null + 1 = 1.
The story still gets marked failed, suggesting the PRD save/reload cycle loses the updated value or the iteration loop exits before re-processing.

## Suggested Fix

1. Initialize attempts to 0 when loading PRD stories with null/undefined attempts
2. Defensive coercion: attempts: (s.attempts ?? 0) + 1
3. Add PRD validation on load to ensure all stories have attempts: number (default 0)

## Observed Log

[21:45:33] [execution] Agent session failed { rateLimited: false, storyId: US-002 }
[21:45:33] [agent.complete] { storyId: US-002, success: false, finalAction: escalate, estimatedCost: 0.75 }
[21:45:33] [execution] Story failed - max attempts reached { storyId: US-002 }

No escalation log line between finalAction: escalate and Story failed, confirming escalation path was skipped.
