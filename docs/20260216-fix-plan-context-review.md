# Fix Plan: Context Builder Review Findings
**Date:** 2026-02-16
**Branch:** main (local commits only)

## Phase 1: DRY + Token Estimation + Dead Config

### Fix 1: Extract context building helper in runner.ts
**File:** `src/execution/runner.ts`
**Impact:** Code duplication between TDD and single-session paths
**Change:** Extract the duplicated 8-line context building block (build + log) into a helper function like `maybeGetContext(story, config, useContext)` that returns `string | undefined`. Call it from both TDD and single-session branches.

### Fix 2: Token estimation ratio
**File:** `src/context/builder.ts`
**Impact:** Budget underestimates for code (1:4 is too generous; code averages closer to 1:3)
**Change:** Change `estimateTokens()` from `Math.ceil(text.length / 4)` to `Math.ceil(text.length / 3)`. Update any test assertions that check specific token counts.

### Fix 3: Remove dead config paths
**File:** `src/context/types.ts`, `src/context/builder.ts`, `src/execution/runner.ts`
**Impact:** `includeConfig` and `includeDependencies` in `ContextBuilderConfig` are set but never read in `buildContext()`
**Change:** Remove `includeConfig` and `includeDependencies` from `ContextBuilderConfig`. Remove them from the config object in `buildStoryContext()`. If dependencies should be used, wire them — otherwise remove the dead path. The `dependency` type in `ContextElement` can stay for future use.

## Phase 2: Wire UserStory fields for real context

### Fix 4: Add optional context fields to UserStory
**File:** `src/prd/types.ts`
**Change:** Add to `UserStory` interface:
```ts
/** Relevant source files for context injection */
relevantFiles?: string[];
/** Prior error messages from failed attempts */
priorErrors?: string[];
/** Custom context strings */
customContext?: string[];
```

### Fix 5: Wire UserStory fields into buildStoryContext
**File:** `src/execution/runner.ts`
**Change:** Replace the hardcoded empty arrays in `buildStoryContext()` with actual values from `story`:
```ts
relevantFiles: story.relevantFiles || [],
priorErrors: story.priorErrors,
customContext: story.customContext,
```

### Fix 6: Populate priorErrors on retry
**File:** `src/execution/runner.ts`
**Change:** When a story fails and gets retried (escalation), capture the error/failure reason and push it to `story.priorErrors` so the next attempt gets context about what went wrong.

## Test Strategy
- Mode: test-after
- Run: `bun test` after each phase
- Update existing assertions in `test/context.test.ts` and `test/context-integration.test.ts` for token ratio change

## Commits
- Phase 1: `refactor: DRY context helper, fix token estimation, remove dead config`
- Phase 2: `feat: wire UserStory context fields into context builder`
