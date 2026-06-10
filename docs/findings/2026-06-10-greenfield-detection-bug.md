# Greenfield Detection Bug — 2026-06-10

## Summary

The greenfield gate reported "no pre-existing tests" even after the TDD test-writer
had created test files, causing the orchestrator to short-circuit with a terminal
phase failure. The first pass (Root Causes 1–3) fixed the path-matching and Bun-native
violations. A follow-up pass (Root Cause 4, **revised**) standardised *which test-file
patterns* greenfield detection uses, so the routing pre-check, the orchestrator
greenfield gate, and test-writer isolation all classify test files identically through
the ADR-009 SSOT (`resolveTestFilePatterns`).

---

## Root Cause 1 — `scanForTestFiles` tested filename, not relative path

**File:** `src/context/greenfield.ts`

`scanForTestFiles` matched regex patterns against `entry.name` (just the filename, e.g.
`"foo.test.ts"`) but `globsToTestRegex` produces path-aware regexes anchored with
`(?:^|/)`. Patterns with a directory component (e.g. `test/**/*.test.ts`) never matched
a bare filename.

**Effect:** Any project using the default `test/**/*.test.ts` pattern saw the greenfield
gate fail to find tests under `test/`.

**Fix:** Classify against the **relative path** (`git ls-files` output / `Bun.Glob`
relative paths), not `entry.name`.

---

## Root Cause 2 — Bun-native + scan-logic duplication in `greenfield.ts`

**File:** `src/context/greenfield.ts`

`scanForTestFiles` used `readdir` from `node:fs/promises` (forbidden) and duplicated
directory-scanning logic.

**Fix:** Replaced with `git ls-files` → `isTestFileByPatterns` (the established pattern
used by `auto-detect.ts` and `isolation.ts`), with a `Bun.Glob` fallback for non-git
workdirs.

---

## Root Cause 3 — `IGNORE_DIRS` was TypeScript-centric

**File:** `src/context/greenfield.ts`

The ignored-directory set (used only by the non-git `Bun.Glob` fallback) was missing
output/dependency dirs for Go, Python, Rust, and Java. `build/` was removed from the
ignore list because it is a legitimate source package name in Go and Rust.

**Fix:** Expanded `IGNORE_DIRS` to cover JS/TS, Go (`vendor`), Python
(`__pycache__`, `.venv`, …), Rust/Java/Gradle (`target`, `.gradle`, `out`), and universal
(`tmp`, `temp`, `.git`).

---

## Root Cause 4 — Three test-detection sites used divergent pattern sources (REVISED)

**Files:** `src/pipeline/stages/routing.ts`, `src/operations/write-test.ts`,
`src/execution/plan-inputs.ts`, `src/context/greenfield.ts`,
`src/test-runners/conventions.ts`, `src/test-runners/index.ts`, `src/utils/paths.ts`

The original pass introduced a **fourth competing pattern constant**,
`GREENFIELD_FALLBACK_PATTERNS` (broad polyglot), and had the routing pre-check and
test-writer isolation each hand-roll a read of `execution.smartTestRunner.testFilePatterns`
with **different fallbacks**. The result: three sites that could disagree.

| Site | Pattern source (before) | Fallback (before) |
|:-----|:------------------------|:------------------|
| Routing greenfield pre-check (`routing.ts`) | inline config read | `GREENFIELD_FALLBACK_PATTERNS` (broad) |
| `greenfieldGateOp` (orchestrator) | ✅ `resolveTestFilePatterns()` → `.globs` | `DEFAULT_TEST_FILE_PATTERNS` |
| Test-writer isolation (`write-test.ts`) | inline config read | `DEFAULT_TEST_FILE_PATTERNS` |

This violates `monorepo-awareness.md` §C ("one source of truth per concept") and ADR-009.
The orchestrator gate already did the right thing; the other two bypassed the SSOT.

**Revised fix — collapse all three onto `resolveTestFilePatterns()`:**

1. **Routing pre-check** now resolves patterns via the SSOT (same call shape the gate
   uses) and passes `.globs` to `isGreenfieldStory`. Its detection tier
   (`detectTestFilePatterns`) discovers pre-existing tests across languages from
   `git ls-files`.
2. **`plan-inputs.ts`** threads its already-resolved `resolvedTestPatterns` (the SAME
   object the greenfield gate receives) into `testWriterInput`. Isolation consumes
   `.globs`, so isolation and the gate classify test files identically.
3. **`isGreenfieldStory`** now defaults to `DEFAULT_TEST_FILE_PATTERNS` (signature parity
   with `verifyTestWriterIsolation`); `GREENFIELD_FALLBACK_PATTERNS` is **deleted**.
4. The duplicated `packageDirRelative(projectDir, workdir)` computation is extracted into
   one helper in `src/utils/paths.ts`, shared by routing and plan-inputs so both resolve
   patterns against an identical package anchor.

**Behavioural note:** In production (git repo) the detection tier finds pre-existing tests
anywhere, so behaviour is preserved. The only change is the *no-config* fallback, which
narrows from broad polyglot to `DEFAULT_TEST_FILE_PATTERNS` — intentional, for parity with
isolation. Detection (not a hardcoded broad constant) is the SSOT for polyglot coverage.

---

## Log Signature

```
{"stage":"tdd","message":"Session complete: test-writer", ...}
{"stage":"tdd","message":"Isolation maintained", ...}
{"stage":"story-orchestrator","message":"Greenfield-gate: no pre-existing tests — greenfield run, pausing TDD test-writer", ...}
{"stage":"story-orchestrator","message":"Short-circuiting on phase failure", ...}
{"stage":"story-orchestrator","message":"Terminal phase failure (post-rectification resume — bypasses rectification)", ...}
```

"Isolation maintained" means the test-writer correctly limited itself to test files only
(role isolation check) — unrelated to whether the files were written to disk.

---

## Files Changed

| File | Change |
|:-----|:-------|
| `src/context/greenfield.ts` | `git ls-files` + `isTestFileByPatterns`, Bun.Glob fallback, expanded `IGNORE_DIRS`; default patterns → `DEFAULT_TEST_FILE_PATTERNS` (parity with isolation) |
| `src/pipeline/stages/routing.ts` | Greenfield pre-check resolves via `resolveTestFilePatterns()` SSOT and passes `.globs` |
| `src/execution/plan-inputs.ts` | Use shared `packageDirRelative`; thread `resolvedTestPatterns` into `testWriterInput` |
| `src/operations/write-test.ts` | `TestWriterInput.resolvedTestPatterns`; isolation `verify` consumes `.globs` (drops inline config read) |
| `src/utils/paths.ts` | New `packageDirRelative(projectDir, workdir)` helper — SSOT for the resolver's package anchor |
| `src/test-runners/conventions.ts` | **Removed** `GREENFIELD_FALLBACK_PATTERNS` (competing SSOT) |
| `src/test-runners/index.ts` | Removed barrel export for `GREENFIELD_FALLBACK_PATTERNS` |
| `test/unit/pipeline/greenfield.test.ts` | Co-located-src cases pass resolved globs; added DEFAULT-fallback parity test |
| `test/unit/pipeline/stages/routing-greenfield-monorepo.test.ts` | Stub `resolveTestFilePatterns` to broad globs (isolates fs-scoping under test) |
| `test/integration/routing/routing-stage-greenfield.test.ts`, `routing-stage-final-state.test.ts` | Configure co-located `testFilePatterns` (resolver tier-2) |
