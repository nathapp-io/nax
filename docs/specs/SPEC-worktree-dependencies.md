# SPEC: Worktree Dependency Strategies (WT-DEPS-001)

**Status:** Draft
**Date:** 2026-04-19
**Author:** Nax Dev
**Related issue:** #88

---

## Summary

Add a language-agnostic `execution.worktreeDependencies` config that defines how nax prepares dependencies for git worktree execution.

This spec covers both active worktree paths:
- sequential execution with `execution.storyIsolation: "worktree"`
- parallel batch execution via the unified executor

The design explicitly forbids symlink-based dependency reuse. Instead, nax exposes a strategy-based contract:
- `inherit` — default, reuse dependencies from the primary checkout without symlinking dependency directories into the worktree
- `provision` — prepare each worktree as its own runnable environment before story execution
- `off` — do nothing

The goal is to replace fragile artifact-specific logic (`node_modules` symlinks, package-local symlink patches) with one shared dependency-preparation hook used consistently by both worktree execution modes.

## Motivation

### The old behavior is both stale and too narrow

Historically, nax solved worktree dependency problems by symlinking `node_modules`. That only addressed part of the problem:

- it was JS/TS-centric
- it exposed implementation details (`node_modules`) as product behavior
- it did not generalize cleanly to other ecosystems
- package-local fixes diverged from root-level fixes
- active execution paths changed over time, leaving old fixes on stale codepaths

The current codebase still reflects this drift:
- `WorktreeManager.create()` handles root `node_modules`
- an older parallel path added per-package `node_modules` handling
- the active unified executor path does not share one dependency-preparation policy

### nax needs a behavior contract, not a directory list

The real product question is:

> How should nax ensure a worktree has the prerequisites needed to run story commands?

That is different from:

> Which directories should nax symlink?

The public API should describe behavior (`inherit`, `provision`, `off`), not filesystem artifacts (`node_modules`, `.venv`, `vendor/`, `.gradle`, etc.).

### Why not always reinstall dependencies per worktree?

Always provisioning independently is correct in principle but not a good default for local development:

- it adds major startup cost to every worktree
- parallel runs multiply that cost by story count
- it increases network, disk, and registry failure surface
- it pushes nax into the role of always being an environment provisioner

nax should support strict per-worktree provisioning, but it should not force that cost on every user by default.

## Design

### Config

```json
{
  "execution": {
    "worktreeDependencies": {
      "mode": "inherit",
      "setupCommand": null
    }
  }
}
```

#### `mode`

`"inherit" | "provision" | "off"`

- `inherit`
  - default mode
  - reuse dependencies from the primary checkout when possible
  - must not symlink dependency directories into the worktree
  - if nax cannot safely support inheritance for the detected project type, it must fail clearly rather than silently falling back

- `provision`
  - prepare dependencies inside the worktree before story execution
  - may use detected project behavior or an explicit override
  - intended for hermetic or stricter setups

- `off`
  - do nothing
  - assumes story commands already work in a fresh worktree or the user manages setup externally

#### `setupCommand`

- optional explicit override command
- primarily meaningful in `provision` mode
- intended for projects where built-in project detection is insufficient
- this is an override, not the main abstraction
- invalid when `mode` is `inherit` or `off`
- runs inside the worktree, not the primary checkout
- defaults to the story package root when `story.workdir` is set, otherwise the worktree root
- executes once per fresh worktree creation, before any story command runs
- is not rerun on in-worktree escalation retries unless the worktree is recreated
- executes via the same explicit command-construction rules used elsewhere in nax; implementation must not rely on ad hoc shell parsing
- must define how command arguments are constructed and escaped before implementation begins
- receives the environment prepared so far for dependency setup, and any environment returned afterward becomes part of the final `WorktreeDependencyContext`

### Shared execution hook

Add one shared worktree dependency-preparation hook, conceptually:

```typescript
prepareWorktreeDependencies(options): Promise<WorktreeDependencyContext>
```

```typescript
interface WorktreeDependencyContext {
  cwd: string;
  env?: Record<string, string>;
}
```

This hook must run in both active worktree paths:

1. sequential worktree isolation
   - after worktree creation in `iteration-runner`
   - before pipeline execution starts

2. parallel batch execution
   - after worktree creation in `runParallelBatch`
   - before any story command runs in that worktree

The hook is the single source of truth for worktree dependency behavior.
Its return value is the only supported handoff into later command execution for dependency-related context.

### Responsibility boundaries

#### `WorktreeManager`

`WorktreeManager` becomes responsible only for:
- creating worktrees
- removing worktrees
- listing worktrees
- repo/runtime file setup that is not dependency-specific

`WorktreeManager` must no longer:
- symlink dependency directories
- encode ecosystem-specific dependency assumptions

#### Dependency-preparation module

Add a focused module under `src/worktree/` that:
- resolves the configured dependency mode
- inspects project context as needed
- prepares the worktree environment before execution
- returns the dependency context consumed by later command runners

This keeps worktree lifecycle separate from dependency behavior while preserving a clear ownership boundary:
- `src/worktree/` owns how a worktree becomes runnable
- `src/execution/` owns when the preparation hook is invoked

Recommended layout:
- `src/worktree/manager.ts`
  - create/remove/list lifecycle only
- `src/worktree/dependencies.ts`
  - `prepareWorktreeDependencies(...)`
  - dependency mode behavior
- `src/worktree/types.ts`
  - shared worktree/dependency-prep types if needed

### Mode semantics

#### `inherit`

`inherit` means:
- reuse dependencies from the main checkout when possible
- do not copy or symlink dependency directories into the worktree
- do not silently mutate worktree layout to simulate inheritance

Instead, nax must establish inheritance through explicit execution-context rules that are valid for the detected project type.
Those rules must be returned as `WorktreeDependencyContext` and then consumed by story-command execution. Callers must not invent their own inheritance behavior outside this hook.

`inherit` support must be allowlist-based:
- nax owns an internal registry of supported inheritance strategies
- support is determined by implemented and tested capability, not by user configuration
- users must not be able to extend the allowlist through config

Each allowlisted inheritance strategy should define:
- how it is detected
- what preconditions must hold
- how dependency reuse works without symlinked dependency directories
- what dependency context (`cwd`, environment) it returns to execution
- what failure message to show when preconditions are not met

If inheritance cannot be established safely for the current project/tooling combination, nax must fail with a clear error that tells the user to:
- switch to `provision`, or
- provide an explicit `setupCommand` override where applicable

Important constraints:
- no hidden symlink fallback
- no silent fallback to `provision`

#### `provision`

`provision` means:
- perform an explicit dependency-setup step inside the worktree before execution
- prefer detected project behavior when available
- allow `setupCommand` to override detection

The setup step must run before any story command, test command, or verification command in the worktree.
The setup step:
- runs inside the worktree
- uses the story package root as its working directory when `story.workdir` is set, otherwise the worktree root
- runs once per fresh worktree creation
- does not rerun during in-worktree escalation retries
- must return a `WorktreeDependencyContext` consumed by later command execution

#### `off`

`off` means:
- create the worktree
- do not prepare dependencies
- proceed directly to execution

This mode is intentionally unsafe unless the project already supports fresh worktree execution without preparation.

### Detection and phase scope

This spec is language-agnostic at the API level, but phase 1 does not need full ecosystem coverage.

Phase 1 requirements:
- support config validation for `mode` and `setupCommand`
- support a shared dependency-prep hook on both active worktree paths
- support explicit `setupCommand` for `provision`
- support `off`
- support `inherit` with explicit unsupported-mode failure where needed
- validate that `setupCommand` is only used with `mode: "provision"`
- keep `inherit` support internal and allowlist-based
- require at least one concrete phase-1 allowlisted `inherit` strategy if `inherit` remains the default
- define and use a single dependency-context handoff contract for later command execution

Phase 1 non-goals:
- full auto-detected provisioning across every ecosystem
- introducing new symlink-based compatibility behavior
- preserving old `node_modules` symlink behavior as a hidden fallback

### Migration constraints

This feature changes existing worktree behavior. Migration must be explicit and observable.

Migration rules:
- remove dependency-directory symlink behavior from `WorktreeManager`
- do not preserve symlink behavior behind the same config surface
- if current users depended on symlinked reuse, they must move to either:
  - `inherit` if their project type is supported without symlinks, or
  - `provision` / `setupCommand`

The migration is intentionally behavior-changing because symlink-based reuse is considered fragile and should not remain part of the supported model.

## Failure Handling

All failures in worktree dependency preparation must occur before pipeline execution begins.

Failure categories:
- worktree creation failure
- dependency inheritance unsupported
- dependency provisioning command failed
- invalid configuration

Requirements:
- errors must clearly identify the active mode
- logs must distinguish dependency-prep failures from later test or pipeline failures
- no silent retries across modes
- no implicit fallback from `inherit` to `provision`
- dependency-prep failures are terminal pre-execution failures, not escalation candidates
- dependency-prep failures mark the story failed immediately
- dependency-prep failures use a distinct pre-execution failure category rather than model-tier failure categories
- phase 1 introduces a dedicated story failure category for dependency-prep failures so PRD/runtime state can distinguish them from session, test, and verifier failures
- when dependency prep fails, nax must not enter pipeline execution for that story
- worktree cleanup on dependency-prep failure must be explicit and deterministic:
  - if worktree creation succeeded but dependency prep failed, the worktree is removed by default
  - reruns recreate the worktree and reattempt dependency prep from scratch

## Testing Strategy

### Unit coverage

- config schema validation for `execution.worktreeDependencies`
- mode resolution
- dependency-preparation decision logic
- `setupCommand` override behavior
- explicit failure behavior for unsupported `inherit`
- dependency-context return shape and propagation
- dependency-prep failure category propagation into story state

### Integration coverage

- sequential worktree path calls dependency preparation before pipeline execution
- parallel batch path calls the same dependency preparation hook before story execution
- `WorktreeManager` no longer creates dependency symlinks
- error reporting distinguishes dependency-prep failures from later pipeline failures
- dependency context returned by prep is the context used by later command execution
- `setupCommand` runs in the correct working directory
- `setupCommand` runs once per fresh worktree creation and is not rerun on escalation retries in the same worktree

### Regression coverage

- remove tests that assert `node_modules` symlinking as supported behavior
- add tests that assert no dependency-directory symlink is created by `WorktreeManager`
- add tests that prove both active worktree paths share the same preparation hook

## Stories

### US-001: Add `execution.worktreeDependencies` config

Add the config surface and schema validation for worktree dependency strategies.

**Complexity:** Simple

**Context Files:**
- `src/config/schemas.ts`
- `src/config/defaults.ts`
- `src/config/runtime-types.ts`
- PRD/runtime failure-category types where needed
- existing worktree and execution config docs/specs

**Dependencies:** none

**Acceptance Criteria:**
- `execution.worktreeDependencies` is a valid config object
- `mode` accepts exactly `"inherit" | "provision" | "off"`
- default `mode` is `"inherit"`
- `setupCommand` is optional and nullable
- `setupCommand` is rejected unless `mode === "provision"`
- invalid `mode` values fail schema validation
- config defaults and runtime types agree on field names and defaults
- dependency-prep failure category is represented in runtime/PRD typing if introduced in phase 1

---

### US-002: Move dependency behavior out of `WorktreeManager`

Refactor `WorktreeManager` so it no longer performs dependency-specific symlink logic.

**Complexity:** Medium

**Context Files:**
- `src/worktree/manager.ts`
- `test/integration/worktree/manager.test.ts`
- any worktree tests asserting dependency symlink behavior

**Dependencies:** US-001

**Acceptance Criteria:**
- `WorktreeManager.create()` no longer symlinks dependency directories
- `WorktreeManager` remains responsible for worktree lifecycle only
- tests no longer assert `node_modules` symlink creation as supported behavior
- regression tests assert that dependency-directory symlinks are not created

---

### US-003: Add a shared dependency-preparation hook under `src/worktree/` for both worktree execution paths

Introduce one dependency-preparation module under `src/worktree/` and call it from both sequential and parallel worktree execution.

**Complexity:** Complex

**Context Files:**
- `src/worktree/dependencies.ts` (new)
- `src/execution/iteration-runner.ts`
- `src/execution/parallel-batch.ts`
- `src/execution/unified-executor.ts`
- `src/worktree/types.ts` if needed

**Dependencies:** US-001, US-002

**Acceptance Criteria:**
- a shared dependency-preparation hook exists and is used by both active worktree execution paths
- sequential `storyIsolation: "worktree"` invokes the hook after worktree creation and before pipeline execution
- parallel batch execution invokes the same hook after worktree creation and before story execution
- no parallel-only or sequential-only dependency behavior remains outside the shared hook
- the hook returns a concrete dependency context consumed by later command execution

---

### US-004: Implement mode semantics and failure behavior

Make `inherit`, `provision`, and `off` observable and enforce their failure contracts.

**Complexity:** Complex

**Context Files:**
- dependency-preparation module from US-003
- project/profile detection code
- execution logging/error handling

**Dependencies:** US-003

**Acceptance Criteria:**
- `inherit` does not create dependency symlinks
- `inherit` support is determined by an internal nax allowlist, not user config
- at least one concrete `inherit` strategy exists in phase 1 if `inherit` remains the default mode
- `inherit` fails clearly when the project/tooling combination is unsupported
- `provision` runs setup before story commands execute
- `provision` setup runs in the worktree using the story package root when available, otherwise the worktree root
- `provision` setup runs once per worktree creation and does not rerun on in-worktree escalation retries
- `setupCommand` overrides built-in provisioning behavior when configured
- `setupCommand` execution semantics are explicitly defined and do not rely on ad hoc shell parsing
- `off` skips dependency preparation entirely
- no silent fallback occurs between modes
- dependency-prep failures do not route through model-tier escalation
- dependency-prep failures mark the story failed before pipeline execution starts
- dependency-prep failures are recorded with a distinct failure category

---

### US-005: Add tests for active-path coverage and migration behavior

Cover the shared hook, config behavior, and explicit removal of symlink-based reuse.

**Complexity:** Medium

**Context Files:**
- unit tests for config and dependency-prep logic
- worktree integration tests
- sequential and parallel executor tests

**Dependencies:** US-004

**Acceptance Criteria:**
- unit tests cover config validation and mode resolution
- sequential worktree tests prove dependency preparation runs before pipeline execution
- parallel batch tests prove the same hook runs on the active path
- regression tests prove `WorktreeManager` no longer creates dependency symlinks
- test suite coverage distinguishes dependency-prep failure from later pipeline failure

## Feature-Level Acceptance Criteria

- nax exposes `execution.worktreeDependencies.mode` with supported values `inherit`, `provision`, and `off`
- default worktree dependency mode is `inherit`
- both active worktree execution modes use the same dependency-preparation hook
- `WorktreeManager` no longer implements dependency-directory symlink behavior
- symlink-based dependency reuse is not part of the supported implementation
- `inherit` fails explicitly when unsupported rather than silently falling back
- if `inherit` is the default, phase 1 includes at least one concrete supported `inherit` strategy
- `provision` prepares the worktree before story execution
- `off` performs no dependency preparation
- `setupCommand` is only valid in `provision` mode
- `inherit` support is controlled by internal allowlisted strategies, not user-configurable lists
- dependency-prep failures are terminal pre-execution failures
- dependency-prep failures have a distinct failure category in story/runtime state
- dependency preparation returns a concrete context consumed by later command execution
- configuration, runtime types, and tests agree on the new behavior

## Recommendation

Start with the shared hook and config contract first. Keep phase 1 strict:
- no symlink compatibility fallback
- no silent mode fallback
- explicit unsupported behavior in `inherit`
- internal allowlist for `inherit`
- `setupCommand` only in `provision`
- dependency-prep failures treated as terminal pre-execution failures

That gives nax a clean product contract now, while allowing project-aware inheritance and provisioning support to expand incrementally later.
