# BUG-073: Acceptance Flow — Monorepo Support & Fix Story Quality

**Status:** Approved  
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

**Status:** ✅ Fixed in current session (6 commits on master)

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

**Expected:** Detect when the set of ACs has changed and regenerate the test file.

#### BUG-073C: Fix stories generated one-per-AC (wasteful)

For 28 failed ACs, the loop generates 28 separate fix stories. Each one:
- Opens a new LLM session ($0.10-0.17 per description)
- Creates a separate `US-FIX-NNN` story
- Runs through the full pipeline independently

**Expected:** Batch related failures into fewer fix stories.

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

The agent has no idea what actually failed or where to look.

#### BUG-073F: No detection of test-level vs implementation-level failures

When 90% of ACs fail (28/31), the root cause is almost certainly a test bug (wrong path, bad import, syntax error) — not 28 separate implementation gaps. The fix loop burns $3+ generating fix stories for a problem that should trigger test regeneration instead.

---

## Design Decisions

### D1: Fix story batching — group by related stories

Group failed ACs by their related stories from `findRelatedStories()`:
- ACs sharing the same related story set → single fix story
- Hard cap: max 8 fix stories per retry. If grouping exceeds 8, merge the smallest groups.
- No fuzzy error pattern matching (fragile) — related stories is a reliable signal.

**Example (koda/refactor-standard):**
```
AC-1, AC-2, AC-8, AC-9       → all related to US-003 (auth)     → 1 fix story
AC-11, AC-12, AC-13, AC-14   → all related to US-005 (i18n)     → 1 fix story
AC-17, AC-18, AC-19           → related to US-004 + US-006       → 1 fix story
...
28 ACs → ~5-8 fix stories (not 28)
```

### D2: Test-level failure detection — regenerate, don't fix

Two failure modes require different actions:

| Failure mode | Detection | Action |
|:-------------|:----------|:-------|
| **Test bug** (wrong paths, bad imports, syntax) | >80% of ACs fail, OR test crashes with no ACs parsed | **Regenerate** the test file |
| **Implementation gap** (real code missing) | <80% of ACs fail | Generate fix stories targeting implementation |

The >80% threshold catches cases like koda (28/31 = 90%). The crash case (`AC-ERROR`) already exists in `acceptance.ts`.

Regeneration flow:
1. Back up current test to `acceptance.test.ts.bak`
2. Delete `acceptance.test.ts`
3. Re-run `acceptance-setup` to generate fresh test
4. Continue retry loop with new test

### D3: Acceptance test regeneration — hash-based with backup

When `acceptance-setup` finds an existing test file:
1. Compute SHA-256 fingerprint of sorted AC strings
2. Compare against stored fingerprint in `acceptance-meta.json`
3. If different → back up to `.bak`, regenerate, update fingerprint
4. If same → skip (current behavior)

**Always overwrite with backup** — no merge attempts:
- `acceptance.test.ts` → overwritten with fresh generation
- `acceptance.test.ts.bak` → previous version (one backup, for debugging)
- Manual edits are rare; `.bak` preserves them if needed

### D4: Fix story workdir — inherit from related story

Fix stories inherit `workdir` from the related story they're fixing. When `findRelatedStories()` returns stories with `workdir` set, the fix story copies it so pipeline stages (review, verify) use correct per-package config.

---

## Proposed Fixes

### Phase 1: Fix story quality (high impact, moderate effort)

#### P1-A: Enrich fix story context

Update `convertFixStoryToUserStory()` to include in the description:
- Acceptance test file path: `nax/features/<feature>/acceptance.test.ts`
- Specific test failure output for the batched AC(s)
- Parsed assertion error messages

Update fix story prompt template to instruct the agent:
1. Read the acceptance test file first
2. Understand what each failing test expects
3. Find the relevant source code
4. Fix the implementation (NOT the test file)

#### P1-B: Batch fix stories by related stories

Replace per-AC generation loop with:
1. Group failed ACs by related stories (`findRelatedStories()`)
2. For each group, generate ONE fix story covering all ACs in the group
3. Hard cap at 8 fix stories — merge smallest groups if exceeded
4. Single LLM call per group (not per AC)

#### P1-C: Inherit workdir on fix stories

Fix stories copy `workdir` from their related story so pipeline stages use per-package config.

#### P1-D: Detect test-level failures → regenerate instead of fix

In `acceptance-loop.ts`, before generating fix stories:
1. Count failed ACs vs total ACs
2. If >80% failed → back up test, delete, re-run `acceptance-setup` to regenerate
3. If test crashed (no ACs parsed) → same regeneration path
4. Only generate fix stories when <80% of ACs failed (real implementation gaps)

### Phase 2: Acceptance regeneration (medium impact, low effort)

#### P2-A: Hash-based staleness detection

In `acceptance-setup.ts`:
1. Compute SHA-256 of sorted, joined AC strings
2. Load `acceptance-meta.json` if it exists
3. If fingerprint differs or meta missing → back up `.bak`, regenerate, write new meta
4. If same → skip generation

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
#### P3-B: Acceptance test framework detection for mixed monorepos
#### P3-C: Fix story observability (structured logging, git diff summary, cost breakdown)

---

## Acceptance Criteria

### Phase 1

- [ ] **AC-1:** Fix stories include acceptance test file path in their description
- [ ] **AC-2:** Fix stories include specific test failure output for their batched AC(s)
- [ ] **AC-3:** Fix stories include parsed assertion error messages
- [ ] **AC-4:** Fix story prompt instructs agent to read acceptance test first, then fix implementation (not the test)
- [ ] **AC-5:** Failed ACs sharing related stories are batched into a single fix story
- [ ] **AC-6:** For 28 failures with same root cause, ≤8 fix stories are generated (not 28)
- [ ] **AC-7:** Fix stories inherit `workdir` from their related story when available
- [ ] **AC-8:** When >80% of ACs fail, acceptance test is regenerated (not fix stories)
- [ ] **AC-9:** When test crashes with no ACs parsed, test is regenerated
- [ ] **AC-10:** Regeneration backs up old test to `.bak` before overwriting
- [ ] **AC-11:** All existing acceptance tests pass (no regressions)

### Phase 2

- [ ] **AC-12:** Adding a new story to the PRD triggers acceptance test regeneration on next run
- [ ] **AC-13:** Removing a story triggers regeneration
- [ ] **AC-14:** Modifying an AC triggers regeneration
- [ ] **AC-15:** `acceptance-meta.json` is created alongside the test file
- [ ] **AC-16:** Unchanged PRD does NOT trigger regeneration (idempotent)

---

## Test Plan

- Unit tests for fix story batching logic (group by related stories, cap at 8)
- Unit tests for >80% failure threshold detection
- Unit tests for AC fingerprint computation and staleness detection
- Unit tests for enriched fix story prompt content (test path, failure output, error messages)
- Unit tests for `.bak` backup on regeneration
- Integration test: verify fix story includes test output in description
- Manual validation: run acceptance on koda/refactor-standard with enriched fix stories

---

*Created 2026-03-21. Based on koda/refactor-standard post-mortem.*
*Updated 2026-03-21: Added design decisions D1-D4 (batching, test-level detection, hash regeneration, workdir inheritance).*
