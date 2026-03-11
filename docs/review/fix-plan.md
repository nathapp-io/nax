# Review Fix Plan — v0.39.0

Based on the comprehensive code review (2026-03-11), re-evaluated against tiered file limits.

**False positive eliminated:** Finding #1 (Promise.race leak in parallel-worker.ts) — the code already calls `executing.delete(executePromise)` in `.finally()`, which is the correct bounded-concurrency pattern. No fix needed.

---

## Phase 1: Critical Bugs (30 min total)

### FIX-001: PID Registry Race Condition
**File:** `src/execution/pid-registry.ts:79-88`
**Severity:** CRITICAL
**Problem:** `register()` does read-then-write — two concurrent registrations can lose a PID.
```ts
// CURRENT (racy):
let existingContent = "";
if (existsSync(this.pidsFilePath)) {
  existingContent = await Bun.file(this.pidsFilePath).text();
}
await Bun.write(this.pidsFilePath, existingContent + line);
```
**Fix:** Use `Bun.write(path, { append: true })` or use `appendFile` pattern. Since Bun.write doesn't support append mode, use `node:fs/promises` `appendFile` which is atomic for small writes, or serialize with an in-process mutex (since nax is single-process, a simple queue suffices).
**Test:** Add test with concurrent `register()` calls verifying no PIDs are lost.

### FIX-002: ReDoS in Hook Validation
**File:** `src/hooks/runner.ts:112-122`
**Severity:** HIGH
**Problem:** Greedy regex patterns `/\$\(.*\)/` and `` /`.*`/ `` are vulnerable to catastrophic backtracking.
**Fix:** Replace with non-greedy or bounded patterns:
```ts
/\$\([^)]*\)/     // Match $(...) without greedy backtracking
/`[^`]*`/         // Match `...` without greedy backtracking
```
**Test:** Add test with pathological input: `$((((((((((((((((((((x` verifying it returns in <10ms.

### FIX-003: Timer Leaks in decompose/plan/interactive
**File:** `src/agents/claude.ts:200-202, 221-224`
**Severity:** HIGH
**Problem:** Same pattern just fixed in `claude-execution.ts` — inner SIGKILL setTimeout not tracked, stdout Promise.race timeout not cleared.
**Fix:** Apply the same `sigkillId`/`stdoutTimeoutId` pattern from commit `f4b4567`.
**Test:** Existing tests should cover if the pattern matches executeOnce.

---

## Phase 2: Architecture (2-3 hours)

### FIX-004: Extract Timeout Handler Utility
**Severity:** HIGH
**Problem:** SIGTERM→SIGKILL timeout pattern duplicated in 6 files.
**Create:** `src/execution/timeout-handler.ts`
```ts
export async function withProcessTimeout(
  proc: Subprocess,
  timeoutMs: number,
  opts?: { graceMs?: number; onTimeout?: () => void }
): Promise<{ exitCode: number; timedOut: boolean }>
```
**Files to update:** `claude-execution.ts`, `claude.ts` (decompose+plan), `review/runner.ts`, `tdd/session.ts`, `verification/smart-runner.ts`
**Test:** Unit test the utility with mock processes.

### FIX-005: Split runner.ts (401 lines → ~4 files)
**File:** `src/execution/runner.ts`
**Severity:** HIGH (source file, logic-heavy)
**Extract:**
- `runner-setup.ts` — config validation, status init, logger setup (~80 lines)
- `runner-execution.ts` — parallel/sequential dispatch (~80 lines)
- `runner-completion.ts` — acceptance loop, hook firing, exit (~100 lines)
- `runner.ts` — orchestrator that calls the above (~140 lines)

### FIX-006: Split config-display.ts (483 lines → 2 files)
**File:** `src/cli/config-display.ts`
**Severity:** HIGH (source file, exceeds 400)
**Extract:** `config-descriptions.ts` — the `FIELD_DESCRIPTIONS` constant map (~200 lines of static data).
**Remaining:** `config-display.ts` — display logic (~280 lines).

### FIX-007: Split lifecycle.test.ts (1068 lines → 2-3 files)
**File:** `test/unit/execution/lifecycle.test.ts`
**Severity:** HIGH (exceeds 800-line test limit)
**Split by concern:** e.g., `lifecycle-setup.test.ts`, `lifecycle-execution.test.ts`, `lifecycle-completion.test.ts`

---

## Phase 3: Quality (1-2 hours)

### FIX-008: Story ID Validation
**File:** `src/prd/types.ts` or `src/worktree/manager.ts`
**Severity:** HIGH
**Problem:** Story IDs used in git branch names without sanitization.
**Fix:** Add validation: `z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)` before worktree creation.
**Test:** Verify rejection of `../../../etc/passwd`, `--force`, empty string.

### FIX-009: Extract Error Conversion Utility
**File:** Create `src/utils/errors.ts`
**Severity:** MEDIUM
**Problem:** `error instanceof Error ? error.message : String(error)` repeated 19 times.
**Fix:** `export function errorMessage(err: unknown): string`
**Update:** All 19 call sites.

### FIX-010: PID Registry Map Cleanup
**File:** `src/agents/claude.ts:75-86`
**Severity:** MEDIUM
**Problem:** `pidRegistries` Map grows unbounded — each workdir gets cached forever.
**Fix:** Clear entry after `killAll()` or on unregister when empty. Or use WeakRef pattern.

---

## Execution Plan

| Phase | Fixes | Est. Time | Dependencies |
|-------|-------|-----------|-------------|
| 1 | FIX-001, FIX-002, FIX-003 | 30 min | None |
| 2 | FIX-004, FIX-005, FIX-006, FIX-007 | 2-3 hours | None |
| 3 | FIX-008, FIX-009, FIX-010 | 1-2 hours | None |

All phases can run as separate Claude sessions on Mac01.
After each phase: run `bun test --bail`, commit, do NOT push.
