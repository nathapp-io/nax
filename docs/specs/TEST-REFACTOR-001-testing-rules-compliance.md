# TEST-REFACTOR-001: Test Suite Compliance with testing-rules.md

**Status:** In Progress — Session 1 running (Phase 1)  
**Date:** 2026-03-23  
**Branch:** fix/ci-test-resource-limits  
**Rules ref:** `docs/guides/testing-rules.md`

---

## Scope

29 files across 4 violation categories. All must be fixed to comply with the cross-agent test rules SSOT.

---

## Phase 1 — `mock.module()` (7 files) 🔴 CRITICAL

Leaks between ALL test files. Fix requires:
1. Add `_deps` injection to the **source** module being mocked
2. Update test to override `_deps` instead of calling `mock.module()`
3. Restore in `afterEach`

| Test file | Source module being mocked |
|:----------|:--------------------------|
| `test/unit/pipeline/storyid-events.test.ts` | pipeline event subscribers |
| `test/unit/pipeline/verify-smart-runner.test.ts` | smart runner |
| `test/unit/verification/smart-runner.test.ts` | smart runner |
| `test/unit/verification/rectification-loop.test.ts` | rectification loop |
| `test/unit/tdd/rectification-gate-session.test.ts` | session runner / gate |
| `test/unit/tdd/session-runner-keep-open.test.ts` | session runner |
| `test/integration/execution/runner-parallel-metrics.test.ts` | executor |

**Pattern to apply:**
```typescript
// ❌ BEFORE
mock.module("../../../src/utils/git", () => ({ captureGitRef: mock(() => "abc123") }));

// ✅ AFTER — in source file, export _deps:
export const _myDeps = { captureGitRef };

// ✅ AFTER — in test:
import { _myDeps } from "../../../src/utils/git";
let orig: typeof _myDeps.captureGitRef;
beforeEach(() => { orig = _myDeps.captureGitRef; _myDeps.captureGitRef = mock(() => "abc123"); });
afterEach(() => { _myDeps.captureGitRef = orig; mock.restore(); });
```

**Important:** If the source module already has a `_deps` export, use it — don't add a duplicate.

---

## Phase 2 — `Bun.sleep()` (10 files) 🟡

Replace with:
- `waitForFile(path, 500)` from `test/helpers/fs.ts` — when waiting for async file writes
- Injectable `_deps.sleep` — when testing timing/delay behaviour in source code

| File |
|:-----|
| `test/unit/pipeline/subscribers/reporters.test.ts` |
| `test/unit/pipeline/subscribers/interaction.test.ts` |
| `test/unit/pipeline/subscribers/events-writer.test.ts` |
| `test/unit/interaction/interaction-plugins.test.ts` |
| `test/unit/routing/strategies/llm.test.ts` |
| `test/unit/execution/parallel-executor-rectification.test.ts` |
| `test/unit/execution/crash-recovery.test.ts` |
| `test/unit/execution/lifecycle-completion.test.ts` |
| `test/unit/execution/timeout-handler.test.ts` |
| `test/integration/routing/plugin-routing-advanced.test.ts` |

**Pattern — file write wait:**
```typescript
// ❌ BEFORE
await Bun.sleep(50);
const content = await readFile(path, "utf8");

// ✅ AFTER
import { waitForFile } from "../../helpers/fs";
await waitForFile(path, 500);
const content = await readFile(path, "utf8");
```

**Pattern — testing delay logic:**
```typescript
// ❌ BEFORE (source uses Bun.sleep directly)
await Bun.sleep(delayMs);

// ✅ AFTER (source exposes _deps.sleep)
export const _myDeps = { sleep: (ms: number) => Bun.sleep(ms) };
// in source: await _myDeps.sleep(delayMs);
// in test: _myDeps.sleep = mock(async () => {}); // instant no-op
```

---

## Phase 3 — `Bun.spawn` for shell utilities (8 files) 🟡

Replace all `Bun.spawn(["mv",...])`, `Bun.spawn(["rm",...])`, `Bun.spawn(["mkdir",...])` with `node:fs/promises` APIs.

| File |
|:-----|
| `test/unit/cli/deprecation.test.ts` |
| `test/unit/cli/run-plan.test.ts` |
| `test/unit/analyze/analyze.test.ts` |
| `test/integration/context/context-integration.test.ts` |
| `test/integration/cli/cli-core.test.ts` |
| `test/integration/plan/plan.test.ts` |
| `test/integration/execution/execution.test.ts` |
| `test/integration/execution/progress.test.ts` |

**Pattern:**
```typescript
// ❌ BEFORE
await Bun.spawn(["mkdir", "-p", dir], { stdout: "pipe" }).exited;
await Bun.spawn(["mv", src, dest], { stdout: "pipe" }).exited;
await Bun.spawn(["rm", "-rf", dir], { stdout: "pipe" }).exited;

// ✅ AFTER
import { mkdir, rename, rm } from "node:fs/promises";
await mkdir(dir, { recursive: true });
await rename(src, dest);
await rm(dir, { recursive: true, force: true });
```

---

## Phase 4 — `execSync` + global `Bun.spawn` mutation (4 files) 🟡

### execSync (3 files)

These tests use `execSync` for real git operations. Fix: mock via `_deps` injection or replace with fake git output.

| File | Used for |
|:-----|:---------|
| `test/integration/worktree/manager.test.ts` | `git worktree add`, `git branch` |
| `test/integration/worktree/worktree-merge.test.ts` | `git merge`, `git branch` |
| `test/integration/execution/execution-isolation.test.ts` | git operations |

**Pattern:** Check if source module already has `_worktreeManagerDeps` or similar. If not, add injectable deps and mock in tests.

### Global `Bun.spawn` mutation (1 file)

| File | Issue |
|:-----|:------|
| `test/integration/cli/cli-precheck.test.ts` | `(Bun as any).spawn = mock(...)` without try/finally |

**Fix:** Use `_claudeAdapterDeps.spawn` if it exists (check `src/agents/adapters/claude.ts`). Wrap restore in `try/finally`.

---

## Execution Plan

### Session 1 — Phase 1 only (THIS SESSION)

Phase 1 is complex: requires source code changes (add `_deps` to src modules) + test updates.
Phases 2–4 are mechanical find-and-replace — handled in Session 2.

**Instructions for Claude (Session 1):**

1. Read `docs/guides/testing-rules.md` fully
2. Read `.claude/rules/03-test-writing.md` for the existing `_deps` table
3. Fix Phase 1 only — all 7 `mock.module()` files listed above
4. For each file:
   a. Find what module is being mocked with `mock.module()`
   b. Check if that source module already has a `_deps` export — if yes, use it; if no, add one
   c. Update the test to use `_deps` injection + restore in `afterEach` + `mock.restore()`
   d. Remove the `mock.module()` call
5. After all 7 files fixed, run targeted verification:
   ```bash
   NAX_SKIP_PRECHECK=1 bun test \
     test/unit/pipeline/storyid-events.test.ts \
     test/unit/pipeline/verify-smart-runner.test.ts \
     test/unit/verification/smart-runner.test.ts \
     test/unit/verification/rectification-loop.test.ts \
     test/unit/tdd/rectification-gate-session.test.ts \
     test/unit/tdd/session-runner-keep-open.test.ts \
     test/integration/execution/runner-parallel-metrics.test.ts \
     --timeout=60000
   ```
6. Then run full suite to catch regressions:
   ```bash
   NAX_SKIP_PRECHECK=1 bun test test/ --timeout=60000 --bail
   ```
7. Commit:
   ```
   refactor(tests): replace mock.module() with _deps injection (Phase 1, testing-rules.md)
   ```
8. Do NOT push to remote

### Session 2 — Phases 2+3+4 (pending Session 1 success)

Mechanical replacements: Bun.sleep → waitForFile, Bun.spawn shell utils → fs/promises, execSync → _deps, global Bun.spawn mutation → _deps.

---

## Success Criteria

- [ ] Zero `mock.module()` calls in test/
- [ ] Zero `Bun.sleep()` calls in test/ (except inside `test/helpers/fs.ts`)
- [ ] Zero `Bun.spawn(["mv"|"rm"|"mkdir"...])` calls in test/
- [ ] Zero `(Bun as any).spawn =` mutations in test/
- [ ] Zero `execSync` calls in test/integration/worktree/ and test/integration/execution/execution-isolation.test.ts
- [ ] Full suite: 4337+ pass, 0 fail
