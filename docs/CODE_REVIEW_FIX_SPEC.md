# Code Review Fix Spec

**Source:** `docs/CODE_REVIEW.md` (revised 2026-03-15)
**Scope:** P0 + P1 confirmed findings only
**Constraint:** Do NOT push to remote. Commit each fix atomically.

---

## Fix 1: BUG-1 — Signal handler leak (P0)

**File:** `src/execution/crash-signals.ts`

**Problem:** Line 137 registers `(reason) => unhandledRejectionHandler(reason)` (anonymous arrow). Line 146 tries to remove with a *different* anonymous arrow — `removeListener` compares by reference, so it's a silent no-op. Handlers accumulate on every `run()` call.

**Fix:**
- Line 137: Store the wrapper in a named const before registering:
  ```typescript
  const rejectionWrapper = (reason: unknown) => unhandledRejectionHandler(reason);
  process.on("unhandledRejection", rejectionWrapper);
  ```
- Line 146: Use the same reference:
  ```typescript
  process.removeListener("unhandledRejection", rejectionWrapper);
  ```

**Test:** Check existing tests in `test/` for crash-signals. If a test for handler cleanup exists, verify it passes. If not, add one that confirms `process.listenerCount("unhandledRejection")` returns to its original value after cleanup.

---

## Fix 2: SEC-1 — Symlink bypass in plugin path validation (P0)

**File:** `src/utils/path-security.ts`

**Problem:** `validateModulePath()` uses `normalize()` (lexical only) — does NOT resolve symlinks. A symlink inside an allowed root can point outside it.

**Fix:**
- Import `realpathSync` from `node:fs`
- After computing `absoluteTarget`, resolve it through `realpathSync` before the containment check
- Also resolve each root through `realpathSync`
- Handle the case where the path doesn't exist yet (new file) — fall back to resolving the parent directory
- Keep the existing API contract (return `PathValidationResult`)

**Important:** `src/config/path-security.ts` already demonstrates the correct `realpathSync` pattern — follow that approach.

**Test:** Check `test/` for path-security tests. Add a test that creates a symlink pointing outside the allowed root and verifies `validateModulePath` rejects it.

---

## Fix 3: BUG-2 — Unsafe cast in lock.ts (P0)

**File:** `src/execution/lock.ts`

**Problem:** Line 64: `lockData = undefined as unknown as { pid: number }` — unsafe double-cast that lies to the type system.

**Fix:**
- Change `lockData` type to `{ pid: number } | null`
- In the catch block, set `lockData = null` (no cast needed)
- The existing `if (lockData)` guard already handles null correctly

---

## Fix 4: SEC-3 — Hardcoded approve-all on session resume (P1)

**File:** `src/agents/acp/spawn-client.ts`

**Problem:** `loadSession()` (line 329) hardcodes `permissionMode: "approve-all"` regardless of the client's configured permission level.

**Fix:**
- Add `permissionMode` parameter to `loadSession()` method signature with default `"approve-reads"`
- Pass the client's own permission mode through:
  ```typescript
  async loadSession(sessionName: string, agentName: string): Promise<AcpSession | null> {
    // ...
    return new SpawnAcpSession({
      // ...
      permissionMode: this.permissionMode ?? "approve-reads",
      // ...
    });
  }
  ```
- Check if `SpawnAcpClient` stores `permissionMode` — if not, thread it through from construction

**Test:** Verify existing session resume tests check the permission mode. Add one if missing.

---

## Fix 5: BUG-3 — Subprocess for file deletion (P1)

**File:** `src/execution/lock.ts`

**Problem:** `releaseLock()` (line 120) uses `Bun.spawn(["rm", lockPath])` + `Bun.sleep(10)` to delete a single file.

**Fix:**
```typescript
import { unlink } from "node:fs/promises";

export async function releaseLock(workdir: string): Promise<void> {
  const lockPath = path.join(workdir, "nax.lock");
  try {
    await unlink(lockPath);
  } catch (error) {
    // Ignore ENOENT (already gone), log others
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const logger = getSafeLogger();
      logger?.warn("execution", "Failed to release lock", {
        error: (error as Error).message,
      });
    }
  }
}
```

**Test:** Existing lock tests should still pass. Verify no test depends on the `Bun.sleep(10)` timing.

---

## Fix 6: CONV-1 — Document Node.js fs justification in lock.ts (P1)

**File:** `src/execution/lock.ts`

**Problem:** Lines 91-94 use `openSync`/`writeSync`/`closeSync` with `O_CREAT | O_EXCL` — this is intentional (Bun has no equivalent atomic exclusive create), but lacks a comment.

**Fix:** Add a comment above line 91:
```typescript
// NOTE: Node.js fs used intentionally — Bun.file()/Bun.write() lacks O_CREAT|O_EXCL atomic exclusive create
```

---

## General Instructions

1. Read this spec completely before starting
2. Fix each issue in order (Fix 1 → Fix 6)
3. After ALL fixes, run: `NAX_SKIP_PRECHECK=1 bun test --timeout=60000 --bail`
4. If tests pass, commit all fixes in one atomic commit: `fix: code review P0+P1 fixes (BUG-1, SEC-1, BUG-2, SEC-3, BUG-3, CONV-1)`
5. Do NOT push to remote
6. Do NOT modify docs/CODE_REVIEW.md or docs/ROADMAP.md
7. Report: files changed, tests passed/failed, commit hash
