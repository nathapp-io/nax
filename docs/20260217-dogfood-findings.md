# Dogfood Findings: E2E Test with bun-kv-store
**Date:** 2026-02-17
**Test Project:** `projects/ngent/test-project/` (bun-kv-store)
**Result:** ✅ 8/8 stories, 56 tests, $0.76, 11.8 min

## Bugs Found

### BUG-9: Stale lock not cleaned on OOM/SIGKILL
**Severity:** P1 | **Category:** Reliability
**File:** `src/execution/helpers.ts` (acquireLock/releaseLock)

When ngent is OOM killed (signal 9), the lock file remains and blocks subsequent runs.
User must manually `rm ngent.lock`.

**Fix:** Use PID-based lock file. On acquire, check if the PID in the lock is still alive.
If stale (process dead), remove and re-acquire.

### BUG-10: Story count ignores pre-existing "passed" status
**Severity:** P2 | **Category:** Bug
**File:** `src/execution/runner.ts`

When resuming a run with manually edited prd.json (US-001 set to "passed"),
the progress display shows "0 done, 7 pending" — off by one.
The runner also re-executes the passed story instead of skipping it.

**Fix:** `countStories()` and `getNextStory()` should respect existing "passed" status
from prd.json when starting a run.

### BUG-11: Routing cached from analyze, ignores config model changes
**Severity:** P2 | **Category:** Enhancement  
**File:** `src/execution/runner.ts` + `src/prd/index.ts`

During `ngent analyze`, each story gets a `routing` object with `modelTier` baked in.
When user later changes `config.json` model mappings (e.g., simple→fast instead of balanced),
the cached routing in prd.json takes precedence.

**Fix:** Routing should be re-evaluated at run time using current config,
not cached from analyze. Store only `complexity` in prd.json, derive `modelTier` at runtime.

### BUG-12: OOM when verify stage runs concurrent with Claude Code
**Severity:** P1 | **Category:** Performance
**File:** `src/pipeline/stages/verify.ts`

On low-RAM VPS (~2GB), the verify stage spawns `bun test` while Claude Code's
TypeScript language servers are still in memory. Combined memory exceeds available RAM → SIGKILL.

**Fix:** Add delay after agent process exits before running verify (let Claude Code's
child processes fully terminate). Or: skip verify if agent already ran tests
(detect from agent output).

## Non-Bugs (Working as Designed)
- Constitution injection: ✅ worked perfectly, 614 tokens
- Story batching: ✅ grouped simple stories correctly  
- Cost tracking: ✅ accurate at $0.76
- Progress display: ✅ updated correctly during run
- Commit per story: ✅ clean conventional commits
