# Fix Plan: Complete Partially-Done Review Items
**Date:** 2026-02-17
**Branch:** master (local commits only)

## Phase 1: BUG-3 — Cost Estimation Confidence Scores

**File:** `src/agents/cost.ts`
**Impact:** Users can't distinguish accurate vs estimated costs; budget tracking unreliable.

**Changes:**
1. Add `confidence: 'exact' | 'estimated' | 'fallback'` field to `CostEstimate` type
2. `estimateCostFromOutput()` → returns confidence `'exact'` when structured tokens parsed, `'estimated'` when regex-matched
3. `estimateCostByDuration()` → returns confidence `'fallback'`
4. Add `formatCostWithConfidence(cost: CostEstimate): string` helper that shows confidence indicator (e.g., `$0.12 (exact)` vs `~$0.15 (estimated)`)
5. Log warnings when fallback estimation is used
6. Update existing tests, add tests for confidence field

**Run:** `bun test`
**Commit:** `fix(cost): add confidence scores to cost estimation`

## Phase 2: MEM-1 — Lazy PRD Loading for Large Features

**File:** `src/prd/index.ts`, `src/execution/runner.ts`
**Impact:** Large PRDs (500+ stories) cause excessive memory and I/O.

**Changes:**
1. In `src/prd/index.ts`: Add `loadPRDLazy(path, options?: { storyIds?: string[] })` that loads only requested stories + metadata (story count, feature name)
2. In `src/execution/runner.ts`: Replace full PRD reload every iteration with dirty-flag pattern:
   - Set `prdDirty = true` only after writing PRD (story status update)
   - Reload PRD only when dirty flag is set
   - Use lazy loading to fetch only next batch of stories when possible
3. Add `PRD_MAX_FILE_SIZE = 5 * 1024 * 1024` (5MB) constant — reject PRDs over this size with clear error

**Run:** `bun test`
**Commit:** `fix(prd): lazy loading and dirty-flag reload optimization`

## Phase 3: ENH-1 — JSDoc for Underserved Modules

**Files:** `src/agents/claude.ts`, `src/agents/types.ts`, `src/agents/cost.ts`, `bin/ngent.ts`, `src/routing/router.ts`, `src/tdd/orchestrator.ts`, `src/context/builder.ts`
**Impact:** IDE intellisense missing, contributor onboarding harder.

**Changes:**
Add JSDoc with `@param`, `@returns`, `@example` to all exported functions:

1. `src/agents/claude.ts`: Document `ClaudeCodeAdapter` class, `isInstalled()`, `run()`, `buildCommand()`
2. `src/agents/types.ts`: Document `AgentAdapter` interface, `AgentResult`, `AgentRunOptions`
3. `src/agents/cost.ts`: Document `estimateCostFromOutput()`, `estimateCostByDuration()`, `parseTokenUsage()`
4. `bin/ngent.ts`: Document CLI commands and options
5. `src/routing/router.ts`: Document `routeTask()` with decision tree example
6. `src/tdd/orchestrator.ts`: Document `runThreeSessionTdd()` with session flow
7. `src/context/builder.ts`: Document `buildContext()` with token budget example

No logic changes — documentation only. No new tests needed.

**Run:** `bun test` (ensure no regressions from doc edits)
**Commit:** `docs: add comprehensive JSDoc to agents, routing, TDD, and CLI modules`

## Test Strategy
- Mode: test-after
- Phase 1: update existing cost tests + add confidence tests
- Phase 2: update runner tests for dirty-flag behavior
- Phase 3: no new tests (docs only)
