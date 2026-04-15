# ADR-009: Test File Pattern — Single Source of Truth

**Status:** Proposed
**Date:** 2026-04-15
**Author:** William Khoo, Claude
**Related:** FEAT-015 spec (`docs/specs/feat-015-test-file-pattern-detection.md`), Issue #461

---

## Context

The concept "is this a test file?" is answered in at least **eight independent places** in the nax codebase, each with its own representation:

| Site | Representation |
|:---|:---|
| `src/test-runners/detector.ts` | Hardcoded broad regex list |
| `src/test-runners/conventions.ts` | Glob suffix matching |
| `src/context/auto-detect.ts:175` | Inline `includes(".test.")` |
| `src/plugins/loader.ts:241` | Inline `.endsWith(".test.ts")` |
| `src/review/diff-utils.ts:165` | Hardcoded basename regex |
| `src/context/test-scanner.ts:130` | Hardcoded variant generation |
| `src/review/{semantic,adversarial}` — `excludePatterns` default | Hardcoded git pathspec list |
| `config.execution.smartTestRunner.testFilePatterns` | User-configurable glob array |

Two config keys encode "what is a test file" with different defaults and formats:

- `execution.smartTestRunner.testFilePatterns` — glob array, default `["test/**/*.test.ts"]`
- `context.testCoverage.testPattern` — single glob string, default `"**/*.test.{ts,js,tsx,jsx}"`

These can disagree. Four callers of `isTestFile()` in TDD and review code ignore config entirely even though `config` is in scope. The default patterns are TypeScript-centric and wrong for Go, Python, Rust, Java, and polyglot monorepos.

### Observed Failure

The ingredients are in place for silent-wrong-answer bugs:

1. **User sets `testFilePatterns: ["**/*.integration.ts"]`.** The classifier in `src/tdd/isolation.ts` still uses the broad regex and does not recognise `.integration.ts` as a test file. TDD isolation verification passes the implementer session modifying `.integration.ts` — "no test files touched" — when in fact the user considers those files tests.

2. **Review `excludePatterns` goes stale.** The user sets `testFilePatterns: ["**/*.integration.ts"]` but the hardcoded default `excludePatterns: [":!*.test.ts", ":!*.spec.ts", ...]` doesn't include `.integration.ts`. Integration tests are fed into the semantic review diff as if they were source code, wasting review tokens and generating spurious findings.

3. **Polyglot monorepo.** A repo with TS frontend + Go backend under one `.nax/config.json` cannot configure both languages correctly. Setting `testFilePatterns: ["**/*.test.ts", "**/*_test.go"]` classifies files in both packages, but any per-package nuance (e.g. Python service needing `test_*.py`) has no place to live.

4. **Two config keys.** A user who set `context.testCoverage.testPattern` (following old docs) is confused when their TDD isolation check behaves differently from their context coverage scanner. Neither config key's documentation mentions the other.

### The Underlying Rule

Test-file classification should have **one source of truth**, consulted by every site that asks "is this a test file?". The source must:

- Be user-configurable (explicit config wins)
- Produce every format the codebase already needs (glob / pathspec / regex / dir names)
- Support monorepo per-package overrides
- Auto-detect from project signals when the user has not chosen
- Never silently write to user config files

No ADR establishes this rule. Fixes have been applied site-by-site, and the codebase has drifted into the fragmented state documented above.

---

## Decision

Adopt a single rule for test-file classification:

> **All test-file classification flows through `resolveTestFilePatterns(config, packageDir?)`. The resolver returns `ResolvedTestPatterns`, which exposes glob / pathspec / regex / test-dir forms from one source. Inline test-file checks are forbidden.**

### The Resolution Chain

`resolveTestFilePatterns()` walks a fixed precedence order:

1. **Per-package config** — `.nax/mono/<packageDir>/config.json` if it has `testFilePatterns` set explicitly
2. **Root config** — `<workdir>/.nax/config.json` if it has `testFilePatterns` set explicitly
3. **Detection** — `detectTestFilePatterns(packageDir ?? workdir)` (stub in Phase 1, full in Phase 2)
4. **Fallback** — `DEFAULT_TEST_FILE_PATTERNS` (canonical glob default in `conventions.ts`)

The first non-empty, non-undefined result wins. An explicit empty array (`testFilePatterns: []`) is honoured as "no test files in this scope" — semantically distinct from omitted.

### The Three-Format Output

`ResolvedTestPatterns` is a single struct with four derived artefacts, all consistent with each other:

```typescript
interface ResolvedTestPatterns {
  readonly globs: readonly string[];          // **/*.test.ts
  readonly pathspec: readonly string[];       // :!*.test.ts
  readonly regex: readonly RegExp[];          // /\.test\.ts$/
  readonly testDirs: readonly string[];       // ["test", "__tests__"]
  readonly resolution: "per-package" | "root-config" | "detected" | "fallback";
}
```

Consumers pick the format they need; they never translate between formats themselves. `createTestFileClassifier(resolved)` returns a sync `(path) => boolean` for hot-path classification.

### User Override Always Wins

When the user sets a config key explicitly (any value, including `[]`), the resolver returns it **verbatim**. Detection does not override. Fallback does not override. This is the single inviolable rule that lets users reason about their configuration.

Corollary for `review.excludePatterns`: the default derives from `ResolvedTestPatterns.pathspec` + well-known test dirs + nax noise paths **only when `excludePatterns` is omitted**. Any user-set value (even `[]`) is returned as-is. This decouples "what is a test file" from "what should be excluded from review" — two related but distinct concepts.

### No Silent Config Writes

- Pipeline runs (`nax run`, `nax generate`) never write user config. Detection is ephemeral. Cache writes to `.nax/cache/` are permitted (gitignored, derived content).
- `nax detect` prints; does not write.
- `nax detect --apply` writes. Explicit opt-in. Monorepo mode writes per-package configs. `--force` overwrites existing user-explicit config; without `--force`, `--apply` is additive-only (writes only where the key is omitted).

### Config Key Consolidation

`context.testCoverage.testPattern` is deprecated and aliased to `execution.smartTestRunner.testFilePatterns` via a migration shim at the raw-JSON config layer. One config key for the concept, project-wide.

---

## Alternatives Considered

### A. Keep scattered classification, just add a new "canonical" helper

Leave existing inline checks; add `resolveTestFilePatterns()` as an opt-in helper. **Rejected.** The observed bugs stem from sites *not* consulting config. A new helper that remains optional does not close the loop — drift will re-emerge. The rule has to be "all sites go through the resolver", enforced by removing the inline alternatives.

### B. Single pattern format (globs only), translate at use sites

Store only globs in `ResolvedTestPatterns`; let callers translate to pathspec or regex as needed. **Rejected.** The translation logic is non-trivial (e.g. glob `**/*.test.ts` → pathspec `:!*.test.ts` involves suffix extraction and prefix inversion). Translating at each use site guarantees that some sites will do it wrong or inconsistently. Producing all formats from one source keeps them guaranteed-consistent and moves the translation logic into one testable place.

### C. Auto-detect always runs and silently persists

Detect on first run, write to `.nax/config.json` automatically. **Rejected.** Silent writes to user-tracked files create merge conflicts, confuse git-blame, and make it hard to explain "why did this line appear in my config?". Explicit `--apply` is a small user-facing cost that buys predictability.

### D. `excludePatterns` derived from `testFilePatterns` always (no user override of derivation)

Force `excludePatterns` to match `testFilePatterns` exclusion. **Rejected.** Users have legitimate reasons to include test files in review (integration-test coverage checks) or to exclude additional paths (vendor/, generated code). The two concepts overlap but are not the same. Deriving only when `excludePatterns` is omitted preserves the override while fixing the staleness bug.

### E. Per-file package discovery instead of `packageDir` parameter

Walk up from every classified file to find its package root. **Rejected for hot paths.** The resolver is async (reads files); calling it per file creates O(N) I/O. The `packageDir` parameter lets callers resolve once per story/package and classify many files synchronously. A `findPackageDir()` utility exists for cases where only a file path is known, but it is not the default path.

### F. New top-level config namespace (e.g. `testing.filePatterns`)

Introduce `testing.filePatterns` at config root and migrate both existing keys. **Rejected.** `execution.smartTestRunner.testFilePatterns` is already the more-used, better-named key. Introducing a third name for the same concept defeats the consolidation goal. Deprecation shim goes one direction only: legacy `testPattern` → `smartTestRunner.testFilePatterns`.

### G. Keep the broad regex in `detector.ts` indefinitely as a safety net

Leave `isTestFile(path)` (no-config form) working forever via hardcoded regex. **Rejected in the long run.** The broad regex IS an inline classifier — the exact pattern this ADR forbids. Compromise: keep it in Phase 1 as an unreachable backward-compat (all callers migrated to the classifier path); remove in Phase 2 once detection fallback guarantees the resolver always yields non-empty patterns.

---

## Consequences

### Positive

- **One mental model.** "Is this a test file?" has one answer per (config, packageDir) pair, consistent across TDD isolation, review exclude, context scanning, plugin loading, and autofix routing.
- **User config flows end-to-end.** Setting `testFilePatterns` affects every classification site. The silent-wrong-answer bugs listed in Context close.
- **Polyglot monorepos work.** Per-package `testFilePatterns` lives in `.nax/mono/<pkg>/config.json`. TS frontend and Go backend classify independently.
- **Safe migration.** TS default configs produce identical effective `excludePatterns` as before (parity proof in spec §4.4). No behavior change for existing users on default config.
- **Observability.** `ResolvedTestPatterns.resolution` field records which tier resolved the patterns. `nax detect` exposes the same information for debugging. Pipeline logs one info line per run showing the effective patterns + source tier.
- **Testability.** `_deps` injection points on resolver and detect modules eliminate the need for filesystem mocking in tests. Mirrors the existing project pattern.

### Negative / Trade-offs

- **Wider Phase 1 scope.** Fifteen-plus source files touched in one pass (spec §5). Regression risk is real. Mitigated by: the parity proof for TS default config (§4.4), per-site unit coverage, and the deprecation shim that keeps legacy configs working.
- **New config schema semantics.** `testFilePatterns`, `excludePatterns`, and legacy `testPattern` all become `.optional()` in Zod. Code that previously relied on the Zod default being present must now handle `undefined` via the resolver. Risk is contained to the migration — every caller is updated in Phase 1.
- **Runtime cost on cold detection.** Phase 2 detection adds filesystem walks (`git ls-files`, manifest reads). Cached after first run per workdir; mtime-invalidated. Cold cost ≤ 100ms on typical repos (spec §11). Acceptable next to existing pipeline startup cost.
- **Cache complexity.** `.nax/cache/test-patterns.json` introduces a new runtime artefact. Invalidation is mtime-based (simple and usually correct); edge cases (clock skew, network filesystems with lying mtimes) accept-the-risk with last-write-wins and on-corrupt-rebuild fallbacks. No file locking.
- **Users with custom `testFilePatterns` get behavior change in review.** Previously their integration tests were included in review diff (because default `excludePatterns` didn't know about custom patterns). After this change, custom patterns flow into derived `excludePatterns` and those tests are excluded. Documented in spec §10 as an **intentional bug fix**. Users who want the old behavior set `excludePatterns` explicitly.
- **`isTestFile(path)` (no-config) remains available in Phase 1.** The forbidden "inline classification" still exists in the type system as a backward-compat fallback. All first-party callers are migrated; a third-party plugin or agent writing new code could still call the wrong form. Phase 2 removes the footgun.

### Scope of Changes

| File | Change |
|:---|:---|
| `src/test-runners/resolver.ts` | **New.** `resolveTestFilePatterns()`, `resolveReviewExcludePatterns()`, `findPackageDir()`; exports `_resolverDeps`. |
| `src/test-runners/classifier.ts` | **New.** `createTestFileClassifier()`. |
| `src/test-runners/detect.ts` | **New.** Phase 1 stub; Phase 2 real detection. Exports `_detectDeps`. |
| `src/test-runners/conventions.ts` | Extend to produce pathspec + regex forms alongside globs. |
| `src/test-runners/detector.ts` | `isTestFile(path, patterns?)` — thin wrapper; broad regex kept as Phase 1 fallback, removed in Phase 2. |
| `src/config/schemas.ts` | `testFilePatterns`, `excludePatterns` (semantic + adversarial), `testPattern` → `.optional()`. |
| `src/config/migrations.ts` | **New.** Raw-JSON migration shim for legacy `testPattern`. Immutable. |
| `src/tdd/isolation.ts`, `session-runner.ts`, `rectification-gate.ts`, `orchestrator.ts` | Thread `ResolvedTestPatterns`; use classifier. |
| `src/review/semantic.ts`, `adversarial.ts`, `diff-utils.ts`, `orchestrator.ts`, `runner.ts` | Use `resolveReviewExcludePatterns()`; classifier for file classification; `resolved.regex` for basename stripping. |
| `src/pipeline/stages/autofix-adversarial.ts` | Classifier from `ctx.rootConfig`. |
| `src/context/auto-detect.ts`, `test-scanner.ts`, `greenfield.ts`, `builder.ts` | Replace inline checks with classifier; consume `resolved.globs`, `resolved.testDirs`. |
| `src/plugins/loader.ts` | `isPluginFile()` accepts classifier; `loadPlugins()` (called with config in scope) builds it. |
| `src/commands/detect.ts` | **New.** `nax detect [--apply] [--json] [--package] [--force]`. Phase 2. |
| `src/cli/index.ts` | Register `detect` command. Phase 2. |
| `docs/specs/feat-015-test-file-pattern-detection.md` | Full implementation spec. |
| `.claude/rules/forbidden-patterns.md` | Add: inline test-file classification outside `src/test-runners/` is forbidden. |

### Not Changed

- `src/test-runners/parser.ts` — parses test framework output format (e.g. "FAIL foo.test.ts:"), not file paths. Output parsing is framework-driven, unrelated to classification.
- `src/acceptance/test-path.ts` — generates the nax-owned `.nax-acceptance.test.<ext>` filename based on language. Different concept (canonical path for nax-generated tests, not classification of existing files).
- `src/analyze/scanner.ts` — display-only framework detection used by `nax analyze`. Could optionally consume detected patterns later; not required for this ADR.
- `src/debate/`, `src/tdd/cleanup.ts`, `src/verification/executor.ts` — no test-file classification occurs in these paths.

---

## References

- FEAT-015 spec — `docs/specs/feat-015-test-file-pattern-detection.md`
- Issue #461 — original proposal (unify `testFilePatterns`)
- `.claude/rules/project-conventions.md` — Bun-native, logging with `storyId`, 400-line limit
- `.claude/rules/forbidden-patterns.md` — `mock.module()` banned; `_deps` pattern required
- `.claude/rules/error-handling.md` — `NaxError` base class
- `.claude/rules/config-patterns.md` — Zod schema layering, config SSOT, compatibility shims
- ADR-005 — Pipeline re-architecture (precedent for SSOT patterns)
- ADR-008 — Session lifecycle (precedent for "one rule, per-role matrix" structure)
