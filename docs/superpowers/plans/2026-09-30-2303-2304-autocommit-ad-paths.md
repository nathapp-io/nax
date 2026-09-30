# autoCommitIfDirty AD resurrection (#2303) and precheck fixture leak (#2304) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the snapshot auto-commit from resurrecting `.nax/` paths that were never committed (#2303), and stop `cli-precheck-command.test.ts` from being able to stage fixture files into nax's own index (#2304).

**Architecture:** One failure seen from both ends. #2304 is the cause: an in-tree fixture whose unchecked `git init` can fall through to the enclosing nax repo. #2303 is the damage: `parsePorcelainForNaxPaths` treats the resulting `AD` entries as agent-deleted nax state and `git checkout`s them back. Fix the parser (production), then the fixture (test hygiene). Two commits, one PR.

**Tech Stack:** TypeScript, Bun test runner, `git` via `gitWithTimeout` / `gitSpawnEnv`.

**Spec:** https://github.com/nathapp-io/nax/issues/2303 and https://github.com/nathapp-io/nax/issues/2304 (companions; #2303 links #2304).

**Base:** branch `fix/autocommit-ad-paths`, worktree `repos/nax-fix-autocommit-ad-paths` (created under `.worktrees/`, moved out of it because of #2306), cut from `origin/main` `0172f9ca3`.

## Handover state (as of 2026-09-30)

Implemented, verified and committed. Every task below is done; see "As built" for where the result differs from the plan.

- **Work here, not in the main checkout.** `~/workspace/subrina-coder/projects/nax/repos/nax` is on `feat/project-trust-gate` with uncommitted changes and is under active development. Do not touch it.
- Dependencies are installed. Baseline before any change: `test/unit/utils` plus `cli-precheck-command`, 532 pass / 0 fail.
- **`check:complexity` scans zero files inside `.worktrees/`** (filed as #2306): it reports the whole baseline as stale and hid a real breach here. Keep worktrees outside `.worktrees/` (siblings under `repos/`), or verify that gate from a checkout outside the repo tree.
- Use the repo test commands (`bun run test:*`, `bun run check:all`), never bare `bun test`. `typecheck` is not part of `check:all`; run it separately.
- Repo file-size gate is 600 lines; neither touched source file is near it.
- This repo is public. Do not name private projects in the PR body or issue comments.

## As built (differences from the plan)

- **Restore loop extracted (Task 3).** `src/utils/git.ts` was 598 of 600 lines, so the whole `.nax/` restore loop moved to `src/utils/nax-path-restore.ts` (`restoreDeletedNaxPaths`, git runner injected to avoid a cycle with `git.ts`). `git.ts` is now 567 lines. Log messages, fields, ordering and cwd are unchanged; a review diffed them against the original loop.
- **HEAD guard fails open.** Skips only on exit 128 (git's "no such object", also an unborn HEAD). Any other non-zero exit (`gitWithTimeout` reports a timeout as 1) attempts the restore as before. Found in review: treating every non-zero as "not in HEAD" would silently skip a real restore on a slow repo.
- **Parser classification extracted.** The `A` skip added 2 to `parsePorcelainForNaxPaths` (22 to 24) and breached the complexity ratchet. The status test moved into a `restorableKind` helper, the function fell below the limit, and `scripts/baselines/complexity-baseline.json` was lowered (only the `parsePorcelainForNaxPaths` entry, as the gate requires).
- **Tests.** Parser cases in `git.test.ts` (with the `captureSpawn` stub answering `cat-file` with exit 0 and no output slot); fake-runner unit tests in the new `nax-path-restore.test.ts`; the real-git describe was added to the existing `auto-commit.test.ts` rather than a new ticket-named file, per the test-placement rules. The real-git tests fail with both guards off; with only the parser guard off they still pass (the HEAD guard covers it), so the parser cases in `git.test.ts` are what pin the parser.
- **#2304.** `cli-precheck-command.test.ts` uses `makeTempDir` / `cleanupTempDir` and local `git()` / `initRepo()` / `commitAll()` helpers in the `migrate-tracked-candidates` style. `git()` throws on non-zero exit and sets `GIT_CEILING_DIRECTORIES` to the realpath of the fixture's parent; `initRepo` asserts `rev-parse --show-toplevel` equals the fixture dir. No shared helper was added. Manual negative check: with `GIT_DIR=/nonexistent/x` the tests fail with `git init -q exited 128`.
- **Verification (clean checkout, outside the repo tree).** `bun run typecheck` 0; `bun run check:all` 0; `bun run test` all phases passed (unit, integration, ui); `bun run test:coverage` OK (96.78% lines, 94.22% functions).
- **Known, not addressed.** An unmerged `AA` / `AU` entry is now also skipped by the `A` guard; neither was restored before, so nothing regresses.

## Findings that shape the plan

Verified on `0172f9ca3`:

- `src/utils/porcelain.ts:68` `isDeleted = xStatus === "D" || yStatus === "D"` has no guard on `xStatus === "A"`. `AD` therefore yields `{ staged: false }`, and `src/utils/git.ts` restores it with `git checkout -- <path>` (the index copy).
- `AM` is already ignored (neither column is `D` or `R`), but has no test. `AD` has no test either. `test/unit/utils/porcelain.test.ts` only covers `unquotePorcelainPath` and `splitRenameOldPath`; the `parsePorcelainForNaxPaths` cases live in `test/unit/utils/git.test.ts`, with spawn mocks.
- `cli-precheck-command.test.ts:20` is the only test that builds a fixture inside the repo and runs git there. Two other suites use in-tree dirs (`test/tmp/...` in `check-story-workdir-access`, `logs`, `cli-core-logs`), but none of them run git.
- `test/integration/cli/tmp-precheck-cli` is not gitignored.

### How other tests handle `git init` (checked for #2304)

- Every other test that runs `git init` (about 16 files) does it in a directory from the shared helper `makeTempDir` / `withTempDir` in `test/helpers/temp.ts`, which is `mkdtempSync(join(tmpdir(), prefix))`. A failed `git init` there cannot resolve to a parent repo. Only `cli-precheck-command` is in-tree.
- Only one of them checks the exit code: `test/integration/commands/migrate-tracked-candidates.test.ts`. It has local `git()` and `initRepo()` helpers, uses `expect(git(dir, ["init", "-q"]).code).toBe(0)`, and spawns with `env: gitSpawnEnv()`.
- The rest fire and forget (`await Bun.spawn(["git","init"], ...).exited`, or a bare `Bun.spawnSync`) and ignore the code. `cli-precheck-run.test.ts` avoids per-test `git init` by copying a template `.git`.
- No shared repo-init helper exists, and no test uses `GIT_CEILING_DIRECTORIES`.

Consequence: follow the repo's existing convention (`makeTempDir` / `cleanupTempDir`, exit-code check in the `migrate-tracked-candidates` style) rather than inventing a new mkdtemp wrapper. The sibling precheck tests already sit in tmpdir and are not leaking; they are left alone (see Out of scope).

## Task 0: Baseline

- [ ] `bun install` in the worktree.
- [ ] Run the repo's unit and integration commands for `test/unit/utils` and `test/integration/cli`; record pass/fail counts here before any change.
- [ ] If the baseline is red, stop and report; do not proceed past a dirty baseline.

## Task 1: #2303 parser fix (TDD)

Files: `test/unit/utils/git.test.ts` (parser cases live here), `src/utils/porcelain.ts`.

- [ ] **Failing tests first**, next to the existing `parsePorcelainForNaxPaths` cases:
  - `AD .nax/config.json` returns `[]`.
  - `AM .nax/config.json` returns `[]`.
  - `AD` mixed with a real ` D .nax/prd.json` returns only the ` D` entry.
  - Regression guards still passing: ` D` (staged false), `D ` (staged true), `R ` old path, on `.nax/` paths.
- [ ] Run; confirm the `AD` cases fail (they currently return an entry).
- [ ] **Fix:** in `parsePorcelainForNaxPaths`, `continue` when `xStatus === "A"`, with a comment: a path added to the index was never in HEAD, so there is no nax state to protect and `git checkout` would resurrect a blob that was never committed. Update the function doc and the `staged` reasoning comment.
- [ ] Run; confirm green.

## Task 2: #2303 real-git test of `autoCommitIfDirty`

The existing tests mock spawn, so they cannot show that the tree ends clean. One real-git test proves it.

- [ ] Temp repo (via `makeTempDir`, `git init` exit code checked), one initial commit.
- [ ] Stage `.nax/features/x/prd.json` (`git add`), then delete it from the worktree, leaving `AD`.
- [ ] Run `autoCommitIfDirty`; assert the path is not restored on disk, is not in `git ls-tree HEAD`, and `git status --porcelain` is empty afterwards (the phantom index entry is dropped by `git add -A`).
- [ ] Confirm it fails on the pre-fix parser (temporarily revert Task 1's guard) and passes with it.

## Task 3: #2303 HEAD-existence guard (decision pending)

Defence in depth beyond the parser: in `src/utils/git.ts`, before each restore, run `git cat-file -e HEAD:<path>` and skip (log at debug) when the path is not in HEAD. One extra git call per candidate. This covers any other status combination that lacks a HEAD blob.

- [x] **Decided: included** (user accepted the recommendation). Test added with a mocked or real repo where the parser yields a path that is absent from HEAD and assert no `checkout` is spawned.

## Task 4: #2304 fixture rewrite

File: `test/integration/cli/cli-precheck-command.test.ts`.

- [ ] Replace `TEMP_DIR = join(import.meta.dir, "tmp-precheck-cli")` with a per-suite `makeTempDir("nax-precheck-cli-")` created in `beforeEach` and removed with `cleanupTempDir` in `afterEach` (the helpers in `test/helpers/temp.ts`, the repo convention). `setupTestProject(name)` builds its dirs under that root.
- [ ] Add a local `initRepo(dir)` in the `migrate-tracked-candidates` style: `git init -q`, `user.name`, `user.email`, each asserted `exitCode === 0` (throw with stderr, so a failure is loud), then assert `git rev-parse --show-toplevel` resolves to `dir` (realpath-compared; macOS `/var` vs `/private/var`). That last assertion is what turns a leak into a failed test.
- [ ] Spawn the fixture's git calls with `env: gitSpawnEnv({ GIT_CEILING_DIRECTORIES: dirname(dir) })` so they can never resolve to a parent repo. This is belt and braces now that the fixture is in tmpdir. `precheckCommand`'s own in-process git calls inherit `process.env` and are not covered; that is acceptable.
- [ ] Route the two `git add .` / `git commit` call sites (`:105`, `:136` and the equivalent repeats) through the same env and assert their exit codes.
- [ ] Remove any now-dead `import.meta.dir` / `mkdirSync` / `rmSync` imports.
- [ ] Run the file; all existing tests pass unchanged in behaviour.
- [ ] Negative check (manual, not committed): make `git init` fail (e.g. `PATH` without git, or a read-only dir) and confirm the test fails loudly instead of passing.
- [ ] `git status` in the worktree after the run shows no `tmp-precheck-cli` and no staged fixture files.

## Task 5: Verification and delivery

- [ ] `bun run check:all` and the separate typecheck, both green.
- [ ] Coverage command (separate from `check:all`) for `src/utils/porcelain.ts` and touched `git.ts` lines.
- [ ] `git diff origin/main...HEAD` review; then code-reviewer agent before push (review before push, not after).
- [ ] Two commits: `fix: skip never-committed paths when restoring .nax/ deletions (#2303)` and `test: build cli-precheck fixtures outside the repo and check git init (#2304)`.
- [ ] One PR, `Closes #2303`, `Closes #2304`. Push and PR only on explicit user approval.

## Out of scope

- Converting the other in-tree-safe suites (`cli-precheck-run`, `-integration`, `-checks`, and the other fire-and-forget `git init` users) to check exit codes. They run in tmpdir and cannot leak into the nax repo. A shared `initGitFixture` helper in `test/helpers/` would be a reasonable follow-up, not part of this fix.
- Unstaging leftover `A?` index entries in the auto-commit. `git add -A` already drops the phantom entry once the parser stops restoring it (Task 2 proves this).
- Any change to the pre-commit hook or the agent Bash sandbox that may have caused the original `git init` failure. The issue notes the cause was not reproduced.
