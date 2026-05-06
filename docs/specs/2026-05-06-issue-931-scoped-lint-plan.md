# Issue 931 — Story-Scoped Lint Implementation Plan

## Context

Issue #931 comes from the Phase 4 forensic audit in `logs/FORENSIC-AUDIT-2026-05-05.md`.
The failure mode was not a lint rule problem. It was an ownership problem:

1. A story reached review/autofix.
2. The lint check ran against the whole package or repo.
3. Lint debt in sibling-story test files appeared in the current story's review result.
4. The rectification prompt required the implementer to fix all reported errors while also forbidding test edits.
5. The story correctly emitted `UNRESOLVED`, escalated across tiers, and failed for out-of-scope debt.

The fix is to make in-run lint story-scoped. Project-wide lint remains appropriate for CI, pre-commit, and explicit user commands.

## Goals

- Scope review/autofix lint findings to files owned by the current story.
- Preserve package-wide typecheck behaviour.
- Keep existing `quality.commands.lint` and `review.commands.lint` as full/package lint commands.
- Add explicit scoped lint command templates for projects whose lint command cannot safely accept appended file paths.
- Make scope widening observable with a `lint_scope_degraded` log entry.
- Reuse existing monorepo package detection through `findPackageDir`.

## Non-Goals

- Do not change lint rules, severities, or output formats.
- Do not scope typecheck to file lists.
- Do not change CI or pre-commit lint behaviour.
- Do not introduce new path boundary primitives.
- Do not implement scoped mechanical fix commands in phase 1.

## Config Surface

Add `lintScoped` to both command maps, following the existing `testScoped` naming convention.

```ts
quality.commands.lint
quality.commands.lintScoped

review.commands.lint
review.commands.lintScoped
```

`lintScoped` is a command template with a `{{files}}` placeholder:

```json
{
  "quality": {
    "commands": {
      "lint": "bun run lint",
      "lintScoped": "bunx biome check {{files}}"
    }
  }
}
```

Resolution order for a scoped lint review check:

```text
review.commands.lintScoped
  ?? quality.commands.lintScoped
  ?? deriveScopedLint(review.commands.lint ?? quality.commands.lint)
```

Per-package config merging should bridge `quality.commands.lintScoped` into `review.commands.lintScoped`, matching the current bridge for `lint`, `typecheck`, `test`, `build`, `lintFix`, and `formatFix`.

## Scope Definition

The lint scope is the union of story-owned changed files and declared context files:

```text
DIFF_BASE = ctx.storyGitRef
CHANGED   = git diff --name-only DIFF_BASE..HEAD
CONTEXT   = story.contextFiles ?? story.relevantFiles ?? []
SCOPE     = CHANGED ∪ CONTEXT
```

Filtering:

- Keep only lintable regular files.
- Exclude deleted files.
- Apply `.naxignore` filtering where available.
- In monorepo mode, keep only files whose `findPackageDir(file, repoRoot)` resolves to the active `packageDir`.
- Normalize paths relative to the command workdir before substituting into `{{files}}`.

If `ctx.storyGitRef` is missing or invalid, scoped lint cannot safely determine ownership. In that case:

- Run the existing full lint command.
- Log `lint_scope_degraded` with reason `missing_story_git_ref`.
- Preserve current fail-closed behaviour.

## Command Behaviour

### Template Mode

If `lintScoped` is configured, replace `{{files}}` with shell-quoted scoped paths and run the resulting command.

If `SCOPE` is empty:

- Skip the lint check.
- Return a successful lint check with output explaining that no scoped lint files were found.
- Log `lint_scope_empty`.

### Derived File-List Mode

If no `lintScoped` template is configured, attempt to derive a file-list command from the full lint command.

Supported families:

| Family | Derived scoped behaviour |
|---|---|
| eslint | append `<file...>` |
| biome | append `<file...>` |
| ruff | append `<file...>` |
| flake8 | append `<file...>` |

The derivation should be conservative. If the command shape is ambiguous, do not guess.

### Degraded Mode

When a scoped command cannot be built:

1. Run the full lint command.
2. Parse diagnostics using the configured `quality.lintOutput.format`.
3. Filter diagnostics to `SCOPE`.
4. Return success if all parsed diagnostics are out of scope.
5. Return failure with only in-scope diagnostics if any remain.
6. Log `lint_scope_degraded`.

If diagnostics cannot be parsed, return the full lint failure and log `lint_scope_degraded` with reason `unparseable_output`. Do not silently widen scope.

## Review Runner Changes

Add a scoped lint path in `src/review/runner.ts`.

Suggested shape:

```ts
interface LintScope {
  changedFiles: string[];
  contextFiles: string[];
  packageDir?: string;
  storyGitRef?: string;
}
```

Extend `RunReviewOptions` with enough context to build that scope:

- `story`
- `storyGitRef`
- `projectDir`
- active package/workdir
- `naxIgnoreIndex`

When `checkName === "lint"`, use a scoped lint runner instead of the generic `runCheck`.

Typecheck, build, and test checks continue to use the existing command path.

## Suggested Module Split

Add a small scoped lint helper rather than embedding the logic in `review/runner.ts`.

```text
src/review/scoped-lint.ts
```

Responsibilities:

- collect changed files from `storyGitRef..HEAD`
- merge with context files
- filter by package using `findPackageDir`
- build `lintScoped` command
- derive file-list lint command when safe
- run degraded full lint + post-filter path

Use injectable `_deps` for git, filesystem checks, command running, and package resolution.

## Tests

Unit tests should cover:

1. Config schema accepts `quality.commands.lintScoped`.
2. Config schema accepts `review.commands.lintScoped`.
3. Per-package merge bridges `quality.commands.lintScoped` into `review.commands.lintScoped`.
4. `review.commands.lintScoped` takes precedence over `quality.commands.lintScoped`.
5. Single-repo scoped lint substitutes only `storyGitRef..HEAD` changed files plus context files.
6. Monorepo same-package files are included.
7. Monorepo sibling-package files are excluded.
8. Empty scope skips lint successfully with `lint_scope_empty`.
9. Missing `storyGitRef` falls back to full lint with `lint_scope_degraded`.
10. Unsupported command runs full lint and post-filters parsed diagnostics.
11. Unsupported command with unparseable output fails closed and logs `lint_scope_degraded`.
12. The dogfood failure shape reports sibling-story lint debt as out of scope.

## Rollout

1. Add config schema/runtime types/description updates.
2. Add per-package merge bridge.
3. Add scoped lint helper with unit tests.
4. Wire `review/runner.ts` lint checks through the helper.
5. Ensure existing project-wide lint commands remain unchanged outside story review/autofix.
6. Document `lintScoped` in the configuration guide near `testScoped`.

## Phase 2 Follow-Up

Phase 1 intentionally scopes lint reporting only. Mechanical autofix still uses:

```text
quality.commands.lintFix
quality.commands.formatFix
review.commands.lintFix
review.commands.formatFix
```

Phase 2 should add scoped mechanical fix templates:

```text
quality.commands.lintFixScoped
quality.commands.formatFixScoped
review.commands.lintFixScoped
review.commands.formatFixScoped
```

This avoids formatters or lint fixers touching sibling-story files during autofix.
