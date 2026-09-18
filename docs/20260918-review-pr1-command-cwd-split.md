# Deep Code Review: PR1 Command-CWD Split — `feat/single-frame-pr1-command-cwd-split`

**Date:** 2026-09-18
**Reviewer:** Subrina (AI)
**Branch:** `feat/single-frame-pr1-command-cwd-split` (8 commits, 10 files, +604 / −65)
**Plan:** `docs/superpowers/plans/2026-09-18-single-frame-redesign/01-pr1-command-cwd-split.md`
**Base:** `origin/feat/single-frame-redesign` (remote design spec branch — `#2066 residual`)
**Verification:** typecheck ✓ | lint ✓ | test (unit+integration+ui) 19 768 pass / 0 fail / 43 skip | coverage 96.23% lines / 93.26% func / 0 files below floor

---

## Overall Grade: **A** (92/100)

A clean, well-scoped refactor that threads three values independently (`projectDir`, `codingToolPackageDir`, `commandCwd`), decouples `RunCommand`'s declared-branch cwd from `ctx.root`, and re-grounds declared-command resolution in `loadConfigForPackage` (the R4-mandated resolver). The branch delivers exactly what the plan specified, plus three defensible follow-up commits that the whole-branch review caught or pinned (load-failure fallback test, C1 worktree-prefix normalization, lost-comment docs). Type safety, DI seam, lint/typecheck/coverage gates all green. The remaining points are low-severity polish — the code is production-ready.

---

## Plan Adherence

| Plan Task | Commit | Status |
|:---|:---|:---|
| 1. Extract `call.ts`'s `runOptions` builder; thread `projectDir` + `codingToolPackageDir` | `863572c4a` | ✅ |
| 2. Add `codingToolPackageDir` to `AgentRunOptions` | `95b5c1b28` | ✅ |
| 3. Decouple `RunCommand`'s declared-branch cwd from `ctx.root` | `979c82b51` | ✅ |
| 4. Thread `commandCwd` through `buildCodingToolSupport` | `382508ab5` | ✅ |
| 5. Resolve declared commands per-package via `loadConfigForPackage`; compute `commandCwd` | `1c3ebc712` | ✅ |
| 6. Full verification gate | (none — gates run) | ✅ |
| Extra: pin load-failure fallback warning | `849869d00` | ✅ (defensive pin) |
| Extra: fix worktree-prefix normalization (C1) | `6f7d62fa0` | ✅ (real bug) |
| Extra: docs restoration | `0930fc8f2` | ✅ (lost-comment fix) |

The three "extra" commits each earn their keep:

- `849869d00` is the only test that asserts the warning shape (`storyId` first key, level `warn`, stage `tools`) — pinning the contract that `acceptance-setup.ts`'s own fallback pattern uses.
- `6f7d62fa0` is a real **C1** defect caught during this whole-branch review: a worktree-prefixed `packageDir` like `.nax-wt/US-001/packages/api` would miss the override lookup and silently fall back to the root config. Fix: `packageOverrideKey(packageDir)` normalizes the prefix for the override lookup only; `commandCwd` keeps the raw dir so commands still run inside the story's worktree. This is the kind of thing a one-off green CI run does NOT catch.
- `0930fc8f2` restores the providers-rationale comment that was lost during the `call.ts → call-run-options.ts` extraction.

---

## Findings

### 🔴 CRITICAL

None.

### 🟡 MEDIUM

None. (Several LOW items below; nothing blocks merge.)

### 🟢 LOW

#### LOW-1 · `src/agents/types.ts` is at 598/600 lines — single-line headroom
**Category:** STYLE
The new `codingToolPackageDir` JSDoc is appropriate (the explanation is load-bearing — under `storyIsolation: "worktree"` the value carries a `.nax-wt/<storyId>/` prefix and consumers must normalize differently for `override-key` vs `cwd` uses). But this puts `types.ts` at **598 lines against a 600-line hard cap**, after adding 34 lines on this PR alone. The file was ~568 before. The PR doesn't regress the cap, but the next field added to `AgentRunOptions` will. Worth noting because the plan did not flag this.

The `expr` is `git show 95b5c1b28 --stat` shows +30 lines in types.ts; `wc -l src/agents/types.ts` reports 598. Plan's "headroom" reasoning applied correctly to `call.ts` (600 → 575) but not surfaced for `types.ts`. Future tasks in this redesign should consider extracting the option interface (or splitting by concern — runtime vs. coder-config).

#### LOW-2 · `packageOverrideKey(".nax-wt")` silently returns `""`
**Category:** BUG (latent edge case)
**File:** `src/runtime/packages.ts:107-111`

```typescript
export function packageOverrideKey(packageDir: string): string {
  const segments = packageDir.split("/");
  if (segments[0] !== ".nax-wt") return packageDir;
  return segments.slice(2).join("/"); // ← packageDir === ".nax-wt" → [".nax-wt"].slice(2) → []
}
```

For the degenerate input `.nax-wt` (single segment, no story id), `slice(2)` yields `[]`, then `.join("/")` returns `""`. The `loadConfigForPackage(projectDir, "", ...)` call would then resolve the root config — silently.

Practically unreachable: `PackageView.packageDir` is sourced from `runtime.packages.resolve()` which is rooted at the workspace's actual package paths, never `.nax-wt` itself. The pre-existing `toOverrideKey` had the same shape, so this is not a regression — but the guard's documented "first path segment of `.nax-wt` is treated as the worktree prefix" suggests a single-segment input is intended to be invalid.

**Fix:** Guard against length < 2 explicitly, or document that the input must be a 2-segment-or-longer worktree prefix.
@design Decision could be: the function is pure-rewrite, not validator; callers (worktree/manager.ts, packages.resolve) are responsible for sane inputs. If the project takes that position, a `@design` annotation is appropriate. Otherwise a length check is two lines.

#### LOW-3 · `commandCwd` regresses for legacy callers that pass neither `projectDir` nor a non-empty `root`
**Category:** BUG (boundary condition)
**File:** `src/agents/coding-tool-support.ts:387-390`

```typescript
const commandCwd =
  projectDir !== undefined && projectDir.trim() !== ""
    ? packageWorkdir({ packageDir: packageDir ?? "", repoRoot: projectDir })
    : root;
```

When `projectDir` is unset AND `root` is `undefined`/`""`, `commandCwd` is `undefined`. This is the same behavior as Task 3's `opts.commandCwd ?? ctx.root` fallback chain — pre-PR1, `ctx.root` was always supplied and `commandCwd` didn't exist, so a missing root already throws via `buildCodingToolSupport`'s `CODING_TOOL_ROOT_MISSING` guard at `src/agents/coding-tool-support.ts:117-123`. The PR doesn't change that.

The subtle bit is the `packageDir ?? ""` fallback: for a root-package story where `codingToolPackageDir` is `""`, this calls `packageWorkdir({ packageDir: "", repoRoot: projectDir })` → returns `projectDir`. For a non-root package, it joins `repoRoot + packageDir`. Both correct.

**Fix:** None needed. The only way to reach the `undefined` branch is to also reach the existing `CODING_TOOL_ROOT_MISSING` throw. Documented in the function comment for clarity.

#### LOW-4 · Lost `nax#2115` rationale comment at the `codingToolFileOutput` producer site
**Category:** ENH / Documentation
**File:** `src/operations/call-run-options.ts:77`

The pre-refactor `call.ts` had:
```typescript
// nax#2115: the op's own declared output file; the policy exempts it from
// the nax-owned write refusal. See AgentRunOptions.codingToolFileOutput.
...(fileOutputPath !== undefined ? { codingToolFileOutput: fileOutputPath } : {}),
```

The extracted version drops the `nax#2115` reference at the producer. The issue number is still preserved on the consumer (`types.ts:228-232`), so traceability is intact — but a future reader chasing `nax#2115` will land in `types.ts` rather than the producer. Low-impact doc smell.

**Fix:** Restore the one-line comment on `call-run-options.ts:77`.

#### LOW-5 · `RunDispatchOptionsParams.pipelineStage` is **stricter** than the plan specified
**Category:** TYPE / positive deviation
**File:** `src/operations/call-run-options.ts:28`

Plan task 1.1 sample: `pipelineStage: string`. Implementation: `pipelineStage: PipelineStage` (a 9-string literal union from `config/permissions.ts:19-28`). This is a strictness tightening — `op.stage` IS `PipelineStage`, so all callers continue to typecheck. Worth noting because (a) it's a deviation from the plan's verbatim code and (b) it's the *right* deviation — `AgentRunOptions.pipelineStage` is also `PipelineStage` (`types.ts:145`).

#### LOW-6 · `_codingToolSupportDeps` is a module-level mutable export used for tests
**Category:** STYLE (test seam)
**File:** `src/agents/coding-tool-support.ts:269-272`

```typescript
/** Injectable deps for testability — mirrors the _agentManagerDeps pattern. */
export const _codingToolSupportDeps = {
  loadConfigForPackage,
};
```

This is consistent with the project's documented DI pattern (`_isolationDeps`, `_runnerDeps`, `_evidenceDeps`, `_coordinatorDeps`, etc.), and the test at `test/unit/agents/coding-tool-support.test.ts:542-581` uses it correctly (`try { ... } finally { restore }`). The project explicitly permits global mutable deps as the test seam of choice over `mock.module()`. Flagged for completeness — not an issue.

#### LOW-7 · `src/agents/coding-tool-support.ts` is one allowed entry in `check-no-silent-naxconfig-cast.sh`
**Category:** ENH (cast allow-list expansion)
**File:** `scripts/check-no-silent-naxconfig-cast.sh:32-38, 57`

The PR expands the per-file allow-list from 6 to 7 entries by adding `src/agents/coding-tool-support.ts` to cover the new `options.config as unknown as NaxConfig` cast. The accompanying inline documentation is thorough — explains RULING F2 (type lies, runtime carries full NaxConfig), what `loadConfigForPackage` reads off `from` (`profile`/`profileChain`), and the R4-mandated resolver choice.

The note in the script header — "NOTE: entries are matched per FILE, so a new cast added to an allow-listed file is also exempt. Tighten to a per-line ratchet if that becomes a problem." — is honest about the limit. No regression; the existing pattern is preserved. The natural next iteration would be a per-line ratchet (a list of `file:line` pairs), but that's a separate refactor.

#### LOW-8 · `packageOverrideKey` refactor lacks a dedicated unit test
**Category:** TEST coverage gap
**File:** `src/runtime/packages.ts:107-111`

The function was extracted (and `toOverrideKey` now delegates to it) but no direct unit test exercises the edge cases:
- `.nax-wt/US-001/packages/api` → `packages/api` ✅ (covered indirectly via the worktree-prefix integration test)
- `.nax-wt/US-001` → `` (empty) — see LOW-2; not covered
- `` → `` (early return)
- `packages/api` → `packages/api` (early return)
- `/abs/path` → `/abs/path` (early return)

The function is pure and 4 lines. A unit test pinning these four inputs would be 6 lines of test code, would localize the worktree-prefix logic (currently only reachable via integration through `resolveCodingToolSupport` + filesystem setup), and would catch regressions if `packageOverrideKey` ever needs to handle multi-level worktree prefixes or escape paths.

---

## Strengths (worth keeping in future PRs)

1. **Clean extraction with intentional friction release.** `call.ts` was at the 600-line cap. The refactor's *purpose* was to give headroom, and it does — 600 → 575 with a clean function extracted. The plan's analysis (`-35` net) is exactly what shipped.
2. **`_codingToolSupportDeps` test seam.** The load-failure test (which would otherwise require filesystem shenanigans to simulate) is one mutation + restore. Pattern matches the project's established convention exactly.
3. **Defensive `try`/`catch` + warn + fall back** for per-package config matches `acceptance-setup.ts`'s own recovery pattern, exactly as the global constraint required.
4. **Logger calls are properly structured.** The new `warn("tools", "Per-package config failed to load for dispatch — using root config", { storyId, packageDir, error })` puts `storyId` first — verified by the load-failure test which asserts `Object.keys(warning?.data ?? {})[0] === "storyId"`. Passes `check:logger-storyid`.
5. **The worktree-prefix fix (`6f7d62fa0`) is an exemplary reactive fix:** extracted `packageOverrideKey` to a single source of truth, kept `commandCwd` computing against the raw (prefixed) dir, added an integration test that asserts both behaviors simultaneously. The comment at `coding-tool-support.ts:319-323` explains *why* the two paths diverge.
6. **Test isolation.** `packageConfigCache.clear()` + `_clearRootConfigCache()` are called in `beforeEach` AND `afterEach`. The `NAX_GLOBAL_CONFIG_DIR` env var is saved/restored. The dep mutation is restored in `finally`. No leakage between tests.
7. **Conventional commits, one concern each.** Eight commits, eight concerns, all formatted with `(scope):` prefix. Matches repo style exactly.

---

## Verification Evidence

| Gate | Command | Result |
|:---|:---|:---|
| Typecheck | `bun run typecheck` | exit 0 |
| Lint (Biome + checks) | `bun run lint` | exit 0 — all 17 lint checks pass |
| Dispatch context | `bun run check:dispatch-context` | exit 0 |
| NaxConfig cast allow-list | `bun run check:naxconfig-cast` | exit 0 |
| Inline test mocks | `bun run check:test-mocks` | exit 0 |
| Test escape hatches | `bun run check:test-escape-hatches` | exit 0 |
| `as unknown as` test pattern | `bun run check:test-as-unknown-as` | exit 0 |
| Full test suite | `bun run test` | 19 768 pass / 0 fail / 43 skip / 41 387 expects |
| Coverage gate | `bun run test:coverage` | 96.23% lines / 93.26% func / **0 files below floor** |
| File sizes (600-line cap) | `bun run check:file-sizes` | 14 grandfathered, none added |
| Import cycles | `bun run check:import-cycles` | 0 modules |
| Targeted (call-run-options, run-command, coding-tool-support) | `bun test ...` | 98/98 pass |

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P3 | LOW-8 | S | Add a dedicated unit test for `packageOverrideKey` (4 edge cases, ~6 LOC). |
| P3 | LOW-2 | XS | Either add a `segments.length < 3` guard or a `@design` annotation documenting that callers must supply a real path. |
| P3 | LOW-4 | XS | Restore the one-line `nax#2115` comment at `call-run-options.ts:77`. |
| P3 | LOW-1 | — | File-size headroom for `types.ts` is shrinking; track in the next PR's plan. |

(No P0/P1/P2. The code is production-ready.)

---

## Plan↔Implementation Diff (informational)

| Plan said | Implementation did | Verdict |
|:---|:---|:---|
| `RunDispatchOptionsParams.pipelineStage: string` | `RunDispatchOptionsParams.pipelineStage: PipelineStage` | ✅ Stricter — improvement. |
| Plan Task 1.3: only the `packageWorkdir`/`storyExecRoot` import removed from `call.ts` | Implementation also moves `resolveDeclaredTools` import use — verified unused-only deletion | ✅ |
| `scripts/check-no-silent-naxconfig-cast.sh` not in plan | Implementation added a new allow-list entry with full justification | ✅ Plan-implicit; the global constraint permits the cast and the script enforces its placement. |
| Plan has 6 tasks → 6 commits | Branch has 8 commits | ✅ 3 extra commits (test pin, C1 fix, docs) all earned. |
| Plan Task 6 says "no commit" | Verification-only, no commit | ✅ |
