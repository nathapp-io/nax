# Issue 931 Acceptance Verification

Issue: https://github.com/nathapp-io/nax/issues/931

Verified commit: `a361aaac feat(review): add story-scoped lint command path (#937)` on `origin/main`.

Local checkout note: the checked-out `main` branch was one commit behind `origin/main` during verification. The implementation was reviewed in a temporary worktree at `origin/main`.

## Summary

Issue 931 is partially implemented, but the acceptance criteria are not fully met.

The core scoped-lint happy path is present and tested: lint is routed through `runScopedLintCheck`, changed files are derived from `storyGitRef`, `contextFiles` are included via `getContextFiles(story)`, and monorepo scope filtering uses `findPackageDir`.

However, several requested acceptance details are missing or incomplete: the exact `runAutofixLint` API shape is absent, autofix output is not grouped by `packageDir`, degraded-mode behavior is under-tested, and there is no dogfood replay proving sibling-story lint debt is reported as `out_of_scope`.

## Verification Commands

```sh
bun test test/unit/review/scoped-lint.test.ts test/unit/review/runner.test.ts test/unit/config/quality-commands-schema.test.ts test/unit/config/merge.test.ts --timeout=30000
```

Result: `102 pass, 0 fail`

```sh
bun run typecheck
```

Result: passed

## Acceptance Criteria

### 1. `runAutofixLint` accepts `scope: { changedFiles: string[], contextFiles: string[], packageDir: string }`

Status: Not met

Evidence:

- No `runAutofixLint` function exists in the implementation.
- The implementation adds `runScopedLintCheck(args)` in `src/review/scoped-lint.ts`.
- `runScopedLintCheck` computes changed files internally from `storyGitRef` and gets context files from `story`, rather than accepting a `scope` argument with `changedFiles`, `contextFiles`, and `packageDir`.

### 2. Scope is filtered to `packageDir` in monorepo mode using `findPackageDir`

Status: Mostly met

Evidence:

- `src/review/scoped-lint.ts` imports `findPackageDir` from `src/test-runners/resolver`.
- It infers the active package directory from `workdir` relative to `projectDir`.
- It filters files by comparing `findPackageDir(relPath, projectDir)` to the active package directory.
- Unit coverage exists in `test/unit/review/scoped-lint.test.ts` for filtering `packages/web` out when the active workdir is `packages/api`.

Risk:

- This is implemented through inferred package state, not the explicit `packageDir` argument requested by the issue.

### 3. Lint invocation uses file-list mode where supported; falls back to whole-package plus post-filter where not, with `lint_scope_degraded`

Status: Partially met

Evidence:

- `lintScoped` command templates are supported with `{{files}}`.
- Derived file-list mode is supported for `eslint`, `biome`, `ruff`, and `flake8`.
- Unsupported command shapes run full lint and attempt to post-filter parsed diagnostics.
- `lint_scope_degraded` is logged for degraded paths.

Gaps:

- No explicit handling for `golangci-lint --new-from-rev=<DIFF_BASE>`.
- No explicit handling for `clippy` package scoping.
- If output cannot be parsed, the full lint failure is returned, which can still surface out-of-scope findings after degradation.
- The added tests do not exercise degraded post-filtering or unparseable output behavior.

### 4. Findings are grouped by `packageDir` in the autofix output

Status: Not met

Evidence:

- The lint path returns a flat `ReviewCheckResult`.
- I found no package-grouped autofix output shape for lint findings.
- No test asserts grouping by `packageDir`.

### 5. Unit tests cover required scenarios

Status: Partially met

Present:

- Single-repo scoped lint command derivation.
- `lintScoped` template substitution.
- Empty in-scope file set.
- Missing `storyGitRef` degraded path.
- Monorepo same-package filtering.
- Review runner integration routes lint through the scoped lint helper.

Missing or insufficient:

- Explicit single-repo test proving `changedFiles ∪ contextFiles`.
- Explicit cross-package contamination test proving sibling package debt does not enter autofix output.
- Tool without file-list mode test exercising whole-package plus post-filter.
- Unparseable degraded output test.
- Dogfood replay test.

### 6. Replays failing dogfood run scenario and reports previous blocking lint failures as `out_of_scope`

Status: Not met

Evidence:

- No replay test was found.
- No structured `out_of_scope` status was found.
- The implementation can return the string `lint warnings/errors were out of story scope`, but that is not the same as a dogfood replay or structured `out_of_scope` reporting.

## Overall Result

Do not mark issue 931 fully accepted yet.

Recommended follow-up work:

- Add the requested explicit scope input or document/adjust the acceptance criteria to match `runScopedLintCheck`.
- Add structured out-of-scope reporting for filtered diagnostics.
- Add package-grouped autofix/review output.
- Add degraded-mode tests for unsupported lint commands and unparseable output.
- Add a dogfood replay fixture for sibling-story lint debt.
