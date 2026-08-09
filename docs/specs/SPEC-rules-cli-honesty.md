# SPEC: Rules CLI Honesty

## Summary

`nax rules migrate --dry-run` and `nax rules lint` each report outcomes they did not earn: the dry run announces writes that a real run would skip, the linter hides every rule root after the first failing one, and a repository with no canonical rules at all is reported as a clean pass. This spec makes each command's report match what actually happened — the migration preview is derived from the same decision function the real run executes, the linter reports every root and fails only when a root genuinely failed to load, and an empty rules store is surfaced as a warning instead of a pass.

## Motivation

Three defects, all verified against `main` @ `832bdf41`:

1. **The dry run is not a preview.** `rulesMigrateCommand` guards its overwrite check with `!options.dryRun` (`src/cli/rules.ts:558`), so under `--dry-run` the existing-target check never runs. Every source prints `[dry-run] Would write <file>`, including files a real run would answer with `[skip] <file> already exists`. The same branch counts those files in `written`, and the trailing summary is suppressed entirely under dry run (`src/cli/rules.ts:579`). The mode whose only purpose is to predict the real run is the one mode that cannot.

2. **One failing rule root hides all later roots.** `rulesLintCommand` calls `await deps.loadCanonicalRules(root)` inside its root loop with no error handling (`src/cli/rules-lint.ts:157`). `loadCanonicalRules` throws on a neutrality violation or an unknown frontmatter key, so in a repository with package overlays the first bad root aborts the command and every later root goes unlinted — the operator fixes one violation, re-runs, and discovers another, one root at a time.

3. **An empty rules store reports as a pass.** When no root yields any rule file, the command prints `[OK] Canonical rules lint passed (0 file(s) across repo root)` (`src/cli/rules-lint.ts:208`). A repository that never migrated and a repository whose rules store was deleted both read as clean. `nax rules export` already treats this condition as an error (`RULES_EXPORT_NO_CANONICAL_RULES`, `src/cli/rules.ts:322`); the linter is the inconsistent one.

The common failure is a report that is not derived from the work. This spec fixes the derivation, not the wording.

## Design

### Integration

Verified symbols and signatures (read on `main` @ `832bdf41`):

| Symbol | Location | Current shape |
|:--|:--|:--|
| `rulesMigrateCommand` | `src/cli/rules.ts:528` | `(options: RulesMigrateOptions) => Promise<void>`; reads `_rulesCLIDeps` at module scope |
| `_rulesCLIDeps` | `src/cli/rules.ts` | Injectable dependency record exposing `readFile`, `writeFile`, `fileExists`, `globInDir`, `mkdir`, `loadCanonicalRules`, `getLogger` |
| `collectMigrationSources` | `src/cli/rules.ts:532` (call site) | Returns entries of `{ sourcePath, targetFileName, content }` |
| `rulesLintCommand` | `src/cli/rules-lint.ts:137` | `(options: RulesLintOptions, deps: RulesLintDeps = _rulesLintDeps) => Promise<void>` |
| `RulesLintDeps` | `src/cli/rules-lint.ts:124` | `globCanonicalRuleFiles`, `loadCanonicalRules`, `globHasMatch`, `getLogger`, `discoverWorkspacePackages` |
| CLI wrapper | `bin/nax.ts:1731-1736` | `await rulesLintCommand(...)` inside `try`/`catch`; the catch prints `Error: <message>` and calls `process.exit(1)` |

Patterns mirrored: dependency injection through an exported `_deps` record (the existing `_rulesCLIDeps` / `_rulesLintDeps` convention); `NaxError` with a machine-readable code plus a `stage` context field, per `error-handling.md`; same-directory leaf imports between CLI modules (`src/cli/rules.ts` already imports `./rules-lint` directly), so the new planner module is imported the same way rather than through a barrel.

Novel shape: none. The planner is a pure function in a codebase full of them, and its dependency (`fileExists`) is injected exactly as the existing CLI deps are.

**Size constraints — binding on this work.** `src/cli/rules.ts` is 587 lines against the 600-line source limit, which is why the planner lands in a new module rather than in place. `test/unit/cli/rules.test.ts` is 753 lines and `test/unit/cli/rules-lint.test.ts` is 726 lines, both against the 800-line test limit; neither may absorb this spec's tests. Each story authors its tests in the new test files named under `Creates`.

### Approach

The migration's write-or-skip decision moves into one pure function, `planMigration`, which both the dry run and the real run consume. The preview then equals the real run by construction rather than by two branches that must be kept in agreement — the arrangement that produced defect 1.

The linter keeps its loop in place. Its fix is per-root error isolation plus an explicit exit contract, not a restructure; `src/cli/rules-lint.ts` is 210 lines and under no size pressure, so extracting it would be refactoring unrelated to the goal.

**Contracts introduced.** `src/cli/rules-migrate-plan.ts` exports `planMigration` plus the two record types its callers read:

- `MigrationPlanEntry` — `sourcePath`, `targetFileName`, `targetPath`, `content`.
- `MigrationPlan` — `writes: MigrationPlanEntry[]`, `skips: MigrationPlanEntry[]`. Every source lands in exactly one of the two lists.
- `planMigration(sources, options)` where `options` carries `targetDir`, `force`, and an injected `fileExists(path) => Promise<boolean>`; returns `Promise<MigrationPlan>`.

`rulesMigrateCommand` widens from `Promise<void>` to `Promise<MigrationOutcome>`, where `MigrationOutcome` carries `written: string[]` and `skipped: string[]` — target file names, in source order. Widening a `void` return is safe for existing callers: `bin/nax.ts` awaits and discards it, and no existing test asserts on the returned value. This is the assertion surface US-001 AC-4, AC-5 and AC-6 use, so the outcome is observable without capturing stdout.

**Convention notes for the implementer.** New per-file and summary lines use `console.log`, matching every other line this CLI already prints (`src/cli/rules.ts`, `src/cli/rules-lint.ts`); the "no `console.log` in source" rule is scoped to non-CLI code, and no existing rules-CLI output routes through the logger. Rule-level warnings continue to go through the injected logger. Tests use `makeLogger()` from `test/helpers` rather than an inline logger mock, per `test-helpers.md`.

**No public symbol is removed.** Moving the write-or-skip branch out of `rulesMigrateCommand` is an internal relocation; `bun run typecheck` and `bun run lint` cover it. There is no deletion story.

### CLI Behavior

**Exit codes.** `nax rules lint` exits non-zero only when a rule root fails to load, exactly as it does today via the uncaught loader throw. Warnings — inert `paths:`, dead `appliesTo:` globs, displaced frontmatter, and the new empty-store warning — continue to exit 0. No new flags are introduced.

**Streams.** Rule-level warnings go to the injected logger, as today. Per-file progress lines and the trailing summary go to stdout via `console.log`, as today. Errors reaching `bin/nax.ts` are printed to stderr by the existing wrapper.

**Output — `nax rules migrate --dry-run`** (target `error-handling.md` already present, `config-patterns.md` absent):

```
[dry-run] Would skip error-handling.md (already exists; use --force to overwrite)
[dry-run] Would write config-patterns.md from .claude/rules/config-patterns.md (2 replacements)

Dry run: 1 file(s) would be written, 1 skipped.
```

The same inputs without `--dry-run`:

```
[skip] error-handling.md already exists (use --force to overwrite)
[OK] config-patterns.md <- .claude/rules/config-patterns.md (2 replacements)

Migration complete: 1 file(s) written, 1 skipped.
```

**Output — `nax rules lint` with an empty store:**

```
[WARN] Canonical rules lint completed with 1 warning(s) (0 file(s) across repo root).
```

**Output — `nax rules lint` with one failing root of two:** every warning from the healthy root is emitted first, then the command exits 1 with `Error: Canonical rules failed to load in 1 of 2 rule root(s): <root>`.

### Failure Handling

| Condition | Behaviour |
|:--|:--|
| A rule root's `loadCanonicalRules` rejects | Record the root and its cause, continue linting remaining roots, then reject once with a `NaxError` coded `RULES_LINT_ROOT_FAILED` naming every failed root. Exit 1 through the existing `bin/nax.ts` catch. |
| Every root loads, warnings emitted | Resolve normally; `[WARN]` summary; exit 0. Unchanged. |
| Every root loads, zero rule files in total | Emit an empty-store warning through the logger so the summary is the `[WARN]` form; resolve normally; exit 0. |
| Migration target exists and `--force` absent | Reported as skipped and not written, identically under `--dry-run` and a real run. |

## Out of Scope

- Adding a `--check`, `--strict`, or `--json` flag to `nax rules lint` for CI gating is out of scope; the command keeps its current flag surface.
- Making lint warnings produce a non-zero exit code is out of scope; only a rule root that fails to load exits non-zero.
- Distinguishing "no rules directory exists" from "a rules directory exists but holds no rule files" is out of scope; both conditions produce the same empty-store warning.
- Changing `nax rules export` is out of scope; it already rejects an empty canonical store and its `--check` already compares generated content against disk.
- Wiring `nax rules lint` into `bun run lint`, git hooks, or CI is out of scope.
- Broadening `nax rules migrate` source discovery to `AGENTS.md`, `.cursorrules`, `.cursor/*.mdc`, or `@`-include inlining is out of scope.
- US-002 only: the existing fail-open behaviour when `discoverWorkspacePackages` rejects is unchanged and is not re-verified by this spec.

## Stories

**US-001** — Migration preview equals the real run

Extract the write-or-skip decision into `planMigration` in a new module, have `rulesMigrateCommand` execute the plan it returns, and make `--dry-run` render that same plan. Skipped targets stop counting as written, and the completion summary prints in both modes.

Context Files: `src/cli/rules.ts`, `test/unit/cli/rules.test.ts`
Creates: `src/cli/rules-migrate-plan.ts`, `test/unit/cli/rules-migrate-plan.test.ts`, `test/unit/cli/rules-migrate-parity.test.ts`

**US-002** — The linter reports every root, and an empty store is not a pass

Isolate each rule root's load behind its own error boundary so one failing root no longer hides the rest, aggregate the failures into a single `NaxError` that preserves today's non-zero exit, and warn when no root yields any rule file. Depends on nothing; independent of US-001.

Context Files: `src/cli/rules-lint.ts`, `test/unit/cli/rules-lint.test.ts`
Creates: `test/unit/cli/rules-lint-roots.test.ts`

### Modifies

**US-001**
- `src/cli/rules.ts`

**US-002**
- `src/cli/rules-lint.ts`

### Seams

`planMigration` is a new externally-visible symbol consumed by `rulesMigrateCommand` in the same story. Its seam invariant is US-001 AC-4 and AC-5: the test stubs the `fileExists` dependency, triggers `rulesMigrateCommand` — the outermost entry point, the same function `bin/nax.ts` invokes for `nax rules migrate` — and asserts the outcome is governed by the planner's decision. The wiring carries no guard, dedup, or once-per-transition logic, so no re-trigger criterion is required.

## Acceptance Criteria

### US-001 — Migration preview equals the real run

1. `[unit]` Calling `planMigration` with one source whose target path reports as existing and with `force` false returns a plan whose `skips` contains that source's target file name and whose `writes` is empty.
2. `[unit]` Calling `planMigration` with the same existing target and with `force` true returns a plan whose `writes` contains that target file name and whose `skips` is empty.
3. `[unit]` Calling `planMigration` with one source whose target path reports as absent returns a plan whose `writes` contains that target file name, for both `force` true and `force` false.
4. `[integration]` Invoking `rulesMigrateCommand` with `dryRun` true, one source, and a `fileExists` dependency reporting the target as existing performs no call to the `writeFile` dependency and returns an outcome whose skipped list contains that target file name.
5. `[integration]` Invoking `rulesMigrateCommand` twice over identical sources and identical `fileExists` responses — once with `dryRun` true and once with `dryRun` false — yields two outcomes whose written file-name sets are equal and whose skipped file-name sets are equal.
6. `[integration]` Invoking `rulesMigrateCommand` with `dryRun` true performs no call to the `mkdir` dependency.
7. `[cli]` Invoking `rulesMigrateCommand` with `dryRun` true emits a trailing summary line reporting a written count and a skipped count equal to those the same invocation reports with `dryRun` false over identical inputs.

### US-002 — The linter reports every root, and an empty store is not a pass

1. `[unit]` Invoking `rulesLintCommand` against two rule roots where the first root's `loadCanonicalRules` rejects still lints the second root: a warning attributable to a rule from the second root is emitted through the injected logger.
2. `[unit]` Invoking `rulesLintCommand` when at least one root's `loadCanonicalRules` rejects causes the returned promise to reject with a `NaxError` whose code is `RULES_LINT_ROOT_FAILED`.
3. `[unit]` Invoking `rulesLintCommand` when two of three roots reject causes a rejection whose error context names both failing root paths.
4. `[unit]` Invoking `rulesLintCommand` when every root loads successfully and only warnings are produced resolves without rejecting.
5. `[unit]` Invoking `rulesLintCommand` when every root loads successfully and no root yields any rule file emits an empty-store warning through the injected logger and resolves without rejecting.
6. `[cli]` Invoking `rulesLintCommand` when no root yields any rule file emits the `[WARN]` summary line and does not emit the `[OK]` summary line.
7. `[unit]` Invoking `rulesLintCommand` when at least one root yields at least one rule file and no other warning condition holds emits no empty-store warning.

**Out of scope:** no risk-sensitive property from the adversarial-scope table applies — this feature touches no authentication, rate limiting, replay protection, idempotency store, multi-tenancy boundary, concurrency primitive, expiry policy, or cryptographic material.

<!-- spec-writing: completed-through-phase-6 -->
