# BUG-039 — Orphan Process Prevention

**Status:** Proposal
**Target:** v0.21.0
**Author:** Nax Dev
**Date:** 2026-03-06

---

## 1. Problem

When nax aborts a story (timeout, error, SIGTERM), several child processes are left running as orphans:
- `bun run lint` / `bun run typecheck` (review stage)
- `git diff`, `git log`, `git rev-parse` (smart runner, utils/git.ts)
- `claude` CLI (decompose — no timeout at all)

These processes accumulate across stories and survive after nax exits, consuming CPU/memory.

---

## 2. Root Causes

| Location | Process | Issue | Severity |
|---|---|---|---|
| `review/runner.ts:runCheck()` | `lint`, `typecheck` | No timeout, no kill, not in PidRegistry | 🔴 Critical |
| `agents/claude.ts:decompose()` | `claude` CLI | No timeout set | 🔴 Critical |
| `utils/git.ts:captureGitRef()` | `git rev-parse` | No timeout | 🟡 Medium |
| `utils/git.ts:hasCommitsForStory()` | `git log` | No timeout | 🟡 Medium |
| `verification/smart-runner.ts` | `git diff` | No timeout, not killed on verify abort | 🟡 Medium |
| `agents/claude.ts:runOnce()` | `claude` CLI | SIGTERM only — no SIGKILL follow-up after grace period | 🟡 Medium |
| `agents/claude.ts:runOnce()` | `claude` CLI | If timeout throws, `pidRegistry.unregister()` skipped → PID leaks | 🟡 Medium |
| `routing/strategies/llm.ts` | `claude` CLI | Timeout kills proc but streams not drained → `proc.exited` may hang | 🟡 Medium |
| `verification/executor.ts:drainWithDeadline()` | internal | `setTimeout` in drain race never cleared | 🟢 Minor |
| `execution/pid-registry.ts:killPid()` | `kill` binary | Spawns `kill` subprocesses without timeout | 🟢 Minor |

**Already correct:** `executor.ts:executeWithTimeout()` — SIGTERM + grace + SIGKILL process group. `crash-recovery.ts` — `pidRegistry.killAll()` on all signals. `pid-registry.ts:cleanupStale()` — kills orphans at startup.

---

## 3. Proposed Fixes

### Fix 1 — Shared `gitWithTimeout()` helper

Replace all bare git spawns in `utils/git.ts` and `smart-runner.ts`:

```typescript
// src/utils/git.ts
const GIT_TIMEOUT_MS = 10_000;

async function gitWithTimeout(args: string[], workdir: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
  const timerId = setTimeout(() => proc.kill("SIGKILL"), GIT_TIMEOUT_MS);
  const exitCode = await proc.exited;
  clearTimeout(timerId);
  const stdout = await new Response(proc.stdout).text();
  return { stdout, exitCode };
}
```

Apply to: `captureGitRef()`, `hasCommitsForStory()`, `getChangedSourceFiles()` in `smart-runner.ts`.

### Fix 2 — Review `runCheck()` timeout

Wrap each check spawn with SIGTERM+SIGKILL pattern. Config: `review.checkTimeoutSeconds` (default: 120).

### Fix 3 — `decompose()` timeout

Add `timeoutSeconds` to `DecomposeOptions` (default: 300). Apply same setTimeout → SIGTERM pattern as `runOnce()`.

### Fix 4 — `runOnce()` SIGKILL follow-up + `finally` unregister

```typescript
setTimeout(() => {
  timedOut = true;
  proc.kill("SIGTERM");
  setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, gracePeriodMs);
}, timeoutMs);

// Always unregister, even on exception:
try {
  const exitCode = await proc.exited;
  clearTimeout(timeoutId);
} finally {
  await pidRegistry.unregister(processPid);
}
```

### Fix 5 — `llm.ts` stream drain on timeout

Cancel streams before killing to prevent `proc.exited` hang:

```typescript
} catch (err) {
  clearTimeout(timeoutId);
  proc.stdout.cancel().catch(() => {});
  proc.stderr.cancel().catch(() => {});
  proc.kill();
  throw err;
}
```

### Fix 6 — `drainWithDeadline()` timer cleanup

Store and clear the setTimeout handle after the race resolves.

---

## 4. Files Affected

| File | Change |
|---|---|
| `src/utils/git.ts` | Add `gitWithTimeout()` helper; use in all git spawns |
| `src/verification/smart-runner.ts` | Use `gitWithTimeout()` for `git diff` |
| `src/review/runner.ts` | Add timeout + SIGTERM/SIGKILL to `runCheck()` |
| `src/config/schemas.ts` | Add `review.checkTimeoutSeconds` (default: 120) |
| `src/config/types.ts` | Add `checkTimeoutSeconds` to `ReviewConfig` |
| `src/agents/claude.ts` | Fix `decompose()` timeout; `runOnce()` SIGKILL + finally |
| `src/agents/types.ts` | Add `timeoutSeconds` to `DecomposeOptions` |
| `src/routing/strategies/llm.ts` | Cancel streams before kill on timeout |
| `src/verification/executor.ts` | `clearTimeout` in `drainWithDeadline()` |

---

## 5. Test Plan

- `runCheck()` with hanging command → killed after `checkTimeoutSeconds`
- `decompose()` with hanging claude → times out, PID unregistered
- `runOnce()` timeout → SIGKILL after grace period; PID unregistered even on exception
- `gitWithTimeout()` → returns error after 10s (no hanging promise)
- `drainWithDeadline()` → no leaked setTimeout (verify with fake timers)
- `llm.ts` timeout → `proc.exited` resolves after kill (no hang)
