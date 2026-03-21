# BUG-073: Acceptance Flow — Monorepo Support & Fix Story Quality

**Status:** Draft  
**Component:** `src/acceptance/generator.ts`, `src/acceptance/fix-generator.ts`, `src/pipeline/stages/acceptance.ts`, `src/pipeline/stages/acceptance-setup.ts`, `src/execution/lifecycle/acceptance-loop.ts`  
**Found:** 2026-03-21 (koda/refactor-standard — 28 of 31 ACs failed due to wrong path, fix loop burned ~$3+ generating 28 individual fix stories that did nothing)  
**Depends on:** BUG-072 (merged v0.50.3)

---

## Problem

The acceptance flow has multiple issues when running in monorepo projects, and the fix story mechanism lacks sufficient context to make meaningful fixes.

### Observed Behavior (koda/refactor-standard)

1. Acceptance test generated with wrong `__dirname` depth (4 levels instead of 3) — all file paths resolved to parent of repo root
2. 28 of 31 ACs failed (path resolution errors, not real failures)
3. Fix loop generated 28 individual fix stories (one per AC), each costing $0.10-0.17 for description generation alone
4. Fix stories ran through the pipeline but accomplished nothing — agent received vague descriptions with no test output, no test file path, no specific error context
5. Total wasted cost: ~$3+ in description generation + pipeline execution costs

### Root Causes

#### BUG-073A: Acceptance test path resolution and execution context

Two related issues with how acceptance tests resolve paths:

1. **Wrong `__dirname` depth:** LLM generated `join(__dirname, '..', '..', '..', '..')` (4 levels) but the test file lives at `<repo-root>/nax/features/<feature>/acceptance.test.ts` — only 3 levels to repo root. All file-check tests silently resolved to wrong paths.

2. **CWD and config:** Multiple places had incorrect workdir/config for monorepo. See status table below.

**Design decision:** Acceptance tests always run from repo root (`cwd: ctx.workdir`). The test file uses `__dirname` (3 levels up = root) to compute absolute paths, then navigates into packages as needed (e.g. `join(root, 'apps/api/src')`). `__dirname` is always absolute regardless of CWD — they solve different things (CWD = tsconfig/module resolution, `__dirname` = file path assertions). This covers both single repo and monorepo with one rule.

| Location | Bug | Status |
|:---------|:----|:-------|
| Generator prompt | No path anchor — LLM guessed wrong depth | ✅ Fixed (explicit 3-level anchor + monorepo nav) |
| `acceptance.ts` — test execution | CWD was `ctx.workdir` (root) | ✅ Correct — stays root |
| `acceptance-setup.ts` — RED gate | CWD is `ctx.workdir` (root) | ✅ Correct |
| `acceptance-loop.ts` — acceptanceContext | Was using per-package config | ✅ Fixed — reverted to root config |
| `acceptance-loop.ts` — executeFixStory | Was using root config | ✅ Fixed — now loads per-package config |
| `review.ts` — review commands fallback | No fallback to `quality.commands` | ✅ Fixed — added priority-3 fallback |

**Status:** Fixed in current session (6 commits on master)

#### BUG-073B: Acceptance test never regenerated when stories are added

`acceptance-setup.ts` skips generation if `acceptance.test.ts` already exists (line 76). If a user manually adds stories or re-runs with new ACs, the old test file remains. New acceptance criteria are never tested.

```typescript
// Current behavior — never regenerates
const fileExists = await _acceptanceSetupDeps.fileExists(testPath);
if (!fileExists) {
  // ... generate
}
// If file exists → skip entirely
```

**Expected:** Detect when the set of ACs has changed (new stories added, stories removed, ACs modified) and regenerate the test file.

#### BUG-073C: Fix stories generated one-per-AC (wasteful)

For 28 failed ACs, the loop generates 28 separate fix stories. Each one:
- Opens a new LLM session ($0.10-0.17 per description)
- Creates a separate `US-FIX-NNN` story
- Runs through the full pipeline independently

This is extremely wasteful when failures share a common root cause (e.g. wrong path calculation affects all file-check tests).

**Expected:** Batch related failures into fewer fix stories. At minimum, group failures that share the same root cause or related stories.

#### BUG-073D: Fix stories lack context — agent can't fix anything

`convertFixStoryToUserStory()` creates fix stories with:
```typescript
{
  description: "2-4 sentence vague fix text",     // from LLM
  acceptanceCriteria: ["Fix AC-40"],               // tells agent nothing
  workdir: undefined,                              // always undefined
  // testOutput: NOT INCLUDED
  // testFilePath: NOT INCLUDED  
  // specificError: NOT INCLUDED
}
```

The fix story then runs through the standard prompt builder which produces a generic TDD prompt. The agent receives:
- A vague description ("Fix the auth module to use...")
- AC: "Fix AC-40" (useless)
- No test failure output
- No acceptance test file path (`nax/features/<feature>/acceptance.test.ts`)
- No specific assertion error messages

The agent has no idea what actually failed or where to look.

**Expected:** Fix stories should include:
1. The acceptance test file path
2. The specific test failure output for the failed AC(s)
3. The assertion error message
4. Instructions to read the acceptance test first, understand what it expects, then fix the implementation

#### ~~BUG-073E~~ Merged into BUG-073A above.

---

## Proposed Fixes

### Phase 1: Fix story quality (high impact, moderate effort)

#### P1-A: Enrich fix story context

Update `convertFixStoryToUserStory()` and fix story prompt to include:
- Acceptance test file path: `nax/features/<feature>/acceptance.test.ts`
- Specific test failure output for the AC(s) being fixed
- Assertion error messages parsed from test output

Update the prompt template for fix stories to instruct the agent:
1. Read the acceptance test file first
2. Understand what the test expects
3. Find the relevant source code
4. Fix the implementation (not the test)

#### P1-B: Batch fix stories by root cause

Instead of 1 fix story per AC:
1. Group failed ACs by their related stories (from `findRelatedStories()`)
2. ACs sharing the same related stories → single fix story
3. Fallback: if grouping produces >5 stories, merge remaining into catch-all

Target: 28 failed ACs → 3-5 fix stories instead of 28.

#### P1-C: Include workdir on fix stories

Fix stories should inherit `workdir` from their related story. When `findRelatedStories()` returns stories with `workdir` set, the fix story should inherit it so the pipeline stages (review, verify) use the correct per-package config.

### Phase 2: Acceptance regeneration (medium impact, low effort)

#### P2-A: Detect stale acceptance tests

When `acceptance-setup` finds an existing test file:
1. Compute a hash/fingerprint of the current AC set (sorted, joined)
2. Compare against a stored fingerprint (in `acceptance-meta.json` alongside the test)
3. If different → regenerate the test file
4. If same → skip (current behavior)

This handles: new stories added, stories removed, ACs modified.

#### P2-B: Store acceptance metadata

Create `<featureDir>/acceptance-meta.json`:
```json
{
  "generatedAt": "2026-03-21T03:00:00Z",
  "acFingerprint": "sha256:abc123...",
  "storyCount": 9,
  "acCount": 31,
  "generator": "v0.51.0"
}
```

### Phase 3: Future improvements (backlog)

#### P3-A: Per-story acceptance (not just deferred)

Currently acceptance only runs after ALL stories complete. Consider allowing per-story acceptance validation where each story's ACs are checked immediately after that story passes.

#### P3-B: Acceptance test framework detection

The generator prompt tells the LLM to auto-detect the test framework. For monorepo projects with mixed frameworks (Jest in `apps/api`, Vitest in `apps/web`), the acceptance test needs to pick one. Currently relies on LLM judgment.

#### P3-C: Fix story observability

Add structured logging for fix story execution:
- What files the agent modified
- Git diff summary after execution
- Whether verification passed
- Cost breakdown per fix story

---

## Acceptance Criteria

### Phase 1

- [ ] **AC-1:** Fix stories include acceptance test file path in their description
- [ ] **AC-2:** Fix stories include specific test failure output for their AC(s)
- [ ] **AC-3:** Fix stories include parsed assertion error messages
- [ ] **AC-4:** Fix story prompt instructs agent to read acceptance test first
- [ ] **AC-5:** Failed ACs sharing related stories are batched into a single fix story
- [ ] **AC-6:** For 28 failures with same root cause, ≤5 fix stories are generated (not 28)
- [ ] **AC-7:** Fix stories inherit `workdir` from their related story when available
- [ ] **AC-8:** All existing acceptance tests pass (no regressions)

### Phase 2

- [ ] **AC-9:** Adding a new story to the PRD triggers acceptance test regeneration on next run
- [ ] **AC-10:** Removing a story triggers regeneration
- [ ] **AC-11:** Modifying an AC triggers regeneration
- [ ] **AC-12:** `acceptance-meta.json` is created alongside the test file
- [ ] **AC-13:** Unchanged PRD does NOT trigger regeneration (idempotent)

---

## Test Plan

- Unit tests for fix story batching logic
- Unit tests for AC fingerprint computation and staleness detection
- Unit tests for enriched fix story prompt content
- Integration test: verify fix story includes test output in description
- Manual validation: run acceptance on koda/refactor-standard with enriched fix stories

---

*Created 2026-03-21. Based on koda/refactor-standard post-mortem.*
