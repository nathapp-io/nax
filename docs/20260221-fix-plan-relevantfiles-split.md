# Fix Plan: Split relevantFiles into contextFiles + expectedFiles

**Date:** 2026-02-21
**Branch:** `feat/v0.9-relevantfiles-split`
**Issue:** #1
**Base:** `master` (`b459e9f`)

## Context

`relevantFiles` conflates two purposes:
1. **Context injection** — files loaded into agent prompt before execution
2. **Asset verification** — files that must exist after execution (pre-flight gate)

This causes false negatives: LLM-predicted filenames fail asset check even when code is correct and tests pass. Observed in dogfood Runs F and H.

## Phase 1: Type Changes + Resolver Functions

### Fix 1.1: Add new fields to UserStory type
**File:** `src/prd/types.ts`
**Change:** Add `contextFiles?: string[]` and `expectedFiles?: string[]` to `UserStory` interface. Keep `relevantFiles?: string[]` as deprecated.

### Fix 1.2: Add resolver functions
**File:** `src/prd/types.ts` (or new `src/prd/helpers.ts`)
**Change:** Create two helper functions:
```typescript
export function getContextFiles(story: UserStory): string[] {
  return story.contextFiles ?? story.relevantFiles ?? [];
}
export function getExpectedFiles(story: UserStory): string[] {
  return story.expectedFiles ?? [];
}
```
**Key:** `getExpectedFiles` does NOT fall back to `relevantFiles`. Asset check is opt-in only.

### Fix 1.3: Export helpers from prd index
**File:** `src/prd/index.ts`
**Change:** Export `getContextFiles` and `getExpectedFiles`.

**Commit:** `refactor(prd): add contextFiles + expectedFiles types and resolvers`

## Phase 2: Wire Context Builder

### Fix 2.1: Use getContextFiles in context builder
**File:** `src/context/builder.ts`
**Change:** Replace `currentStory.relevantFiles` with `getContextFiles(currentStory)` at line ~296. Import from prd.

**Commit:** `refactor(context): use getContextFiles for prompt injection`

## Phase 3: Wire Verification

### Fix 3.1: Use getExpectedFiles in post-verify
**File:** `src/execution/post-verify.ts`
**Change:** Replace `story.relevantFiles` (line ~73) with `getExpectedFiles(story)`. Import from prd.

### Fix 3.2: Update verification function signature
**File:** `src/execution/verification.ts`
**Change:** Rename parameter `relevantFiles` to `expectedFiles` in `runVerification()` and `verifyAssets()` for clarity.

**Commit:** `refactor(verification): use getExpectedFiles for asset check (opt-in only)`

## Phase 4: Wire Analyze + Decompose Output

### Fix 4.1: Update classifier output
**File:** `src/analyze/classifier.ts`
**Change:** Map LLM output `relevantFiles` -> `contextFiles` in parsed result.

### Fix 4.2: Update analyze types
**File:** `src/analyze/types.ts`
**Change:** Add `contextFiles` field alongside `relevantFiles`.

### Fix 4.3: Update decompose prompt
**File:** `src/agents/claude.ts`
**Change:** In decompose prompt (~line 455), rename field 8 from `relevantFiles` to `contextFiles`.

### Fix 4.4: Update CLI analyze output
**File:** `src/cli/analyze.ts`
**Change:** Map `relevantFiles` -> `contextFiles` in feature creation output.

### Fix 4.5: Update acceptance fix-generator
**File:** `src/acceptance/fix-generator.ts`
**Change:** Replace `relevantFiles: []` with `contextFiles: []`.

**Commit:** `refactor(analyze): output contextFiles instead of relevantFiles`

## Phase 5: Tests

### Fix 5.1: Update verification tests
**Change:** Add test: story with `relevantFiles` but no `expectedFiles` -> asset check PASSES. Add test: story with `expectedFiles` set -> asset check verifies those files.

### Fix 5.2: Update context builder tests
**Change:** Test `contextFiles` used when present. Test `relevantFiles` fallback. Test empty when neither set.

### Fix 5.3: Update classifier/analyze tests
**Change:** Verify output uses `contextFiles` field.

**Commit:** `test: update tests for contextFiles/expectedFiles split`

## Test Strategy
- Mode: test-after
- Run `bun test` after each phase
- All existing test files should continue passing (backward compat)
