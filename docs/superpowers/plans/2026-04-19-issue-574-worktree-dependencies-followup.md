# Issue #574 Implementation Plan

> Issue: [#574](https://github.com/nathapp-io/nax/issues/574)
> Related PR: [#575](https://github.com/nathapp-io/nax/pull/575)

## Current State

Issue `#574` was opened when three gaps existed in the phase-1 worktree dependency implementation:

1. `inherit` was not usable for common dependency-managed repos
2. parallel execution ignored per-package routing/model overrides
3. `provision` was forced to the package cwd instead of supporting repo-root workspace installs

Items 2 and 3 are already addressed on the active branch in PR `#575`:

- parallel routing now uses each story's effective per-package config
- `provision` now runs setup from the worktree root while preserving the package cwd for execution

That leaves the real follow-up scope as:

- define and implement coherent `inherit` semantics
- align docs/specs/config descriptions with the final behavior
- update or close `#574` once the branch lands, depending on whether any additional scope remains

## Goal

Make `execution.worktreeDependencies.mode = "inherit"` a real, documented, test-covered behavior for common dependency-managed repos, or explicitly narrow and rename the behavior if true inheritance is not supportable.

## Recommended Direction

Do not restore `inherit` as the default until its behavior is implemented and proven in tests.

Phase 2 should make `inherit` a real supported mode for common JS/TS repos first, because:

- that is where the product pain is today
- the repo is Bun/TypeScript, so local verification is strongest there
- the existing config/spec language already implies `inherit` is intended as a first-class mode

If a real implementation is not practical without hidden symlinks or unsafe assumptions, stop and change the product contract instead of shipping a misleading mode name.

## Proposed Design

### 1. Define the actual contract of `inherit`

Write down exact semantics before code changes:

- what `inherit` means operationally
- which ecosystems are supported in phase 2
- which repo shapes are supported initially
- what preconditions must hold
- what the returned `WorktreeDependencyContext` contains
- what error message users get when their repo is not supported

The contract should answer this clearly:

> In a normal dependency-managed repo, what concrete setup allows a fresh worktree to run story commands without per-worktree installation and without `node_modules` symlinks?

### 2. Start with an allowlisted strategy registry

Keep the allowlist shape already implied by the current implementation, but make it real:

- create explicit strategy detection instead of a blanket manifest failure
- support at least one tested inheritance strategy for common Bun/Node repos
- reject unsupported repos with a precise message

This should live in `src/worktree/dependencies.ts` or a small adjacent strategy module, not in `WorktreeManager`.

### 3. Preserve the separation of concerns

Keep current boundaries:

- `WorktreeManager`: lifecycle only
- `prepareWorktreeDependencies()`: dependency preparation only
- execution/review/verify stages: consume `WorktreeDependencyContext`, do not invent dependency behavior

Do not reintroduce hidden dependency-directory mutations in manager code.

### 4. Align docs and issue state

After implementation:

- update `docs/specs/SPEC-worktree-dependencies.md`
- update any config descriptions/default docs that still imply incomplete `inherit` support
- edit issue `#574` to remove the already-fixed items or close it if the remaining scope is fully resolved

## Implementation Tasks

### Task 1: Narrow the follow-up issue scope

Update `#574` after PR `#575` merges so it no longer claims the still-open work includes:

- parallel per-package routing
- repo-root provisioning support

Leave the issue focused on `inherit` semantics and documentation alignment.

### Task 2: Add tests that express the intended `inherit` behavior

Add failing tests first in `test/unit/worktree/dependencies.test.ts` and, if needed, a small integration fixture.

Minimum cases:

- dependency-managed repo that is supported by the phase-2 allowlist succeeds in `inherit`
- unsupported dependency-managed repo fails with a targeted error
- returned dependency context is the one later stages are expected to use
- no dependency-directory symlink fallback is reintroduced

If JS/TS is the first supported strategy, add coverage for:

- single-package repo
- monorepo package story with `story.workdir`

### Task 3: Implement explicit `inherit` strategies

Refactor `prepareWorktreeDependencies()` so `inherit` becomes:

- detect strategy
- validate preconditions
- return a real `WorktreeDependencyContext`

Instead of:

- detect any manifest
- fail immediately

The initial implementation should be intentionally narrow but real.

### Task 4: Verify downstream stage compatibility

Re-run the same end-to-end surfaces that consume dependency context:

- sequential worktree execution
- parallel worktree execution
- verify
- review
- quality commands

The core assertion is that `inherit` changes only dependency preparation semantics, not stage wiring.

### Task 5: Update docs and defaults only if justified

Only after `inherit` is real and tested:

- decide whether default should remain `off` or move back to `inherit`
- update spec and config descriptions to match shipped behavior

If `inherit` remains too narrow, keep default `off` and document `inherit` as an advanced allowlisted mode.

## File Targets

Likely files:

- `src/worktree/dependencies.ts`
- `src/worktree/types.ts`
- `test/unit/worktree/dependencies.test.ts`
- `test/unit/execution/iteration-runner-worktree.test.ts`
- `test/unit/execution/parallel-batch.test.ts`
- `docs/specs/SPEC-worktree-dependencies.md`

Potentially:

- `src/cli/config-descriptions.ts`
- `src/config/schemas.ts`

Only if defaults or config descriptions change again.

## Verification

Minimum verification for the follow-up:

```bash
rtk bun test test/unit/worktree/dependencies.test.ts test/unit/execution/iteration-runner-worktree.test.ts test/unit/execution/parallel-batch.test.ts --timeout=30000
rtk bun x tsc --noEmit
rtk bun run test
```

Run the full suite outside the sandbox because subscriber tests write under `~/.nax`.

## Decision Gate

Before implementation starts, answer this explicitly:

1. What is the first supported `inherit` strategy?
2. What exact repo shapes does it support?
3. Is that enough to justify changing the default back from `off`?

If those answers are weak, the correct action is to keep `off` as the default and tighten the product language around `inherit`, not to ship another ambiguous placeholder.
