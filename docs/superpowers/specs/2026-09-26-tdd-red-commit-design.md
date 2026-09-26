# SPEC: TDD RED commit: nax commits the test-writer's tests, and the prompt stops demanding a typecheck it cannot pass

## Summary

Two changes to the `three-session-tdd` / `three-session-tdd-lite` test-writer handoff.

**B (mechanical).** When a test-writer phase completes, the story orchestrator commits the files the phase
changed. Only those files are staged, taken from the same git-derived list the isolation check uses. The commit
runs **without the repository's git hooks** (`--no-verify`), the same way `src/finish/commit.ts` already commits
its internal checkpoints. A new knob, `tdd.testWriterCommitHooks: "skip" | "run"` (default `"skip"`), restores
the hooks for repositories that want them on every commit.
- The commit gives the implementer's isolation check the clean boundary `src/operations/write-test.ts` says is
  "not realised".
- The test-writer no longer depends on a pre-commit hook it cannot satisfy.
- `quality.commands`, the review checks and the deferred regression gate remain the mechanical gate, and they
  are unchanged.

**A (prompt).** The strict test-writer role text stops demanding the impossible.
- A type error that exists only because the implementer has not yet added a symbol the acceptance criteria
  require is the expected RED state.
- The test-writer must not work around it with casts, type-checker suppression comments, allow-list tags or
  throwaway type-probe scripts.
- Both test-writer variants are told that nax commits their tests when the session ends, so they do not commit
  themselves. `GitCommit` is removed from the test-writer's declared tools.

## Motivation

Verified on `main` @ `7c21771ab`, and against the R17+R19 A/B run on 2026-09-26: 5 runs of one story
(nax#2227, 24 ACs, `three-session-tdd`) against the nax repository itself, all of which passed.

**The strict test-writer prompt contradicts itself on typed repositories.** `buildRoleTaskSection("test-writer", ...,
isolation "strict")` in `src/prompts/sections/role-task.ts` says both of these:
- "Do NOT create or modify any source files. Read source for types/interfaces only."
- "Confirm every test fails with an ASSERTION failure — NOT an import error, compile error, or runtime crash
  before assertion."

When an acceptance criterion adds a field to an existing type (here `exitCode` on `ToolResult.audit` and
`ToolCallRecord`), both cannot hold.
- The runtime RED is fine: `bun test` does not typecheck, so the tests fail at their assertions.
- Only `tsc` objects. The nax repo's `.githooks/pre-commit` runs `bun run typecheck` (including
  `tsconfig.test.json`) and `bun run check:all`, which counts `as unknown as` casts against a baseline of 0.

Only the `lite` variant allows stubs, and the strict test-writers never tried writing a `src/` stub: 0 `src/`
writes, 0 denials.

**The strict test-writer is most of the run, and what it does with the conflict depends on the model:**

| run | test-writer | run billed | test-writer billed (share) | what it did with the typecheck gate |
|---|---|---|---|---|
| ctl-r1 | MiniMax-M3 | 35.5M | 29.5M (83%) | GitCommit failed at round trips 114, 153, 190; 67% of its tokens came after the first failure (14 `/tmp` type probes, 49 gate runs) |
| ctl-r2 | MiniMax-M3 | 22.8M | 16.8M (74%) | never committed; the implementer's commit carried the tests |
| trt-r1 | MiniMax-M3 | 43.1M | 34.0M (79%) | never committed; 27 `/tmp` probes, 87 gate runs |
| trt-r2 | MiniMax-M3 | 34.4M | 28.5M (83%) | tagged 3 `as unknown as` casts `// test-ratchet-allow`; `ratchetAllow` rose from 26 to 30 and the casts were left in the merged code |
| trtds-r1 | deepseek-v4.1-flash | 7.9M | 3.4M (43%) | hit `TS2339` in the pre-commit typecheck, then ran `git commit --no-verify` two steps later |

- **This isn't just the one story.** Across 35 native test-writer sessions on the nax repo, 10 had at least one
  failed commit. deepseek-v4.1-flash test-writers failed commits in 7 of 24 sessions, including the largest
  test-writer session on record: 43.8M, 306 round trips, first failed commit at round trip 75.
- **When the test-writer does not commit, the implementer's isolation check sees the tests as its own changes.**
  `runPhase` captures each TDD phase's `beforeRef` at phase start
  (`src/execution/story-orchestrator/run-phase.ts`), and `write-test.ts` documents that the committed boundary
  "is not realised until the prompt gains that step". Isolation is advisory (logged, never enforced), so the
  check still runs; it just checks against the wrong baseline.
- **Precedent for a hook-less internal commit:** `commitWorkingTree` in `src/finish/commit.ts` adds
  `--no-verify` for every mid-loop checkpoint, because "a repo whose pre-commit hook runs lint or typecheck
  would otherwise reject an intermediate state". A RED test suite is exactly such an intermediate state.

## Design

### Approach

- **B: one new module, `src/tdd/red-commit.ts`.** It exports `commitRedState` and its injectable deps. It stages
  and commits the test-writer phase's changed files. `runPhase` calls it once, after a successful test-writer
  phase of a three-session strategy and before the phase returns, so the implementer phase's `beforeRef`
  capture sees the commit.
- **A: text-only.** The change is in `src/prompts/sections/role-task.ts`, plus one line removed from
  `testWriterOp.tools` in `src/operations/write-test.ts`.
- **Why a new module:** `src/utils/git.ts` (598 lines) and `src/agents/coding-tool-support.ts` (596) sit at the
  600-line file-size gate, so neither may grow. `autoCommitIfDirty` is not reused, because it stages `git add -A`
  (every dirty path in the repository), while the RED commit must stage only the phase's own files.

### Integration

Symbols this feature **reads** (unchanged):
- `getChangedFiles(workdir, fromRef)` (`src/tdd/isolation.ts`): git diff against `fromRef` merged with untracked
  files. It is the list `verifyTestWriterIsolation` classifies.
- `gitlinkSafeAdd`, `hasStagedChanges` (`src/utils/git-add.ts`) and `gitWithTimeout` (`src/utils/git.ts`): the
  staging/commit primitives `GitCommit` and `autoCommitIfDirty` use.
- `NAX_GITIGNORE_ENTRIES` (`src/utils/gitignore.ts`): nax-owned artifact patterns. The partition logic in
  `src/tools/git-commit.ts` (`partitionNaxOwnedPaths`, file-local today) classifies paths against them.
- `CallContext` in `runPhase`:
  - `ctx.packageDir`: the phase workdir, the same one used for `beforeRef`
  - `ctx.storyId`
  - `ctx.config.tdd`
  - `ctx.runtime.dryRun`
  - `ctx.runtime.dirtyWorktrees`: worktrees that may hold an unreverted mutation

Symbols this feature **changes**:
- `TddConfigSchema` (`src/config/schemas-execution.ts`): gains
  `testWriterCommitHooks: z.enum(["skip", "run"]).optional()`. The value is resolved as `?? "skip"` at the one
  consumer. The `tdd` default literal in `src/config/schemas.ts` is unchanged.
- `src/cli/config-descriptions.ts`: gains a description for `tdd.testWriterCommitHooks`.
- `runPhase` (`src/execution/story-orchestrator/run-phase.ts`): calls `commitRedState` after a successful
  test-writer phase, through `_storyOrchestratorDeps.commitRedState` so tests can inject it.
- `testWriterOp.tools` (`src/operations/write-test.ts`): loses `"GitCommit"`, and the comment above it is
  rewritten to say nax commits the RED state.
- `buildRoleTaskSection` (`src/prompts/sections/role-task.ts`): the strict and lite test-writer text changes as
  described under Prompt text.
- `partitionNaxOwnedPaths` (`src/tools/git-commit.ts`): exported, and re-exported from `src/tools/index.ts`, so
  the RED commit and `GitCommit` share one classifier. Its behaviour is unchanged.

### `commitRedState`

```ts
export interface RedCommitOptions {
  readonly workdir: string;            // ctx.packageDir
  readonly beforeRef: string;          // the test-writer phase's own beforeRef
  readonly storyId: string;
  readonly hooks: "skip" | "run";      // ctx.config.tdd?.testWriterCommitHooks ?? "skip"
  readonly dryRun: boolean;            // ctx.runtime.dryRun
  readonly blockedWorktrees?: ReadonlySet<string>; // ctx.runtime.dirtyWorktrees
}
export type RedCommitResult =
  | { readonly status: "committed"; readonly files: readonly string[]; readonly hooksSkipped: boolean }
  | { readonly status: "skipped"; readonly reason: "dry-run" | "blocked-worktree" | "nothing-to-commit" }
  | { readonly status: "failed"; readonly reason: string };
export async function commitRedState(opts: RedCommitOptions, deps?: RedCommitDeps): Promise<RedCommitResult>;
```

Ordered steps:
1. `dryRun` returns `skipped/dry-run`, with no git call.
2. If `blockedWorktrees` contains the workdir's git root (compared by realpath, as `autoCommitIfDirty` does), it
   returns `skipped/blocked-worktree` and logs an error, with the same hint text as `autoCommitIfDirty`.
3. It gets `files = getChangedFiles(workdir, beforeRef)`. A throw returns `failed` with the error message.
4. It partitions `files` with `partitionNaxOwnedPaths` and keeps only the `kept` paths. Nax-owned and
   unclassifiable paths are never staged.
5. With nothing kept, it returns `skipped/nothing-to-commit`.
6. It stages the kept paths with `gitlinkSafeAdd` (pathspecs after `--`). A non-zero exit returns `failed`.
7. If `hasStagedChanges` is not `true`, it returns `skipped/nothing-to-commit`. This covers a test-writer that
   already committed its own work.
8. It commits with `["commit", "-m", message, ...(hooks === "skip" ? ["--no-verify"] : [])]`, where `message` is
   `` `chore(${storyId}): auto-commit after test-writer session (RED)` ``. A non-zero exit returns `failed` with
   stderr (for example, a hook that rejects the commit under `"run"`).
9. It returns `committed` with the staged files and `hooksSkipped: hooks === "skip"`.

`commitRedState` never throws. Every git call is time-bounded, as `autoCommitIfDirty` bounds its calls.

**In `runPhase`:** when `isTddPhase && opName === "test-writer" && !inRectification && beforeRef` and the phase
succeeded, it calls `commitRedState` and logs one line on the `tdd` stage, with `storyId`, `status`, the file
count, `hooksSkipped` and `reason`:
- `info` "RED state committed" for `committed`
- `debug` for `skipped`
- `warn` "RED state not committed" for `failed`

The phase's outcome, output and costs are unchanged by any result.

### Prompt text

**Strict test-writer** (`isolation === "strict"`, the default branch):
- Workflow step 5 becomes: "Run the new test files. Confirm every test fails with an ASSERTION failure, not an
  import error or a runtime crash before the assertion. A test that errors before reaching its assertion does
  not prove the behavior is missing."
- New rule, right after "Do NOT create or modify any source files...": "A type-check error that exists only
  because the implementer has not yet added a field, parameter or export the acceptance criteria require is the
  expected RED state. Do not work around it with type casts, type-checker suppression comments, allow-list tags
  or throwaway type-probe scripts; type each test as the finished code will be."
- New rule: "Do not commit. When your session ends, nax commits the files you changed as the RED state."

**Lite test-writer** (`isolation === "lite"`): gains only the "Do not commit..." rule. Its workflow already has it
write stubs so the tests compile, and that text is unchanged.

Both texts stay language-neutral (ADR-009): no `as unknown as`, `@ts-expect-error`, `tsc` or other TS-specific
tokens.

### Failure Handling

| Case | Behaviour |
|---|---|
| Dry run | `skipped/dry-run`; no git call |
| Workdir's git root is in `runtime.dirtyWorktrees` | `skipped/blocked-worktree`; error log with the manual-restore hint; nothing staged |
| `getChangedFiles` throws (git failure or timeout) | `failed`; warn log; the implementer phase runs against today's uncommitted state |
| Every changed path is nax-owned or unclassifiable | `skipped/nothing-to-commit`; nothing staged |
| Test-writer already committed everything itself | `skipped/nothing-to-commit` (step 7) |
| `hooks: "run"` and the repository's hook rejects the commit | `failed` with the hook's stderr; files stay staged-but-uncommitted, as today when a hook rejects |
| Test-writer phase failed or threw | `commitRedState` is not called |
| Rectification re-dispatch of the test-writer (`inRectification`) | not called |
| Single-session / `tdd-simple` / `batch` strategies | not called (`isTddPhase` is false or the op is not `test-writer`) |

## Out of Scope

- Changing `quality.commands`, review checks, the deferred regression gate or the verifier: they remain the
  mechanical gate and still run every hook-covered check (typecheck, lint, `check:all`) after the implementer.
- Blocking the test-writer from running `git commit` through `Bash`. The prompt tells it not to commit; a Bash
  commit still runs the repository's hooks, as today. Rewriting a shell command, or setting `core.hooksPath` in
  the sandbox environment, is not part of this feature.
- Allowing type-only stubs in strict isolation. Telling a declaration-only change apart from logic mechanically
  is not attempted.
- Any change to the nax repository's own `.githooks/pre-commit` or `test-ratchets` rule.
- Changing isolation from advisory to enforced, or changing `verifyTestWriterIsolation` /
  `verifyImplementerIsolation`.
- Measuring the effect: a follow-up A/B on the `ab-r17r19` seed is expected, but it is not part of this feature.
- The `autofix-test-writer`, `rectify` and `test-fix` roles, and every non-test-writer prompt.
- Removing the `test-ratchet-allow` misuse left in any past branch.

## Stories

1. **US-001: nax commits the test-writer's RED state** (no dependencies).
   - Creates `src/tdd/red-commit.ts`.
   - Exports `partitionNaxOwnedPaths`.
   - Adds `tdd.testWriterCommitHooks` to the schema and the config descriptions.
   - Wires `runPhase`.
2. **US-002: test-writer role text and tools** (depends on US-001, because the new "nax commits" sentence is
   only true once US-001 ships).
   - Edits the strict and lite test-writer text in `role-task.ts`.
   - Removes `GitCommit` from `testWriterOp.tools` and rewrites its comment.

### Context Files

**US-001**
- `src/execution/story-orchestrator/run-phase.ts`: `runPhase`, `isTddPhase`, `beforeRef` capture,
  `_storyOrchestratorDeps`
- `src/tdd/isolation.ts`: `getChangedFiles`
- `src/tools/git-commit.ts`: `partitionNaxOwnedPaths`, and the staging sequence to mirror
- `src/utils/git.ts`: `autoCommitIfDirty` (the dry-run guard, blocked-worktree guard and timeout constant to
  mirror)
- `src/utils/git-add.ts`: `gitlinkSafeAdd`, `hasStagedChanges`
- `src/finish/commit.ts`: the `skipHooks` / `--no-verify` precedent and its rationale comment
- `src/config/schemas-execution.ts`: `TddConfigSchema`
- `src/cli/config-descriptions.ts`
- `test/unit/execution/story-orchestrator/`: existing `runPhase` tests and how `_storyOrchestratorDeps` is
  swapped

**US-002**
- `src/prompts/sections/role-task.ts`
- `src/operations/write-test.ts`
- `test/unit/prompts/sections/role-task.test.ts`
- `test/unit/operations/tdd-session-op-tools.test.ts`

### Creates

**US-001**
- `src/tdd/red-commit.ts`: `commitRedState`, `RedCommitOptions`, `RedCommitResult`, `_redCommitDeps`
- `test/unit/tdd/red-commit.test.ts`: `commitRedState` unit tests against a real temp git repo with a failing
  pre-commit hook
- `test/unit/execution/story-orchestrator/run-phase-red-commit.test.ts`: `runPhase` wiring tests

### Modifies

**US-002**
- `test/unit/operations/tdd-session-op-tools.test.ts`:
  - The test "can commit its own RED state so the implementer's beforeRef is a clean boundary" asserts
    `resolveDeclaredTools(testWriterOp)` contains `"GitCommit"`.
  - Replacing invariant: the clean boundary is now made by the orchestrator's RED commit (US-001), and the
    test-writer no longer holds `GitCommit`.
  - Rename the test to say so, and flip it to `not.toContain("GitCommit")`.
  - The comment in "can run the tests it wrote" says the role distinguishes "an ASSERTION failure from an import
    or compile error". Reword it to "from an import error or a runtime crash before the assertion", to match
    the new step 5. The `RunCommand` assertion is unchanged.
- No existing test asserts the old strict step-5 sentence (verified: no match for "compile error, or runtime
  crash" or "Do NOT create or modify any source files" under `test/`).

### Seams

- `runPhase` -> `commitRedState`: US-001 ACs drive a real `runPhase` with an injected `callOp` returning a
  successful test-writer output, and a spy `commitRedState`.
- `commitRedState` -> git: US-001 ACs use a real temporary git repository whose `.git/hooks/pre-commit` exits 1,
  so `--no-verify` is proven by a commit that would otherwise fail.
- US-001 -> US-002: the prompt's "nax commits the files you changed" is covered by US-001's wiring ACs; US-002
  asserts only text and tool lists.

## Acceptance Criteria

### US-001: nax commits the test-writer's RED state

1. [unit] In a temp git repo with one commit (`beforeRef`) and a `.git/hooks/pre-commit` that exits 1, after
   creating `test/a.test.ts`, `commitRedState({ workdir, beforeRef, storyId: "US-001", hooks: "skip", dryRun:
   false })` returns `{ status: "committed", files: ["test/a.test.ts"], hooksSkipped: true }`.
2. [unit] After AC 1, `git log -1 --format=%s` is `chore(US-001): auto-commit after test-writer session (RED)` and
   `git status --porcelain` is empty.
3. [unit] The same fixture with `hooks: "run"` returns `status: "failed"` with a `reason` containing the hook's
   stderr text, and `git log -1` still names the `beforeRef` commit.
4. [unit] With `test/a.test.ts` created after `beforeRef` and an untracked file `scratch.txt` placed in a directory
   covered by a `.gitignore` entry committed at `beforeRef`, `git show --name-only HEAD` after the call lists
   `test/a.test.ts` and no other file: only `getChangedFiles(workdir, beforeRef)`'s paths are staged, never an
   `add -A` of the tree.
5. [unit] A changed path under `.nax/scratchpad/` is not committed: it is absent from the result's `files` and
   from `git show --name-only HEAD`, while `test/a.test.ts` from the same call is present.
6. [unit] When every changed path is under `.nax/scratchpad/`, the result is `{ status: "skipped", reason:
   "nothing-to-commit" }` and `git log -1` still names `beforeRef`.
7. [unit] When the test-writer's files are already committed after `beforeRef` (a second commit exists and the
   tree is clean), the result is `{ status: "skipped", reason: "nothing-to-commit" }` and no third commit exists.
8. [unit] `dryRun: true` returns `{ status: "skipped", reason: "dry-run" }`, and the injected git runner records
   zero calls.
9. [unit] `blockedWorktrees` containing the repo's root (given as a symlinked path to it) returns `{ status:
   "skipped", reason: "blocked-worktree" }` and nothing is committed.
10. [unit] An injected `getChangedFiles` that throws makes `commitRedState` resolve (not reject) to `status:
    "failed"` with the thrown message as `reason`.
11. [unit] `TddConfigSchema.parse({ maxRetries: 2 })` leaves `testWriterCommitHooks` undefined;
    `TddConfigSchema.parse({ maxRetries: 2, testWriterCommitHooks: "run" })` keeps `"run"`; and
    `testWriterCommitHooks: "never"` fails to parse.
12. [unit] `runPhase` for a three-session strategy (`isThreeSession: true`), with a test-writer slot whose
    injected `callOp` resolves a successful output and an injected `commitRedState` spy, calls the spy once with
    `workdir === ctx.packageDir`, `beforeRef` equal to the ref the injected `captureGitRef` returned,
    `storyId === ctx.storyId` and `hooks: "skip"` when `ctx.config.tdd.testWriterCommitHooks` is unset.
13. [unit] The AC 12 setup with `ctx.config.tdd.testWriterCommitHooks: "run"` passes `hooks: "run"`.
14. [unit] `runPhase` does not call the spy when the test-writer's `callOp` rejects, when `isThreeSession` is
    false, when `inRectification` is true, or when the slot's op is `implementer`.
15. [unit] A spy resolving `{ status: "failed", reason: "x" }` leaves `runPhase`'s return value and the
    `phaseOutputs["test-writer"]` entry identical to a run where the spy resolves `committed`.
16. [unit] `tdd.testWriterCommitHooks` has an entry in the config descriptions map (`src/cli/config-descriptions.ts`).

### US-002: test-writer role text and tools

1. [unit] The strict test-writer text (`buildRoleTaskSection("test-writer", undefined, "bun test", "strict")`)
   contains "Confirm every test fails with an ASSERTION failure, not an import error or a runtime crash before
   the assertion."
2. [unit] The strict test-writer text does not contain the phrase "compile error".
3. [unit] The strict test-writer text contains "is the expected RED state" and "type each test as the finished
   code will be".
4. [unit] The strict test-writer text still contains "Do NOT create or modify any source files".
5. [unit] Both the strict and the lite test-writer texts contain "Do not commit. When your session ends, nax
   commits the files you changed as the RED state."
6. [unit] The lite test-writer text still contains "Confirm tests compile (stubs work) AND fail with ASSERTION
   failures".
7. [unit] Neither test-writer text contains `as unknown`, `ts-expect-error`, `tsc` or `@ts-`.
8. [unit] `testWriterOp.tools` does not contain `"GitCommit"`, and still contains `"Read"`, `"Write"`, `"Edit"`
   and `"RunCommand"`.
9. [unit] None of the implementer, verifier, `tdd-simple`, `batch` or `no-test` role texts contains "is the expected
   RED state" or "nax commits the files you changed".
