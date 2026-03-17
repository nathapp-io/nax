# SPEC: Review Rectification — v0.46.2

**Status:** Draft
**Date:** 2026-03-17
**Author:** Nax Dev

---

## Problem

When lint or typecheck fails in the **review stage**, nax has two recovery paths:

1. **Autofix stage** runs mechanical fix commands (`lintFix`, `formatFix`) if configured
2. If no fix commands or mechanical fix fails → **story escalates (fails)**

There is no agent-driven rectification for review failures. The existing `rectifyStage` only handles **test failures** from `verifyStage`. This means:

| Scenario | Current | Desired |
|:---------|:--------|:--------|
| Lint fails + `lintFix` configured | ✅ Autofix runs it | No change |
| Lint fails + no `lintFix` | ❌ Immediate escalate | Agent rectification with lint error context |
| Typecheck fails | ❌ Immediate escalate | Agent rectification with typecheck error context |
| Lint fix runs but doesn't fully resolve | ❌ Escalate | Agent rectification with remaining errors |

## Solution

Extend the **autofix stage** (`src/pipeline/stages/autofix.ts`) to spawn an agent rectification session when mechanical fixes are insufficient. This reuses the existing `runRectificationLoop` from `src/verification/rectification-loop.ts`.

### Flow (updated autofix stage)

```
review fails
  → autofix stage triggered
    → Step 1: Run lintFix command (if configured)
    → Step 2: Run formatFix command (if configured)
    → Step 3: Re-run review
    → If still failing:
      → Step 4: Spawn agent rectification session with review error context
      → Step 5: Re-run review
      → Repeat Step 4-5 up to maxAttempts
    → If fixed: retry from review stage
    → If exhausted: escalate
```

### Key Design Decisions

1. **Reuse `runRectificationLoop`** — same pattern as test rectification, but with review error output as prompt context
2. **No new stage** — extend autofix to keep pipeline simple
3. **Mechanical fix first, then agent** — cheap automated fix before expensive agent session
4. **Review error output in prompt** — agent gets the exact lint/typecheck errors to fix

---

## Implementation

### AUTOFIX-001: Add agent rectification fallback to autofix stage

**File:** `src/pipeline/stages/autofix.ts`

**Changes:**

1. After mechanical lintFix/formatFix fails (or isn't configured), check if review still fails
2. If still failing, call `runRectificationLoop` with:
   - `testCommand`: not used (we re-run review instead)
   - `testOutput`: the review check output (lint/typecheck errors)
   - `promptPrefix`: "The following lint/typecheck errors need to be fixed:"
3. After agent session, re-run review to verify

**New flow in `execute()`:**

```typescript
// Phase 1: Mechanical fix (existing)
if (lintFixCmd) { ... }
if (formatFixCmd) { ... }
const recheckPassed = await recheckReview(ctx);
if (recheckPassed) return { action: "retry", fromStage: "review" };

// Phase 2: Agent rectification (NEW)
const agentFixed = await runAgentReviewRectification(ctx);
if (agentFixed) return { action: "retry", fromStage: "review" };

return { action: "escalate", reason: "..." };
```

**Agent rectification function:**

```typescript
async function runAgentReviewRectification(ctx: PipelineContext): Promise<boolean> {
  const maxAttempts = ctx.config.quality.autofix?.maxAttempts ?? 2;
  const reviewOutput = collectReviewErrorOutput(ctx);
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Spawn agent with review errors as context
    const agent = getAgent(ctx.config.autoMode.defaultAgent);
    const prompt = buildReviewRectificationPrompt(reviewOutput, ctx.story);
    
    await agent.run({
      prompt,
      workdir: ctx.workdir,
      // ... standard agent options from config
      pipelineStage: "rectification",
      sessionRole: "implementer",
    });
    
    // Re-run review
    const passed = await recheckReview(ctx);
    if (passed) return true;
  }
  return false;
}
```

### AUTOFIX-002: Build review rectification prompt

**File:** `src/pipeline/stages/autofix.ts` (inline helper)

The prompt should include:
- Which checks failed (lint, typecheck, or both)
- The exact error output from each failed check
- The story context (what was being implemented)
- Clear instruction: fix the errors, don't change test behavior

```typescript
function buildReviewRectificationPrompt(
  failedChecks: ReviewCheckResult[],
  story: UserStory
): string {
  const errors = failedChecks
    .filter(c => !c.success)
    .map(c => `## ${c.check} errors (exit code ${c.exitCode})\n\`\`\`\n${c.output}\n\`\`\``)
    .join("\n\n");

  return `You are fixing lint/typecheck errors from a code review.

Story: ${story.title} (${story.id})

The following quality checks failed after implementation:

${errors}

Fix ALL errors listed above. Do NOT change test files or test behavior.
Do NOT add new features — only fix the quality check errors.
Commit your fixes when done.`;
}
```

### AUTOFIX-003: Thread review check results into PipelineContext

**File:** `src/pipeline/types.ts`

The `reviewResult` on `PipelineContext` already holds `ReviewResult` which contains `checks: ReviewCheckResult[]`. Each `ReviewCheckResult` has `output` with the error text. No new fields needed — just read `ctx.reviewResult.checks`.

### AUTOFIX-004: Tests

**File:** `test/unit/pipeline/stages/autofix.test.ts`

New test cases:

1. **Agent rectification runs when no fix commands configured**
   - No `lintFix`/`formatFix` → agent session spawned → review re-run
   
2. **Agent rectification runs when mechanical fix fails**
   - `lintFix` exits 0 but review still fails → agent session spawned
   
3. **Agent rectification succeeds → returns retry**
   - Agent fixes errors → review passes → `{ action: "retry", fromStage: "review" }`
   
4. **Agent rectification exhausted → returns escalate**
   - Agent can't fix → max attempts reached → `{ action: "escalate" }`

5. **Agent rectification skipped when review passes after mechanical fix**
   - `lintFix` fixes everything → no agent session needed

6. **Prompt includes failed check output**
   - Verify the prompt passed to agent.run() contains the lint/typecheck error text

---

## Config

No new config fields needed. Reuses existing:

- `quality.autofix.enabled` (default: `true`) — gates the entire autofix stage
- `quality.autofix.maxAttempts` (default: `2`) — max agent rectification attempts
- `quality.commands.lintFix` — mechanical lint fix command (optional)
- `quality.commands.formatFix` — mechanical format fix command (optional)

---

## Files Changed

| File | Change |
|:-----|:-------|
| `src/pipeline/stages/autofix.ts` | Add agent rectification fallback after mechanical fix |
| `test/unit/pipeline/stages/autofix.test.ts` | New tests for agent rectification path |

---

## Commit Plan

1. `fix(autofix): add agent rectification fallback for lint/typecheck failures (AUTOFIX-001, AUTOFIX-002, AUTOFIX-003, AUTOFIX-004)` — single commit, all changes are tightly coupled

---

## Complexity

**Simple-Medium** — extends existing stage with well-understood pattern (rectification loop). Main risk is wiring agent options correctly from PipelineContext.
