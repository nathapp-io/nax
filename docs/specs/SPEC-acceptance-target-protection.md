# SPEC: Acceptance Target Protection

## Summary

The generated acceptance test is nax's own artifact, but nothing tells an agent not to delete it, nothing stops the snapshot auto-commit from sweeping that deletion onto the branch, and nothing makes the acceptance gate notice the file is gone. This feature closes all three: a `.nax/` immutability guard in every code-touching role prompt, a restore step in `autoCommitIfDirty` that undoes deletions under `.nax/` before staging, and an acceptance stage that fails — instead of silently passing — when a package with stories in the PRD has no acceptance test on disk. Three independent defenses on one failure chain, in the order they fire: prevent, repair, detect.

## Motivation

Issue [#1508](https://github.com/nathapp-io/nax/issues/1508). In a 4-story monorepo run, the `test-writer` session for US-004 found `apps/web/.nax/features/<feature>/.nax-acceptance.test.tsx`, judged it a stray file outside the package's `tests/` directory, and deleted it. The snapshot auto-commit committed the deletion (`dirtyFiles: 2`). The completion gate then logged `Acceptance test file not found — skipping` twice and wrote `postRun.acceptance.status: "passed"`.

The feature merged with one story's acceptance criteria never verified, and `status.json` asserting the opposite. The only trace in a 1600-line run log was two `warn` records.

The test-writer was not careless. Its replacement tests in `apps/web/tests/` matched the deleted file's `AC-1`…`AC-9` one for one; it relocated the coverage faithfully and then tidied up what looked like an orphan. The placement instruction it was given — *"Create test files in the location the project uses for tests"* — makes deleting a file outside that location the locally correct action. Meanwhile `acceptance-builder.ts:152` tells the `acceptance-gen` role the opposite: *"This path is intentional and computed by the orchestrator — do not change it based on what you observe in the project."* Only one of the two roles is told the path is deliberate.

Three defects compose. Each alone would have stopped the chain, so each is fixed here.

## Design

### Approach

Three independent mechanisms, deliberately not coupled through a shared module — they touch different subsystems, and a shared abstraction would make each harder to test than it is to duplicate the one-line predicate.

Detection in US-002 is a **structural discriminator**, not a resolved-path list: any deletion or rename whose path lies under a `.nax/` segment is illegitimate for an agent session. This is broader than "the acceptance target" and deliberately so — it also protects `prd.json`, `checkpoint.jsonl`, and `acceptance-meta.json`, and it makes the code enforcement exactly symmetric with the prompt sentence US-001 adds. `autoCommitIfDirty(workdir, stage, role, storyId, blockedWorktrees?)` is a leaf utility with no PRD, config, or feature name in scope, so it *cannot* call `groupStoriesByPackage`; a structural rule is the only form of the check available to it without a signature change.

### Integration

**US-001 — prompt guard.** Follows `buildBehavioralGuardrailsSection` (`src/prompts/sections/behavioral-guardrails.ts:12`) exactly: a role-keyed builder in `src/prompts/sections/`, exported from the `src/prompts/sections/index.ts` barrel, composed into the prompt accumulator. Two deliberate differences from that precedent:

- It is **not config-gated**. `buildBehavioralGuardrailsSection` takes a `GuardrailLevel` and returns `null` when `"off"`; this section is a safety invariant and always returns a string.
- It **applies to `verifier`**. The guardrails builder returns `null` for `verifier` and `no-test`; this one does not.

Two composition sites, both existing:

| Site | Roles covered |
|:---|:---|
| `src/prompts/builders/tdd-builder.ts:238-248` (alongside the guardrails block) | `test-writer`, `implementer`, `verifier` |
| `buildEscapeHatch` in `src/prompts/builders/rectifier-builder-helpers.ts:116` — interpolate the section into its returned template string | rectifier |

**The rectifier guard must not be composed in `rectifier-builder.ts`.** That file is 902 lines and is pinned at exactly `902` in `scripts/baselines/file-sizes-baseline.json`; the ratchet grandfathers oversized files but forbids growth, so adding even one line there fails `bun run check:file-sizes` inside `bun run lint`. Routing through `buildEscapeHatch` (in the 412-line helpers module, which already carries the rectifier's `.nax/` text) adds zero lines to the capped file.

The rectifier's existing `.nax/` citation paragraph (`rectifier-builder-helpers.ts:130-135`) is **left unchanged** — it addresses a different failure mode (agents *citing* a `.nax/` test as real coverage) and uses rectifier-only vocabulary that would be noise elsewhere. The new section is appended alongside it, not merged into it.

**US-002 — auto-commit restore.** `autoCommitIfDirty` in `src/utils/git.ts:247`. The new step sits between the `git status --porcelain` read (`:315-323`) and the `git add -A` (`:335`). Follows the existing refusal precedent 15 lines above at `:300-313` for logging shape. All process spawning goes through the existing `_gitDeps.spawn` injection point; the logger is `_gitDeps.getSafeLogger()`.

Porcelain parsing is extracted to its own exported helper so it can be tested against real porcelain strings rather than through a spawn mock. Rename entries are `R  old -> new` and the **old** path is the one to restore; paths containing spaces or non-ASCII bytes come back quoted by git.

**US-003 — stage decision.** `ctx.acceptanceTestPaths` (`src/pipeline/types.ts:234`) gains two fields, both derivable from data the two producers already hold:

- `storyCount?: number` — from `AcceptanceTestGroup.stories.length` (`src/acceptance/test-path.ts:105`)
- `acceptanceEnabled?: boolean` — from the per-package `groupConfig` that `runner-completion.ts:158` already loads and currently reads only for `testFramework` / `commandOverride`

**Both fields are optional, and that is load-bearing — not laziness.** Eight existing test files construct `{ testPath, packageDir }` literals for this type across 64 references (`prompt-acceptance.test.ts`, `acceptance.test.ts`, `acceptance-loop.test.ts`, and others). Required fields would make every one a compile error, and test-authorship isolation bars US-003's implementer from editing suites its story does not own — the story would deadlock with a correct implementation.

Because optional fields could otherwise silently restore the very skip this feature removes, the consumer resolves each with an explicit fallback rather than trusting the producer:

- `storyCount` undefined → derive it in the stage by counting `ctx.prd.userStories` that are non-fix, non-decomposed, and whose `workdir` resolves to that group's `packageDir`. The stage already holds `ctx.prd` (`acceptance.ts:92`).
- `acceptanceEnabled` undefined → treat as `true`. The root-level flag has already gated `acceptanceStage.enabled()`, so reaching the consumer at all means acceptance is on.

Producers: `src/pipeline/stages/acceptance-setup.ts:456` and `src/execution/runner-completion.ts:171`. Consumer: the skip at `src/pipeline/stages/acceptance.ts:167-170`.

**US-004 — status propagation.** The chain mirrors how `failedACs` already travels: `ctx.acceptanceFailures` (`acceptance.ts:309`) → `AcceptanceLoopResult` (`src/execution/lifecycle/acceptance-loop.ts:82`) → `setPostRunPhase("acceptance", …)` (`src/execution/runner-completion.ts:221` and `:238`) → `AcceptancePhaseStatus` (`src/execution/status-file.ts:22`).

Every field added along this chain is **optional**, so no existing literal construction of these types breaks.

⚠️ **`src/execution/lifecycle/acceptance-loop.ts` is 579 of the 600-line source limit — 21 lines of headroom.** Thread the new field through; do not add helper functions to this file. If the change would exceed the limit, extract to `src/execution/lifecycle/acceptance-helpers.ts` (existing, 8.6K) rather than growing it.

### Why a missing file is sometimes legitimate

A missing acceptance test is a failure **only** when both conditions hold: the group has at least one story in the PRD, and acceptance is enabled for that group's package. Three existing behaviors make the guard necessary rather than optional:

- **Root `acceptance.enabled: false`** — `acceptanceStage.enabled()` (`acceptance.ts:100-106`) already returns `false`, so `execute` never runs and the new failure is unreachable. Pinned by an AC rather than assumed.
- **Per-package `acceptance.enabled: false`** — currently ignored entirely: `acceptance-setup.ts:181` and `features-acceptance.ts:71` both read only the root value, so such a package still gets a group and still gets a file generated. Honoring it in the new failure predicate prevents this feature from converting a currently-ignored setting into a run-breaking one.
- **The empty root group** — `groupStoriesByPackage` synthesizes a zero-story root group when the PRD has no non-fix stories (`test-path.ts:151-153`) so the RED gate still runs. `storyCount === 0` keeps that a skip.

`acceptance.generateTests` is **not** used as an exemption signal: it is declared in `schemas-infra.ts:41` and `runtime-types.ts:305` but has zero non-test readers, so it gates nothing today.

### Failure Handling

| Condition | Behavior |
|:---|:---|
| `git checkout --` fails while restoring a deleted `.nax/` path | Fail-open — log at `error`, continue to stage and commit. US-003's gate is the backstop; auto-commit is best-effort by contract (its whole body is wrapped in a `catch` that ignores). |
| `git status --porcelain` emits a line the parser cannot interpret | Ignore that line, continue processing the rest. A malformed line must never abort the commit. |
| Acceptance target missing, group has stories, acceptance enabled | Fail-closed — stage returns `action: "fail"`, `status.json` records `failed` with the package list. |
| Acceptance target missing, group has zero stories or acceptance disabled | Skip, logged at `warn` as today. |

## Out of Scope

- Making acceptance test **generation** honor per-package `acceptance.enabled`; this feature honors that flag only in the missing-target failure predicate, leaving `acceptance-setup.ts:181` reading the root value as it does today.
- Reviving the dead `acceptance.generateTests` config key, which is declared in the schema but has no non-test readers.
- Moving the generated acceptance test out of `.nax/` into the package's own test tree.
- Adding a `protectedPaths` parameter to `autoCommitIfDirty`; detection is structural and requires no signature change.
- Adding an `incomplete` value to the `PostRunPhaseStatus` union; a missing target is reported as `failed` plus a `skippedPackages` list.
- Changing the rectifier's existing `.nax/` citation paragraph in `rectifier-builder-helpers.ts`.
- Restoring `.nax/` files deleted by any path other than `autoCommitIfDirty`, such as a direct agent commit that the orchestrator never auto-commits.
- US-002 only: atomicity of the check-then-act sequence between reading `git status` and running `git add` is out of scope — the restore is best-effort and a concurrent writer could re-delete the path in that window.
- Detecting acceptance targets deleted in earlier runs and already merged to the base branch.

## Stories

1. **US-001: `.nax/` immutability guard in code-touching role prompts** — no dependencies
2. **US-002: auto-commit restores deleted `.nax/` artifacts before staging** — no dependencies
3. **US-003: a missing acceptance target fails the acceptance stage** — no dependencies
4. **US-004: skipped packages reach `status.json`** — depends on US-003

US-003 and US-004 are deliberately **not merged**, though US-004 is meaningless alone. Merging would produce a story whose `Context Files` list exceeds the 5-entry cap (it would span `src/pipeline/` and `src/execution/` reference files), which is a Must-split rule and therefore overrides the Must-merge signal. Combined AC count would be 14, under the project's `maxAcCount` of 16, so the AC cap is *not* the justification — the context-file breach is.

### Context Files

**US-001**
- `src/prompts/sections/behavioral-guardrails.ts` — role-keyed section pattern to mirror
- `src/prompts/sections/index.ts` — barrel export pattern
- `src/prompts/builders/tdd-builder.ts` — composition site for test-writer/implementer/verifier
- `src/prompts/builders/rectifier-builder-helpers.ts` — `buildEscapeHatch`, the rectifier composition site
- `test/unit/prompts/sections/role-task.test.ts` — existing section test patterns

**US-002**
- `src/utils/git.ts` — `autoCommitIfDirty` and the `_gitDeps` injection point
- `test/unit/utils/git.test.ts` — existing `_gitDeps` mocking patterns

**US-003**
- `src/pipeline/stages/acceptance.ts` — the skip site and verdict derivation
- `src/acceptance/test-path.ts` — `AcceptanceTestGroup` and `groupStoriesByPackage`
- `src/pipeline/stages/acceptance-setup.ts` — first producer of `acceptanceTestPaths`
- `src/execution/runner-completion.ts` — second producer, and where `groupConfig` is loaded
- `test/unit/pipeline/stages/acceptance.test.ts` — existing stage test patterns

**US-004**
- `src/execution/lifecycle/acceptance-loop.ts` — `AcceptanceLoopResult` shape
- `src/execution/status-file.ts` — `AcceptancePhaseStatus` shape
- `src/execution/runner-completion.ts` — the two `setPostRunPhase("acceptance", …)` call sites
- `src/pipeline/stages/acceptance.ts` — created by US-003's changes, read here for the `skippedPackages` source

### Creates

**US-001**
- `src/prompts/sections/nax-artifacts.ts` — the shared immutability section

**US-002**
- `test/unit/utils/git-nax-artifact-guard.test.ts` — porcelain parsing and restore behavior

**US-003**
- `test/unit/pipeline/stages/acceptance-missing-target.test.ts` — sibling suite; `acceptance.test.ts` is at 612 of the 800-line test limit and cannot absorb this story's cases

### Modifies

**US-001**
- `src/prompts/sections/index.ts`
- `src/prompts/builders/tdd-builder.ts`
- `src/prompts/builders/rectifier-builder-helpers.ts`

**US-002**
- `src/utils/git.ts`

**US-003**
- `src/pipeline/types.ts`
- `src/pipeline/stages/acceptance.ts`
- `src/pipeline/stages/acceptance-setup.ts`
- `src/execution/runner-completion.ts`

**US-004**
- `src/execution/lifecycle/acceptance-loop.ts`
- `src/execution/status-file.ts`
- `src/execution/runner-completion.ts`

### Seams

- **US-003 → US-004:** US-003 populates a `skippedPackages` list on the acceptance failure record; US-004's `[integration]` AC drives the completion path and asserts the value reaches `setPostRunPhase`. Declared in US-004's ACs.

## Acceptance Criteria

### US-001: `.nax/` immutability guard in code-touching role prompts

- [unit] `buildNaxArtifactsSection("test-writer")` returns a string containing the sentence that files under `.nax/` must never be moved, renamed, or deleted.
- [unit] `buildNaxArtifactsSection` returns a non-null string for each of `"test-writer"`, `"implementer"`, and `"verifier"` — unlike `buildBehavioralGuardrailsSection`, which returns `null` for `"verifier"`.
- [unit] the section returned by `buildNaxArtifactsSection` states that a test under `.nax/` is not a reason to skip writing source-tree tests, and that a source-tree test is not a reason to remove it.
- [integration] a prompt built by `TddPromptBuilder` for the `test-writer` role includes the `.nax/` immutability text.
- [integration] a prompt built by `TddPromptBuilder` for the `verifier` role includes the `.nax/` immutability text.
- [integration] a rectifier prompt built through `RectifierPromptBuilder` includes the `.nax/` immutability text.

**Out of scope:** wording differences between isolation modes (`lite` vs standard) — the section is identical for both, matching `buildBehavioralGuardrailsSection`'s current behavior where `_variant` and `_isolation` are accepted but unused.

### US-002: auto-commit restores deleted `.nax/` artifacts before staging

- [unit] the porcelain parser returns `apps/web/.nax/features/f/.nax-acceptance.test.tsx` as a protected path when given a status line marking that path deleted.
- [unit] the porcelain parser returns the **old** path, not the new one, for a rename status line moving a file out of `.nax/`.
- [unit] the porcelain parser returns an empty result for a status line marking a `.nax/` file modified rather than deleted.
- [unit] the porcelain parser returns an empty result for a deleted path outside `.nax/`, such as `src/legacy.ts`.
- [unit] the porcelain parser returns the unquoted path when git quotes a deleted `.nax/` path containing a space.
- [unit] the porcelain parser skips a line it cannot interpret and still returns protected paths from the remaining lines.
- [integration] when `git status --porcelain` reports a deleted file under `.nax/`, `autoCommitIfDirty` runs a `git checkout` restoring that path before running `git add`.
- [integration] when a deleted `.nax/` path is restored, `autoCommitIfDirty` logs at `error` level with `storyId` as the first field in the log payload.
- [integration] when `git status --porcelain` reports only changes outside `.nax/`, `autoCommitIfDirty` runs no `git checkout` and commits as it does today.
- [integration] when the `git checkout` restore exits non-zero, `autoCommitIfDirty` still runs `git add` and `git commit`.

### US-003: a missing acceptance target fails the acceptance stage

- [unit] the acceptance stage returns `action: "fail"` when a test group whose `storyCount` is 1 and whose `acceptanceEnabled` is `true` has no file at its `testPath`.
- [unit] the failure reason names the `packageDir` of every group whose acceptance target was missing.
- [unit] the acceptance stage returns `action: "continue"` when the only group with a missing target has `storyCount` of 0.
- [unit] the acceptance stage returns `action: "continue"` when the only group with a missing target has `acceptanceEnabled` of `false`.
- [unit] when a group with a missing target omits `storyCount` entirely, the acceptance stage derives the count from `ctx.prd` and still returns `action: "fail"` for a package that has one non-fix story.
- [unit] when a group with a missing target omits `acceptanceEnabled` entirely, the acceptance stage treats acceptance as enabled and returns `action: "fail"`.
- [unit] a group whose acceptance target is missing contributes no entries to the failed acceptance criteria list, so the reason distinguishes a missing target from a failing test.
- [unit] `acceptanceStage.enabled()` returns `false` when `config.acceptance.enabled` is `false`, so the missing-target failure is unreachable for a root-disabled run.
- [unit] when every group has its acceptance target present and passing, the stage returns `action: "continue"` as it does today.
- [integration] `acceptance-setup` populates each entry of `ctx.acceptanceTestPaths` with a `storyCount` equal to the number of PRD stories grouped into that package.
- [integration] `runner-completion` populates each acceptance test path entry with `acceptanceEnabled` resolved from that package's own config rather than the root config.

**Out of scope:** honoring per-package `acceptance.enabled` during test **generation** — this story reads the flag only in the missing-target predicate.

### US-004: skipped packages reach `status.json`

- [unit] `AcceptanceLoopResult` carries the list of packages whose acceptance target was missing when the acceptance stage failed for that reason.
- [integration] stub the acceptance stage to fail with one missing package; drive the completion phase; assert `setPostRunPhase` is called for `"acceptance"` with a status of `"failed"` and a `skippedPackages` list containing that package.
- [integration] when acceptance fails because a target was missing, `setPostRunPhase` is never called for `"acceptance"` with a status of `"passed"`.
- [integration] when acceptance passes with every target present, the recorded acceptance status is `"passed"` and carries no skipped packages.
- [integration] a run resumed against a `status.json` whose acceptance status is `"failed"` with a non-empty skipped-package list re-runs the acceptance phase rather than skipping it.
