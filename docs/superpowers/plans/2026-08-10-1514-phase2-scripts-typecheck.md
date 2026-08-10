# Issue #1514 Phase 2 — scripts/ typecheck gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 2 of issue #1514: fix two real `scripts/` bugs and gate `scripts/` in CI, leaving `test/` burn-down (Phase 3) and `tsconfig.test.json` wiring (Phase 4) for later branches.

**Architecture:** Add `tsconfig.scripts.json` (mirrors `tsconfig.dispatch-context.json`) + `scripts/check-scripts.sh` (mirrors `scripts/check-dispatch-context.sh`) + `check:scripts` script + `check:all` chain entry. Fix `scripts/release.ts:236` by removing the broken `.then()` call. Delete the dead `scripts/logging-formatter-demo.ts`.

**Tech Stack:** Bun 1.3.13, TypeScript 7.0.2, Biome (lint), `bun test`.

---

## File map

| Action | Path | Purpose |
|:---|:---|:---|
| Modify | `scripts/release.ts:236-244` | Realign to `.text()` returning sync `string` |
| Delete | `scripts/logging-formatter-demo.ts` | Dead file, broken imports |
| Create | `tsconfig.scripts.json` | Typecheck config for `scripts/` only |
| Create | `scripts/check-scripts.sh` | CI gate wrapper |
| Modify | `package.json` | Add `check:scripts` script + append to `check:all` |

No source file changes. No test file changes (existing `check:gate-reachability` test auto-covers wiring).

---

### Task 1: Verify the release.ts TypeScript errors before fixing

**Files:** none (verification only)

- [ ] **Step 1: Reproduce the TS errors**

Run: `rtk bun x tsc --project tsconfig.test.json --noEmit 2>&1 | grep "scripts/release.ts"`
Expected: exactly two lines — `error TS2339` and `error TS7006` both pointing at `scripts/release.ts:240`

- [ ] **Step 2: Confirm the runtime throw**

Run:
```bash
rtk bun -e 'import { $ } from "bun"; try { (await $\`echo world\`).text().then((t:string)=>t.trim()) } catch (e) { console.log((e as Error).message) }'
```
Expected: `(...).text().then is not a function.` (or similar `TypeError` text)

These two confirmations establish the baseline that the following fix must remove.

---

### Task 2: Fix `scripts/release.ts` result handling

**Files:** Modify `scripts/release.ts:235-244`

- [ ] **Step 1: Replace the broken `.then()` chain with synchronous `.text().trim()`**

Old (lines 235-244):
```ts
  try {
    const prUrl = (
      await $`gh pr create --title ${prTitle} --body ${prBody} --base main --head ${branchName} --label skip-changelog`
    )
      .text()
      .then((t) => t.trim());
    console.log(`\n✅ PR created: ${await prUrl}`);
  } catch (e) {
    console.warn(`   ⚠️  Could not create PR via gh CLI. Push succeeded — create PR manually.`);
  }
```

New:
```ts
  try {
    const result = (
      await $`gh pr create --title ${prTitle} --body ${prBody} --base main --head ${branchName} --label skip-changelog`
    );
    const prUrl = result.text().trim();
    console.log(`\n✅ PR created: ${prUrl}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`   ⚠️  gh pr create failed: ${msg}. Push succeeded — create PR manually.`);
  }
```

Three changes:
1. `.text().then((t) => t.trim())` → `result.text().trim()` — `.text()` returns `string` synchronously, so call `.trim()` directly on it.
2. Drop the spurious `await prUrl` in the success line — `prUrl` is now a `string`, not a `Promise<string>`.
3. Narrow the `catch` from "swallow everything and print a generic message" to "include the actual error message", so a genuine `gh` CLI failure surfaces its real reason instead of being misreported as a result-handling bug.

- [ ] **Step 2: Confirm TS errors disappear**

Run: `rtk bun x tsc --project tsconfig.test.json --noEmit 2>&1 | grep "scripts/release.ts"`
Expected: no output (the two errors are gone)

- [ ] **Step 3: Smoke-check runtime behavior in isolation**

Run:
```bash
rtk bun -e 'import { $ } from "bun"; const out = (await $\`echo https://example.test\`).text().trim(); console.log("OUT:", JSON.stringify(out));'
```
Expected: `OUT: "https://example.test"` — confirms the `.text().trim()` shape works.

Note: do not attempt to run `scripts/release.ts` end-to-end. It mutates git state and pushes a branch.

- [ ] **Step 4: Commit**

```bash
rtk git add scripts/release.ts
rtk git commit -m "fix(scripts): repair release.ts result handling after gh pr create"
```

---

### Task 3: Delete `scripts/logging-formatter-demo.ts`

**Files:** Delete `scripts/logging-formatter-demo.ts`

- [ ] **Step 1: Confirm file is unreferenced**

Run: `grep -r "logging-formatter-demo" --include="*.ts" --include="*.sh" --include="*.json" --include="*.md" . 2>&1 | grep -v "^./node_modules" | grep -v "^./docs/superpowers/plans"`
Expected: no output. The file is orphaned.

- [ ] **Step 2: Delete the file**

Run: `rm scripts/logging-formatter-demo.ts`

- [ ] **Step 3: Confirm TS errors specific to that file disappear**

Run: `rtk bun x tsc --project tsconfig.test.json --noEmit 2>&1 | grep "logging-formatter-demo"`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
rtk git add -u scripts/logging-formatter-demo.ts
rtk git commit -m "chore(scripts): remove orphaned logging-formatter-demo (broken imports)"
```

---

### Task 4: Create `tsconfig.scripts.json`

**Files:** Create `tsconfig.scripts.json`

- [ ] **Step 1: Write the config**

Create `tsconfig.scripts.json` with:
```json
{
  "extends": "./tsconfig.json",
  "include": ["scripts/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"],
  "compilerOptions": {
    "noEmit": true,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false,
    "types": ["bun-types"]
  }
}
```

The `exclude: ["node_modules", "dist", "test"]` matches `tsconfig.dispatch-context.json` (excluding `test` prevents overlap with the future test burn-down in Phase 3, which gets its own `tsconfig.test.json`).

- [ ] **Step 2: Sanity check — does it typecheck cleanly?**

Run: `rtk bun x tsc --project tsconfig.scripts.json --noEmit 2>&1 | tail -5`
Expected: no errors (after Tasks 2 and 3 are complete). If any remain, STOP — investigate before adding the gate.

- [ ] **Step 3: Commit**

```bash
rtk git add tsconfig.scripts.json
rtk git commit -m "chore(tsconfig): add tsconfig.scripts.json (scripts/ typecheck config)"
```

---

### Task 5: Create `scripts/check-scripts.sh`

**Files:** Create `scripts/check-scripts.sh`

- [ ] **Step 1: Write the gate script**

Create `scripts/check-scripts.sh` with:
```bash
#!/bin/bash
# Issue #1514 Phase 2 gate: scripts/ tree must typecheck cleanly.
# Mirrors scripts/check-dispatch-context.sh.
set -euo pipefail

bun x tsc --project tsconfig.scripts.json --noEmit

echo "OK: scripts/ typecheck passes."
```

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/check-scripts.sh`

- [ ] **Step 3: Smoke-run it directly**

Run: `bash scripts/check-scripts.sh`
Expected: outputs `OK: scripts/ typecheck passes.` and exits 0.

- [ ] **Step 4: Commit**

```bash
rtk git add scripts/check-scripts.sh
rtk git commit -m "ci(scripts): add check-scripts gate"
```

---

### Task 6: Wire `check:scripts` into `package.json`

**Files:** Modify `package.json`

- [ ] **Step 1: Read current `check:all` and adjacent scripts**

Open `package.json`. Find the line:
```
"check:runtime-cleanup": "bash scripts/check-runtime-cleanup.sh",
```
and the `check:all` chain line:
```
"check:all": "bun run lint && bun run check:test-mocks && bun run check:process-cwd && bun run check:no-adapter-wrap && bun run check:dispatch-context && bun run check:naxconfig-cast && bun run check:runtime-cleanup && bun run check:adapter-no-config-import && bun run check:gate-reachability",
```

- [ ] **Step 2: Add the `check:scripts` script entry**

Add immediately after the `check:runtime-cleanup` line:
```json
    "check:scripts": "bash scripts/check-scripts.sh",
```

(Note: order is alphabetical among `check:s*` entries — `check:scripts` lands right before `check:test-mocks`.)

- [ ] **Step 3: Append `check:scripts` to `check:all`**

Change the `check:all` line to insert `&& bun run check:scripts` immediately before `&& bun run check:dispatch-context`. Resulting chain:
```json
    "check:all": "bun run lint && bun run check:test-mocks && bun run check:process-cwd && bun run check:no-adapter-wrap && bun run check:scripts && bun run check:dispatch-context && bun run check:naxconfig-cast && bun run check:runtime-cleanup && bun run check:adapter-no-config-import && bun run check:gate-reachability",
```

Reasoning: `check:scripts` is sibling to `check:dispatch-context` (both are tsc-project gates); placing them adjacent makes related gates stay grouped.

- [ ] **Step 4: Verify the gate is reachable**

The existing `check:gate-reachability` test verifies every script in `package.json` that is reachable from `check:all` and `typecheck` (with a curated allowlist) is actually invoked. Run:
```bash
rtk bun test test/unit/scripts/check-gate-reachability.test.ts --timeout=30000
```
Expected: all tests pass. If a test fails saying `check:scripts` is unreachable, the order in `check:all` is wrong — re-check Step 3.

- [ ] **Step 5: Run `check:all` end-to-end**

Run: `rtk bun run check:all 2>&1 | tail -20`
Expected: ends with `OK: scripts/ typecheck passes.` (or similar final OK line from each gate) and exit 0.

- [ ] **Step 6: Run `typecheck` to confirm no regression**

Run: `rtk bun run typecheck`
Expected: exits 0 with no errors. (This step is regression coverage — confirms the top-level `typecheck` still passes; it does NOT include scripts/ which is intentional.)

- [ ] **Step 7: Commit**

```bash
rtk git add package.json
rtk git commit -m "ci: wire check:scripts into check:all (issue #1514 phase 2)"
```

---

### Task 7: Final verification — full quality gates

**Files:** none

- [ ] **Step 1: Run the full quality gate pipeline**

Run each:
```bash
rtk bun run build
rtk bun run typecheck
rtk bun run lint
rtk bun run check:all
```
Expected: all four exit 0.

- [ ] **Step 2: Run unit-test suite**

Run:
```bash
rtk bun test test/unit/ --timeout=60000 --bail
```
Expected: all unit tests pass. (`scripts/` change does not affect tests; typecheck-only work.)

- [ ] **Step 3: Confirm scripts/ typecheck gate**

Run: `rtk bun x tsc --project tsconfig.scripts.json --noEmit 2>&1 | wc -l`
Expected: `0` (zero lines of output).

- [ ] **Step 4: Verify issue #1514 progress is incomplete (this branch is Phase 2 only)**

Run:
```bash
rtk bun x tsc --project tsconfig.test.json --noEmit 2>&1 | grep -c "error TS"
```
Expected: still ~2140 (after subtracting the 2 release.ts errors + 3 logging-formatter-demo errors → ~2135 errors remain in test/). The full burn-down is Phase 3 and is intentionally out of scope.

---

### Task 8: Update issue #1514 with Phase 2 progress

**Files:** none (uses `gh`)

- [ ] **Step 1: Post progress comment**

Run:
```bash
rtk gh issue comment 1514 --repo nathapp-io/nax --body "Phase 2 shipped on branch \`fix/1514-wire-tsconfig-test\`:
- \`scripts/release.ts\` — fixed \`.text().then(...)\` runtime TypeError (was misleading logging on every release since the code shipped).
- \`scripts/logging-formatter-demo.ts\` — deleted (file was orphaned, all imports broken since the \`src/logger/\` move).
- \`tsconfig.scripts.json\` + \`scripts/check-scripts.sh\` + \`check:scripts\` in \`check:all\` — \`scripts/\` now typechecks in CI.
- Phase 1 (stale comment) was already shipped in #1515.
- \`scripts/\` is 0/0 errors. \`test/\` burn-down (Phase 3) and \`tsconfig.test.json\` wiring (Phase 4) remain on a separate branch."
```

- [ ] **Step 2: Confirm commit shows up**

Run: `rtk git log --oneline main..HEAD`
Expected: 5 commits (one per task) plus any merge base. Each commit's title should match the title from its task.

---

### Task 9: Push branch (do NOT open PR — user does that)

**Files:** none

- [ ] **Step 1: Push**

Run: `rtk git push -u origin fix/1514-wire-tsconfig-test`
Expected: branch published, output ends with `* [new branch] fix/1514-wire-tsconfig-test -> fix/1514-wire-tsconfig-test`.

- [ ] **Step 2: Confirm remote tracking**

Run: `rtk git log --oneline origin/main..HEAD`
Expected: 5 commits ahead of main, no divergence warnings.

---

## Self-review

**Spec coverage:** Each design item from the prior brainstorming session is covered:
- A. release.ts fix → Task 2
- B. Delete demo → Task 3
- C. tsconfig.scripts.json → Task 4
- D. check-scripts.sh → Task 5
- E. Wire into package.json → Task 6
- F. Document Phase boundaries → Task 8

**Placeholders:** None — every code change shows the full replacement, every shell command is exact.

**Type consistency:** `result.text().trim()` produces `string` (matches console.log template); `prUrl` is then `string` (not `Promise<string>`), the `await prUrl` is correctly removed.

**Risk note:** Task 7 step 4 is the only step that intentionally confirms we are NOT done. It proves Phase 3/4 boundary. This is a deliberate "leave the door open for Phase 3" check.
