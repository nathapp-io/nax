# Phase 2: _deps Injection for Direct Bun Calls (HIGH priority)

**Branch:** `feat/code-audit` (continue from current HEAD)
**Estimated effort:** 2 hours
**Risk:** Low-Medium — adds indirection layer, must verify tests still pass

---

## Pattern Reference

Follow the existing `_deps` pattern used in `src/agents/claude.ts`:

```typescript
// At module level — injectable for testing
export const _myDeps = {
  spawn: Bun.spawn,
  file: Bun.file,
};
```

Tests override: `_myDeps.spawn = mockSpawn;`

---

## Task 2.1: `src/review/orchestrator.ts` — Direct `spawn`

Line 11: `import { spawn } from "bun";`
Lines 22-23: Direct usage in `getChangedFiles()`

**Fix:**
1. Create `export const _orchestratorDeps = { spawn };`
2. Replace direct `spawn(...)` calls with `_orchestratorDeps.spawn(...)`
3. Update any existing tests to use the deps object

---

## Task 2.2: `src/review/runner.ts` — Direct `spawn` + `Bun.file`

Line 7: `import { spawn } from "bun";`
Line 24: `const file = Bun.file(...)`

**Fix:**
1. Create `export const _reviewRunnerDeps = { spawn, file: Bun.file };`
2. Replace direct calls with deps references
3. Update any existing tests

---

## Task 2.3: `src/utils/git.ts` — Direct `Bun.spawn`

Line 23: `const proc = Bun.spawn(["git", ...args], { ... });`

**Fix:**
1. Create `export const _gitDeps = { spawn: Bun.spawn };`
2. Replace `Bun.spawn(...)` with `_gitDeps.spawn(...)`
3. Update any existing tests (git.ts is widely used — check test/unit/ for git tests)

---

## Task 2.4: `src/verification/smart-runner.ts` — Direct `Bun.Glob` + `Bun.file`

Line 88: `const glob = new Bun.Glob(pattern);`
Line 99: `content = await Bun.file(testFile).text();`

**Fix:**
1. Create `export const _smartRunnerDeps = { glob: (p: string) => new Bun.Glob(p), file: Bun.file };`
2. Replace direct calls with deps references
3. Update any existing tests

---

## Completion Checklist

- [ ] All 4 files have `_deps` objects exported
- [ ] No direct `Bun.spawn`, `spawn`, `Bun.file`, `Bun.Glob` calls remain in these files
- [ ] `bun run typecheck` — zero errors
- [ ] `bun run lint` — zero errors
- [ ] `bun test` — no regressions (run full suite with `--bail`)
- [ ] Commit: `refactor(deps): wrap Bun calls in injectable _deps (4 files)`
- [ ] Do NOT push to remote
