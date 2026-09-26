# TDD RED Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `three-session-tdd` test-writer phase succeeds, nax commits the files that phase changed, without
the repository's git hooks. The test-writer prompt stops demanding a typecheck its RED tests cannot pass.

**Architecture:**
- A new never-throwing module, `src/tdd/red-commit.ts` (`commitRedState`), stages exactly the phase's
  git-derived changed files from the repository root and commits them with `--no-verify`, unless
  `tdd.testWriterCommitHooks: "run"`.
- `runPhase` calls it through `_storyOrchestratorDeps` after a passed test-writer phase, so the implementer's
  `beforeRef` sees a clean committed boundary.
- The strict/lite test-writer role text and `testWriterOp.tools` change to match.

**Tech Stack:** Bun 1.4 + TypeScript strict, `bun:test`, zod config schemas, git via `gitWithTimeout`.

**Spec:** `docs/superpowers/specs/2026-09-26-tdd-red-commit-design.md` (read it first; this plan argues from it).

## Global Constraints

- Source files ≤ 600 lines (`scripts/check-file-sizes.ts`, `SRC_LIMIT = 600`):
  - `src/utils/git.ts` (598) and `src/agents/coding-tool-support.ts` (596) must NOT be modified.
  - `run-phase.ts` is 546 today, so its additions must keep it ≤ 600.
- Functions ≤ 30 lines, ≤ 3 positional params (use an options object), no `any`, `NaxError`/structured logs with
  a stage.
- Every external call goes through an injectable `_deps` object. Never `mock.module()`.
- Tests: zero `as unknown as` (`check:test-as-unknown-as` baseline 0), no `@ts-expect-error`; place the test
  file mirroring `src/`, and split files as `<module>-<concern>.test.ts`, never `<module>-<ticket>.test.ts`.
- Git spawns go through `gitWithTimeout` (hardened env/argv; `check:git-spawn-env`).
- Prompt text stays language-neutral (ADR-009): no `as unknown`, `ts-expect-error`, `@ts-`, or the word `tsc`.
- The commit message is exactly `chore(<storyId>): auto-commit after test-writer session (RED)`.
- The config knob is exactly `tdd.testWriterCommitHooks: "skip" | "run"`, optional, resolved `?? "skip"` at the one
  consumer. The `tdd` default literal in `src/config/schemas.ts` stays unchanged.
- The verification commands are the repo's: `bun run typecheck`, `bun run check:all`, `bun run test`,
  `bun run test:e2e`, `bun run test:coverage`. Never bare `bun test` with no path. Targeted runs use
  `bun test <file> --timeout=30000`.

## Review Focus

1. **A monorepo package workdir.** `ctx.packageDir` is `packages/app/`, not the repo root. Expected: the RED
   commit still stages the right root-relative paths, because every git call runs from `gitRoot`. The test is
   in Task 1 (AC 10).
2. **A test-writer that created a brand-new test directory.** `git status --porcelain` reports `?? test/`.
   Expected: the files inside are committed individually, and a collapsed `?? .nax/` is never staged. The test
   is in Task 1 (AC 1 uses a new `test/` dir; AC 5 and AC 6 use a new `.nax/scratchpad/`).
3. **A repository hook that rejects every commit.** Expected: with the default `"skip"` the commit lands anyway;
   with `"run"` it fails softly and the run continues. The tests are in Task 1 (AC 1, AC 3) and Task 2 (AC 16).
4. **A test-writer that already committed its own work, through Bash or an older prompt.** Expected: no second,
   empty commit. The test is in Task 1 (AC 7).
5. **A dry run or a blocked (mutation-dirty) worktree.** Expected: no commit, and in dry-run no git call at all.
   The tests are in Task 1 (AC 8, AC 9).

---

### Task 1: `commitRedState`, the RED commit primitive

**Files:**
- Create: `src/tdd/red-commit.ts`
- Modify: `src/tdd/index.ts` (add exports)
- Modify: `src/tools/git-commit.ts:86` (export `partitionNaxOwnedPaths`)
- Modify: `src/tools/index.ts:13` (re-export it)
- Test: `test/unit/tdd/red-commit.test.ts`

**Interfaces:**
- Consumes (existing, unchanged):
  - `getChangedFiles(workdir: string, fromRef?: string): Promise<string[]>` (`src/tdd/isolation.ts`). Paths
    are repo-root-relative; a new untracked dir appears once, as `dir/`.
  - `partitionNaxOwnedPaths(root: string, paths: string[]): Promise<{ kept: string[]; skipped: string[];
    unknown: UnknownPathResult[] }>` (`src/tools/git-commit.ts`).
  - `gitWithTimeout(args: string[], workdir: string, timeoutMs?: number)`, which returns
    `{ stdout, stderr, exitCode, timedOut? }` (`src/utils/git.ts`).
  - `gitlinkSafeAdd(git: GitRunner, cwd: string, opts: { pathspecs?: readonly string[]; timeoutMs?: number })`
    and `hasStagedChanges(git: GitRunner, cwd: string, timeoutMs?: number): Promise<boolean | undefined>`
    (`src/utils/git-add.ts`).
  - `realOrRaw(path: string): string` (`src/utils/realpath.ts`) and `getSafeLogger` (`src/logger`).
- Produces (used by Task 2):
  - `commitRedState(opts: RedCommitOptions, deps?: RedCommitDeps): Promise<RedCommitResult>`
  - `interface RedCommitOptions { workdir: string; beforeRef: string; storyId: string; hooks: "skip" | "run";
    dryRun: boolean; blockedWorktrees?: ReadonlySet<string> }` (all readonly)
  - `type RedCommitResult = { status: "committed"; files: readonly string[]; hooksSkipped: boolean } |
    { status: "skipped"; reason: "dry-run" | "blocked-worktree" | "nothing-to-commit" } |
    { status: "failed"; reason: string }`
  - `_redCommitDeps` and `type RedCommitDeps = typeof _redCommitDeps`
  - All of these are re-exported from `src/tdd/index.ts`.

- [ ] **Step 1: Export the classifier.** In `src/tools/git-commit.ts` change `async function partitionNaxOwnedPaths(`
  to `export async function partitionNaxOwnedPaths(` (body unchanged). In `src/tools/index.ts` change line 13 to:

```ts
export { buildCommitArgvs, gitCommitTool, partitionNaxOwnedPaths } from "./git-commit";
```

- [ ] **Step 2: Write the failing tests** at `test/unit/tdd/red-commit.test.ts`:

```ts
/**
 * commitRedState — the TDD RED commit (spec 2026-09-26-tdd-red-commit-design.md, US-001 ACs 1-11).
 * Real temp git repos; the failing pre-commit hook proves `--no-verify`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _redCommitDeps, commitRedState, type RedCommitOptions } from "@/tdd/red-commit";
import { _gitDeps } from "@/utils/git";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

async function git(repo: string, args: string[]): Promise<string> {
  const proc = _gitDeps.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

/** A repo with one commit (README.md, packages/app/index.ts, .gitignore ignoring `ignored/`). */
async function makeRepo(): Promise<{ repo: string; beforeRef: string }> {
  const repo = makeTempDir("nax-red-commit-");
  dirs.push(repo);
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.email", "test@nax.local"]);
  await git(repo, ["config", "user.name", "Nax Test"]);
  writeFileSync(join(repo, "README.md"), "# r\n");
  writeFileSync(join(repo, ".gitignore"), "ignored/\n");
  mkdirSync(join(repo, "packages", "app"), { recursive: true });
  writeFileSync(join(repo, "packages", "app", "index.ts"), "export const a = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  return { repo, beforeRef: await git(repo, ["rev-parse", "HEAD"]) };
}

function failingHook(repo: string): void {
  const hook = join(repo, ".git", "hooks", "pre-commit");
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\necho 'hook rejected: typecheck failed' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
}

function writeTest(repo: string, rel = "test/a.test.ts"): void {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), "test('x', () => {});\n");
}

const opts = (workdir: string, beforeRef: string, over: Partial<RedCommitOptions> = {}): RedCommitOptions => ({
  workdir,
  beforeRef,
  storyId: "US-001",
  hooks: "skip",
  dryRun: false,
  ...over,
});

describe("commitRedState", () => {
  test("AC1: commits the changed test file past a failing pre-commit hook", async () => {
    const { repo, beforeRef } = await makeRepo();
    failingHook(repo);
    writeTest(repo);
    expect(await commitRedState(opts(repo, beforeRef))).toEqual({
      status: "committed",
      files: ["test/a.test.ts"],
      hooksSkipped: true,
    });
  });

  test("AC2: the commit carries the RED message and leaves the tree clean", async () => {
    const { repo, beforeRef } = await makeRepo();
    failingHook(repo);
    writeTest(repo);
    await commitRedState(opts(repo, beforeRef));
    expect(await git(repo, ["log", "-1", "--format=%s"])).toBe(
      "chore(US-001): auto-commit after test-writer session (RED)",
    );
    expect(await git(repo, ["status", "--porcelain"])).toBe("");
  });

  test("AC3: hooks 'run' lets the hook reject the commit, softly", async () => {
    const { repo, beforeRef } = await makeRepo();
    failingHook(repo);
    writeTest(repo);
    const result = await commitRedState(opts(repo, beforeRef, { hooks: "run" }));
    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.reason : "").toContain("hook rejected: typecheck failed");
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(beforeRef);
  });

  test("AC4: stages only the changed paths, never an add -A of the tree", async () => {
    const { repo, beforeRef } = await makeRepo();
    writeTest(repo);
    mkdirSync(join(repo, "ignored"), { recursive: true });
    writeFileSync(join(repo, "ignored", "scratch.txt"), "x\n");
    await commitRedState(opts(repo, beforeRef));
    expect(await git(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe("test/a.test.ts");
  });

  test("AC5: a changed .nax/scratchpad path is not committed beside the test file", async () => {
    const { repo, beforeRef } = await makeRepo();
    writeTest(repo);
    mkdirSync(join(repo, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(join(repo, ".nax", "scratchpad", "notes.md"), "n\n");
    const result = await commitRedState(opts(repo, beforeRef));
    expect(result.status === "committed" ? result.files : []).toEqual(["test/a.test.ts"]);
    expect(await git(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe("test/a.test.ts");
  });

  test("AC6: only nax-owned changes means nothing to commit", async () => {
    const { repo, beforeRef } = await makeRepo();
    mkdirSync(join(repo, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(join(repo, ".nax", "scratchpad", "notes.md"), "n\n");
    expect(await commitRedState(opts(repo, beforeRef))).toEqual({ status: "skipped", reason: "nothing-to-commit" });
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(beforeRef);
  });

  test("AC7: files the test-writer already committed produce no second commit", async () => {
    const { repo, beforeRef } = await makeRepo();
    writeTest(repo);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "test: own commit"]);
    const head = await git(repo, ["rev-parse", "HEAD"]);
    expect(await commitRedState(opts(repo, beforeRef))).toEqual({ status: "skipped", reason: "nothing-to-commit" });
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(head);
  });

  test("AC8: dry run makes no git call at all", async () => {
    const calls: string[][] = [];
    const deps = {
      ..._redCommitDeps,
      git: async (args: string[], cwd: string, timeoutMs?: number) => {
        calls.push(args);
        return _redCommitDeps.git(args, cwd, timeoutMs);
      },
    };
    expect(await commitRedState(opts("/nonexistent", "HEAD", { dryRun: true }), deps)).toEqual({
      status: "skipped",
      reason: "dry-run",
    });
    expect(calls).toEqual([]);
  });

  test("AC9: a blocked worktree, named through a symlink, is not committed", async () => {
    const { repo, beforeRef } = await makeRepo();
    writeTest(repo);
    const linkDir = makeTempDir("nax-red-commit-link-");
    dirs.push(linkDir);
    const link = join(linkDir, "repo");
    symlinkSync(repo, link);
    expect(await commitRedState(opts(repo, beforeRef, { blockedWorktrees: new Set([link]) }))).toEqual({
      status: "skipped",
      reason: "blocked-worktree",
    });
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(beforeRef);
  });

  test("AC10: a package-subdirectory workdir stages root-relative paths", async () => {
    const { repo, beforeRef } = await makeRepo();
    writeTest(repo, "packages/app/test/b.test.ts");
    const result = await commitRedState(opts(join(repo, "packages", "app"), beforeRef));
    expect(result.status === "committed" ? result.files : []).toEqual(["packages/app/test/b.test.ts"]);
    expect(await git(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe("packages/app/test/b.test.ts");
  });

  test("AC11: a throwing getChangedFiles resolves to failed, never rejects", async () => {
    const { repo, beforeRef } = await makeRepo();
    const deps = {
      ..._redCommitDeps,
      getChangedFiles: async (): Promise<string[]> => {
        throw new Error("git diff exploded");
      },
    };
    expect(await commitRedState(opts(repo, beforeRef), deps)).toEqual({
      status: "failed",
      reason: "git diff exploded",
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test test/unit/tdd/red-commit.test.ts --timeout=30000`
Expected: FAIL. The module `@/tdd/red-commit` does not exist (`Cannot find module`).

- [ ] **Step 4: Write the implementation** at `src/tdd/red-commit.ts`:

```ts
/**
 * The TDD RED commit (docs/superpowers/specs/2026-09-26-tdd-red-commit-design.md).
 *
 * After a successful test-writer phase the story orchestrator commits the
 * files that phase changed, so the implementer's `beforeRef` is a committed
 * boundary rather than a tree that still holds the test-writer's work.
 *
 * Hooks are skipped by default (`--no-verify`), exactly as the finish loop's
 * checkpoints are (src/finish/commit.ts): a RED suite may not typecheck until
 * the implementer adds the symbols its tests reference, and a pre-commit
 * typecheck would reject it. quality.commands, the review checks and the
 * deferred regression gate remain the mechanical gate.
 *
 * Every git call runs from the repository root: `git diff --name-only` and
 * `git status --porcelain` print root-relative paths even from a package
 * subdirectory. Never throws.
 */
import { getSafeLogger } from "../logger";
import { partitionNaxOwnedPaths } from "../tools";
import { errorMessage } from "../utils/errors";
import { gitWithTimeout } from "../utils/git";
import { gitlinkSafeAdd, hasStagedChanges } from "../utils/git-add";
import { realOrRaw } from "../utils/realpath";
import { getChangedFiles } from "./isolation";

const RED_COMMIT_GIT_TIMEOUT_MS = 30_000;

export interface RedCommitOptions {
  readonly workdir: string;
  readonly beforeRef: string;
  readonly storyId: string;
  readonly hooks: "skip" | "run";
  readonly dryRun: boolean;
  readonly blockedWorktrees?: ReadonlySet<string>;
}

export type RedCommitResult =
  | { readonly status: "committed"; readonly files: readonly string[]; readonly hooksSkipped: boolean }
  | { readonly status: "skipped"; readonly reason: "dry-run" | "blocked-worktree" | "nothing-to-commit" }
  | { readonly status: "failed"; readonly reason: string };

/** Swappable dependencies for testing (avoids mock.module()). */
export const _redCommitDeps = {
  git: (args: string[], cwd: string, timeoutMs?: number) => gitWithTimeout(args, cwd, timeoutMs),
  getChangedFiles,
  partitionNaxOwnedPaths,
};

export type RedCommitDeps = typeof _redCommitDeps;

const NOTHING: RedCommitResult = { status: "skipped", reason: "nothing-to-commit" };

export function redCommitMessage(storyId: string): string {
  return `chore(${storyId}): auto-commit after test-writer session (RED)`;
}

export async function commitRedState(
  opts: RedCommitOptions,
  deps: RedCommitDeps = _redCommitDeps,
): Promise<RedCommitResult> {
  if (opts.dryRun) return { status: "skipped", reason: "dry-run" };
  try {
    return await commitFromRoot(opts, deps);
  } catch (err) {
    return { status: "failed", reason: errorMessage(err) };
  }
}

async function commitFromRoot(opts: RedCommitOptions, deps: RedCommitDeps): Promise<RedCommitResult> {
  const top = await deps.git(["rev-parse", "--show-toplevel"], opts.workdir, RED_COMMIT_GIT_TIMEOUT_MS);
  if (top.exitCode !== 0) return { status: "failed", reason: `git rev-parse failed: ${top.stderr.trim()}` };
  const gitRoot = top.stdout.trim();
  if (isBlocked(gitRoot, opts)) return { status: "skipped", reason: "blocked-worktree" };
  const changed = await deps.getChangedFiles(opts.workdir, opts.beforeRef);
  const files = await expandUntrackedDirs(gitRoot, changed, deps);
  const { kept } = await deps.partitionNaxOwnedPaths(gitRoot, files);
  if (kept.length === 0) return NOTHING;
  const added = await gitlinkSafeAdd(deps.git, gitRoot, { pathspecs: kept, timeoutMs: RED_COMMIT_GIT_TIMEOUT_MS });
  if (added.exitCode !== 0) return { status: "failed", reason: `git add failed: ${added.stderr.trim()}` };
  if ((await hasStagedChanges(deps.git, gitRoot, RED_COMMIT_GIT_TIMEOUT_MS)) !== true) return NOTHING;
  const argv = ["commit", "-m", redCommitMessage(opts.storyId), ...(opts.hooks === "skip" ? ["--no-verify"] : [])];
  const committed = await deps.git(argv, gitRoot, RED_COMMIT_GIT_TIMEOUT_MS);
  if (committed.exitCode !== 0) {
    return { status: "failed", reason: `git commit failed: ${committed.stderr.trim() || `exit ${committed.exitCode}`}` };
  }
  return { status: "committed", files: kept, hooksSkipped: opts.hooks === "skip" };
}

function isBlocked(gitRoot: string, opts: RedCommitOptions): boolean {
  if (!opts.blockedWorktrees?.size) return false;
  const root = realOrRaw(gitRoot);
  const blocked = [...opts.blockedWorktrees].filter((tree) => realOrRaw(tree) === root);
  if (blocked.length === 0) return false;
  getSafeLogger()?.error("tdd", "Refusing to commit the RED state — working tree may still hold an unreverted mutation", {
    storyId: opts.storyId,
    workdir: opts.workdir,
    blocked,
    hint: "Check the mutation-check log for the file and line, restore it, then commit manually.",
  });
  return true;
}

/**
 * `git status --porcelain` reports a brand-new untracked directory as one
 * `dir/` entry. Expand each to its files so the nax-owned filter sees
 * individual paths — a collapsed `.nax/` must never be staged whole.
 */
async function expandUntrackedDirs(gitRoot: string, paths: readonly string[], deps: RedCommitDeps): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    if (!path.endsWith("/")) {
      out.push(path);
      continue;
    }
    const listed = await deps.git(["ls-files", "--others", "--exclude-standard", "--", path], gitRoot, RED_COMMIT_GIT_TIMEOUT_MS);
    if (listed.exitCode !== 0) throw new Error(`git ls-files ${path} failed: ${listed.stderr.trim()}`);
    out.push(...listed.stdout.split("\n").filter(Boolean));
  }
  return out;
}
```

  Notes:
  - If `check:nax-error` or the error-handling rule rejects the bare `new Error` in `expandUntrackedDirs`, use
    `new NaxError(msg, "GIT_LS_FILES_FAILED", { stage: "tdd-red-commit", path })` from `../errors` instead. It is
    caught by `commitRedState` either way.
  - `src/tools` never imports `src/tdd` (verified), so `../tools` → `red-commit` → `tdd` barrel forms no cycle.
    If `check:import-cycles` still reports one, move `partitionNaxOwnedPaths` unchanged into
    `src/utils/nax-owned-partition.ts`, import it from there in both `git-commit.ts` and `red-commit.ts`, and
    keep the `src/tools/index.ts` re-export pointing at the new file.
  - Run `bun x biome format --write src/tdd/red-commit.ts` if lines exceed the formatter width.

- [ ] **Step 5: Export from the tdd barrel.** Append to `src/tdd/index.ts`:

```ts
export type { RedCommitDeps, RedCommitOptions, RedCommitResult } from "./red-commit";
export { _redCommitDeps, commitRedState, redCommitMessage } from "./red-commit";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test test/unit/tdd/red-commit.test.ts --timeout=30000`
Expected: PASS, 11 tests. Also run `bun test test/unit/tools/git-commit.test.ts --timeout=30000`; it should still
pass, because the export is unchanged behaviour.

- [ ] **Step 7: Typecheck and static checks**

Run: `bun run typecheck && bun run check:all`
Expected: both green, including file sizes, import cycles, alias internals, git-spawn-env and
test-as-unknown-as = 0.

- [ ] **Step 8: Commit**

```bash
git add src/tdd/red-commit.ts src/tdd/index.ts src/tools/git-commit.ts src/tools/index.ts test/unit/tdd/red-commit.test.ts
git commit -m "feat(tdd): commitRedState commits the test-writer's RED state without hooks"
```

---

### Task 2: config knob + `runPhase` wiring

**Files:**
- Modify: `src/config/schemas-execution.ts:498` (`TddConfigSchema`)
- Modify: `src/config/runtime-types.ts:250-271` (`TddConfig` interface)
- Modify: `src/cli/config-descriptions.ts:168` (descriptions map)
- Modify: `src/execution/story-orchestrator/run-phase.ts` (deps + call after a passed test-writer phase)
- Modify: `docs/guides/three-session-tdd.md` (one paragraph)
- Test: `test/unit/execution/story-orchestrator/run-phase-red-commit.test.ts`
- Test: `test/unit/tdd/red-commit.test.ts` (append the schema and descriptions ACs)

**Interfaces:**
- Consumes: `commitRedState`, `RedCommitOptions` and `RedCommitResult` from Task 1 (`src/tdd`).
- Produces:
  - `_storyOrchestratorDeps.commitRedState` (defaults to the real `commitRedState`)
  - the config field `tdd.testWriterCommitHooks?: "skip" | "run"`

- [ ] **Step 1: Write the failing schema and descriptions tests.** Append to `test/unit/tdd/red-commit.test.ts`:

```ts
import { TddConfigSchema } from "@/config/schemas-execution";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";

describe("tdd.testWriterCommitHooks", () => {
  test("AC12: optional, keeps 'run', rejects other values", () => {
    expect(TddConfigSchema.parse({ maxRetries: 2 }).testWriterCommitHooks).toBeUndefined();
    expect(TddConfigSchema.parse({ maxRetries: 2, testWriterCommitHooks: "run" }).testWriterCommitHooks).toBe("run");
    expect(TddConfigSchema.safeParse({ maxRetries: 2, testWriterCommitHooks: "never" }).success).toBe(false);
  });

  test("AC17: the knob has a config description", () => {
    expect(FIELD_DESCRIPTIONS["tdd.testWriterCommitHooks"]).toBeString();
  });
});
```

  The descriptions map is `export const FIELD_DESCRIPTIONS: Record<string, string>` in
  `src/cli/config-descriptions.ts:8` (verified).

- [ ] **Step 2: Write the failing wiring tests** at `test/unit/execution/story-orchestrator/run-phase-red-commit.test.ts`:

```ts
/**
 * runPhase -> commitRedState wiring (spec 2026-09-26-tdd-red-commit-design.md, US-001 ACs 13-16).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCallOp, makeMockCallContext, makeNaxConfig } from "@test/helpers";
import { _storyOrchestratorDeps, runPhase } from "@/execution";
import type { AnySlot } from "@/execution/story-orchestrator";
import type { RunOperation } from "@/operations";
import type { RedCommitOptions, RedCommitResult } from "@/tdd";

function makeSlot(opName: string): AnySlot {
  const op = {
    kind: "run" as const,
    name: opName,
    stage: "run" as const,
    config: [] as const,
    session: { role: "test-writer" as const, lifetime: "warm" as const },
    build: () => ({
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: "", overridable: false },
    }),
    parse: () => ({}),
  } satisfies RunOperation<unknown, unknown, unknown>;
  return { op, input: {} };
}

const TEST_WRITER_OUTPUT = { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output: "" };
const COMMITTED: RedCommitResult = { status: "committed", files: ["test/a.test.ts"], hooksSkipped: true };

let origCallOp: typeof _storyOrchestratorDeps.callOp;
let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
let origCommitRedState: typeof _storyOrchestratorDeps.commitRedState;

beforeEach(() => {
  origCallOp = _storyOrchestratorDeps.callOp;
  origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  origCommitRedState = _storyOrchestratorDeps.commitRedState;
  _storyOrchestratorDeps.callOp = makeCallOp({ fallback: TEST_WRITER_OUTPUT });
  _storyOrchestratorDeps.captureGitRef = async () => "abc123";
});

afterEach(() => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
  _storyOrchestratorDeps.commitRedState = origCommitRedState;
});

function spyCommit(result: RedCommitResult = COMMITTED): RedCommitOptions[] {
  const calls: RedCommitOptions[] = [];
  _storyOrchestratorDeps.commitRedState = async (opts: RedCommitOptions) => {
    calls.push(opts);
    return result;
  };
  return calls;
}

describe("runPhase RED commit", () => {
  test("AC13: a passed three-session test-writer phase commits with the phase's own beforeRef", async () => {
    const calls = spyCommit();
    const ctx = makeMockCallContext();
    await runPhase(ctx, makeSlot("test-writer"), {}, {}, true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ workdir: ctx.packageDir, beforeRef: "abc123", storyId: ctx.storyId, hooks: "skip" });
  });

  test("AC14: tdd.testWriterCommitHooks 'run' is passed through", async () => {
    const calls = spyCommit();
    const ctx = makeMockCallContext({ config: makeNaxConfig({ tdd: { testWriterCommitHooks: "run" } }) });
    await runPhase(ctx, makeSlot("test-writer"), {}, {}, true);
    expect(calls[0]?.hooks).toBe("run");
  });

  test("AC15: no commit when the phase throws, is not three-session, is a rectification, or is not the test-writer", async () => {
    const calls = spyCommit();
    const ctx = makeMockCallContext();
    await runPhase(ctx, makeSlot("test-writer"), {}, {}, false);
    await runPhase(ctx, makeSlot("test-writer"), {}, {}, true, undefined, true);
    await runPhase(ctx, makeSlot("implementer"), {}, {}, true);
    _storyOrchestratorDeps.callOp = async () => {
      throw new Error("dispatch failed");
    };
    await expect(runPhase(ctx, makeSlot("test-writer"), {}, {}, true)).rejects.toThrow("dispatch failed");
    expect(calls).toHaveLength(0);
  });

  test("AC16: a failed RED commit changes neither the phase's return value nor its phaseOutputs entry", async () => {
    const ctx = makeMockCallContext();
    spyCommit(COMMITTED);
    const okOutputs: Record<string, unknown> = {};
    const okReturn = await runPhase(ctx, makeSlot("test-writer"), {}, okOutputs, true);
    spyCommit({ status: "failed", reason: "x" });
    const failedOutputs: Record<string, unknown> = {};
    const failedReturn = await runPhase(ctx, makeSlot("test-writer"), {}, failedOutputs, true);
    expect(failedReturn).toEqual(okReturn);
    expect(failedOutputs["test-writer"]).toEqual(okOutputs["test-writer"]);
  });
});
```

  If `makeNaxConfig({ tdd: { testWriterCommitHooks: "run" } })` fails to typecheck before Step 4, that is the
  RED signal for the schema and interface change. It passes once Step 4 lands.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test test/unit/tdd/red-commit.test.ts test/unit/execution/story-orchestrator/run-phase-red-commit.test.ts --timeout=30000`
Expected:
- AC12 FAILs: `"never"` parses, because unknown keys pass or the field is absent.
- AC17 FAILs: `undefined`.
- AC13 and AC14 FAIL: `_storyOrchestratorDeps.commitRedState` is undefined, so `calls` has length 0.
- AC15 and AC16 may pass vacuously at this point, which is expected; they guard the wiring once it lands.

- [ ] **Step 4: Add the knob.** In `src/config/schemas-execution.ts`, directly after the
  `testWriterAllowedPaths: z.array(z.string()).optional(),` line in `TddConfigSchema`, add:

```ts
  /**
   * Whether the RED commit nax makes after a successful test-writer phase runs
   * the repository's git hooks. `"skip"` (default, resolved at the consumer)
   * commits with `--no-verify`: a RED suite may not typecheck until the
   * implementer adds the symbols its tests reference. `"run"` restores the
   * hooks (e.g. a secret-scanning hook that must see every commit); a hook
   * that rejects leaves the files uncommitted and the run continues.
   */
  testWriterCommitHooks: z.enum(["skip", "run"]).optional(),
```

  In `src/config/runtime-types.ts`, inside `interface TddConfig`, after the `testWriterAllowedPaths?: string[];` line, add:

```ts
  /** Git hooks on nax's RED commit after the test-writer phase: "skip" (default, --no-verify) | "run". */
  testWriterCommitHooks?: "skip" | "run";
```

  In `src/cli/config-descriptions.ts`, after the `"tdd.testWriterAllowedPaths": ...` entry, add:

```ts
  "tdd.testWriterCommitHooks":
    'Git hooks on the RED commit nax makes after the test-writer phase: "skip" (default, --no-verify) | "run"',
```

- [ ] **Step 5: Wire `runPhase`.** In `src/execution/story-orchestrator/run-phase.ts`:
  - Line 20 is `import { cleanupVerdict } from "@/tdd";`. Change it to
    `import { cleanupVerdict, commitRedState, type RedCommitResult } from "@/tdd";`.
  - Add `commitRedState,` to `_storyOrchestratorDeps`, right after `captureGitRef,`, with this comment above it:

```ts
  /** TDD RED commit after a passed test-writer phase (spec 2026-09-26-tdd-red-commit). */
  commitRedState,
```

  - Directly before the `return output;` that ends the `try` block (the one after the isolation logging), insert:

```ts
    if (isTddPhase && opName === "test-writer" && !inRectification && beforeRef && outcome === "passed") {
      await commitTestWriterRedState(ctx, beforeRef);
    }
```

  - Add these helpers after `derivePhaseOutcome`:

```ts
/** Commit the test-writer's files so the implementer's beforeRef is a committed boundary. Never throws. */
async function commitTestWriterRedState(ctx: CallContext, beforeRef: string): Promise<void> {
  const config = ctx.config ?? ctx.runtime.configLoader.current();
  const result = await _storyOrchestratorDeps.commitRedState({
    workdir: ctx.packageDir,
    beforeRef,
    storyId: ctx.storyId ?? "story",
    hooks: config.tdd?.testWriterCommitHooks ?? "skip",
    dryRun: ctx.runtime.dryRun,
    blockedWorktrees: ctx.runtime.dirtyWorktrees,
  });
  logRedCommit(ctx.storyId, result);
}

function logRedCommit(storyId: string | undefined, result: RedCommitResult): void {
  const logger = getSafeLogger();
  if (result.status === "committed") {
    logger?.info("tdd", "RED state committed", {
      storyId,
      files: result.files.length,
      hooksSkipped: result.hooksSkipped,
    });
  } else if (result.status === "skipped") {
    logger?.debug("tdd", "RED state commit skipped", { storyId, reason: result.reason });
  } else {
    logger?.warn("tdd", "RED state not committed", { storyId, reason: result.reason });
  }
}
```

  `CallContext` and `getSafeLogger` are already imported in `run-phase.ts` (it calls `getSafeLogger()` and takes
  `ctx: CallContext`); do not add duplicate imports. Check with `wc -l src/execution/story-orchestrator/run-phase.ts`
  that the file stays ≤ 600 lines.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test test/unit/tdd/red-commit.test.ts test/unit/execution/story-orchestrator/ --timeout=30000`
Expected: PASS, including every existing `runPhase` test in that directory.
- Existing tests that don't stub `commitRedState` run the real one against `packageDir: "/tmp/test"`.
- That is harmless, because `commitRedState` never throws; `/tmp/test` is not a repo, so it resolves `failed`
  and logs a warning.
- If any existing test asserts on the absence of `tdd` warn logs, stub `_storyOrchestratorDeps.commitRedState`
  in that file's `beforeEach` to return `{ status: "skipped", reason: "nothing-to-commit" }`, and restore it in
  `afterEach`.

- [ ] **Step 7: Document the knob.** In `docs/guides/three-session-tdd.md`, after the paragraph that begins
  "Isolation is checked via `git diff`", add:

```markdown
When the test writer's session succeeds, nax commits the files it changed (`chore(<story>): auto-commit after test-writer session (RED)`), so the implementer's isolation check starts from a committed boundary. That commit skips the repository's git hooks by default: the RED tests may not typecheck until the implementer adds the fields and exports they reference, and nax's own quality commands, review checks and regression gate still run afterwards. Set `tdd.testWriterCommitHooks: "run"` to run the hooks on that commit too (a hook that rejects it leaves the files uncommitted and the run continues).
```

- [ ] **Step 8: Typecheck, static checks, suite**

Run: `bun run typecheck && bun run check:all && bun run test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/config/schemas-execution.ts src/config/runtime-types.ts src/cli/config-descriptions.ts src/execution/story-orchestrator/run-phase.ts docs/guides/three-session-tdd.md test/unit/tdd/red-commit.test.ts test/unit/execution/story-orchestrator/run-phase-red-commit.test.ts
git commit -m "feat(tdd): commit the RED state after a passed test-writer phase (tdd.testWriterCommitHooks)"
```

---

### Task 3: test-writer role text and tools

**Files:**
- Modify: `src/prompts/sections/role-task.ts:104-150` (lite and strict test-writer text)
- Modify: `src/operations/write-test.ts:62-80` (tools list and its comment)
- Modify: `test/unit/operations/tdd-session-op-tools.test.ts:42-51`
- Test: `test/unit/prompts/sections/role-task.test.ts` (append a describe block)

**Interfaces:**
- Consumes: none at the code level. The new sentence "nax commits the files you changed" is true because of
  Task 2.
- Produces: none.

- [ ] **Step 1: Write the failing prompt tests.** Append to `test/unit/prompts/sections/role-task.test.ts`:

```ts
// ---------------------------------------------------------------------------
// TDD RED commit (spec 2026-09-26-tdd-red-commit-design.md, US-002)
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection — test-writer RED state", () => {
  const strict = () => buildRoleTaskSection("test-writer", undefined, "bun test", "strict");
  const lite = () => buildRoleTaskSection("test-writer", undefined, "bun test", "lite");
  const COMMIT_RULE = "Do not commit. When your session ends, nax commits the files you changed as the RED state.";

  test("AC1: step 5 rejects import errors and runtime crashes, not type errors", () => {
    expect(strict()).toContain(
      "Confirm every test fails with an ASSERTION failure, not an import error or a runtime crash before the assertion.",
    );
  });

  test("AC2: the strict text no longer demands the absence of compile errors", () => {
    expect(strict()).not.toContain("compile error");
  });

  test("AC3: a type error on a symbol the implementer will add is the expected RED state", () => {
    expect(strict()).toContain("is the expected RED state");
    expect(strict()).toContain("type each test as the finished code will be");
  });

  test("AC4: strict isolation still forbids source edits", () => {
    expect(strict()).toContain("Do NOT create or modify any source files");
  });

  test("AC5: both variants say nax commits the RED state", () => {
    expect(strict()).toContain(COMMIT_RULE);
    expect(lite()).toContain(COMMIT_RULE);
  });

  test("AC6: the lite variant still requires stubs that compile", () => {
    expect(lite()).toContain("Confirm tests compile (stubs work) AND fail with ASSERTION failures");
  });

  test("AC7: both texts stay language-neutral", () => {
    for (const text of [strict(), lite()]) {
      expect(text).not.toContain("as unknown");
      expect(text).not.toContain("ts-expect-error");
      expect(text).not.toContain("@ts-");
      expect(text).not.toMatch(/\btsc\b/);
    }
  });

  test("AC9: other roles gain none of the RED-state sentences", () => {
    const others = [
      buildRoleTaskSection("implementer", "standard"),
      buildRoleTaskSection("implementer", "lite"),
      buildRoleTaskSection("verifier"),
      buildRoleTaskSection("tdd-simple"),
      buildRoleTaskSection("batch"),
      buildRoleTaskSection("no-test"),
    ];
    for (const text of others) {
      expect(text).not.toContain("is the expected RED state");
      expect(text).not.toContain("nax commits the files you changed");
    }
  });
});
```

- [ ] **Step 2: Update the tools test (US-002 AC 8).** In `test/unit/operations/tdd-session-op-tools.test.ts`,
  replace the `testWriterOp tools` describe block (lines 34-51) with:

```ts
describe("testWriterOp tools", () => {
  test("can create test files and compile-only stubs", () => {
    const tools = resolveDeclaredTools(testWriterOp);

    expect(tools).toContain("Read");
    expect(tools).toContain("Write");
    expect(tools).toContain("Edit");
  });

  test("can run the tests it wrote, to prove they fail on an assertion", () => {
    // The role requires telling an ASSERTION failure from an import error or a
    // runtime crash before the assertion. A test-writer that cannot execute
    // cannot tell them apart.
    expect(resolveDeclaredTools(testWriterOp)).toContain("RunCommand");
  });

  test("does not commit: the orchestrator's RED commit makes the implementer's beforeRef a clean boundary", () => {
    expect(resolveDeclaredTools(testWriterOp)).not.toContain("GitCommit");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test test/unit/prompts/sections/role-task.test.ts test/unit/operations/tdd-session-op-tools.test.ts --timeout=30000`
Expected:
- AC1, AC2, AC3 and AC5 FAIL: the old text is still there.
- "does not commit" FAILs: `GitCommit` is still declared.
- AC4, AC6, AC7 and AC9 pass already. They are guards.

- [ ] **Step 4: Edit the strict test-writer text** in `src/prompts/sections/role-task.ts`. Replace:

```
5. Run the new test files. Confirm every test fails with an ASSERTION failure — NOT an import error, compile error, or runtime crash before assertion. A test that errors before reaching its assertion does not prove the behavior is missing.

Rules:
- Do NOT create or modify any source files. Read source for types/interfaces only.
```

  with:

```
5. Run the new test files. Confirm every test fails with an ASSERTION failure, not an import error or a runtime crash before the assertion. A test that errors before reaching its assertion does not prove the behavior is missing.

Rules:
- Do NOT create or modify any source files. Read source for types/interfaces only.
- A type-check error that exists only because the implementer has not yet added a field, parameter or export the acceptance criteria require is the expected RED state. Do not work around it with type casts, type-checker suppression comments, allow-list tags or throwaway type-probe scripts; type each test as the finished code will be.
- Do not commit. When your session ends, nax commits the files you changed as the RED state.
```

- [ ] **Step 5: Edit the lite test-writer text.** In the `isolation === "lite"` branch, replace:

```
- Stubs are NOT implementations. The implementer in the next session writes real logic.
```

  with:

```
- Stubs are NOT implementations. The implementer in the next session writes real logic.
- Do not commit. When your session ends, nax commits the files you changed as the RED state.
```

- [ ] **Step 6: Drop `GitCommit` from the test-writer.** In `src/operations/write-test.ts`, remove the
  `"GitCommit",` entry from `testWriterOp.tools`. Replace the comment above `tools:` (the lines from
  `// Write/Edit for test files and compile-only stubs.` through `// implementer's \`beforeRef\` is not realised
  until the prompt gains that step.`) with:

```ts
  // Write/Edit for test files and compile-only stubs. `RunCommand` because step
  // 5 of the role is "Run the new test files. Confirm every test fails with an
  // ASSERTION failure" -- the one distinction the prompt insists on, and one it
  // cannot make without executing. No `GitCommit`: the story orchestrator
  // commits the phase's files after it succeeds (src/tdd/red-commit.ts), so the
  // implementer's `beforeRef` is a committed boundary without the test-writer
  // ever meeting the repository's pre-commit hook.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test test/unit/prompts/sections/role-task.test.ts test/unit/operations/ test/unit/prompts/ --timeout=30000`
Expected: PASS. If `test/unit/cli/prompts-init.test.ts` snapshots role text, run it too
(`bun test test/unit/cli/prompts-init.test.ts --timeout=30000`). If it fails only because of the two new
sentences or the changed step 5, update the expected text there to the new wording, and add nothing else.

- [ ] **Step 8: Typecheck, static checks, full suites, coverage**

Run: `bun run typecheck && bun run check:all && bun run test && bun run test:e2e && bun run test:coverage`
Expected: all green. `test:coverage` is not part of `check:all`; `src/tdd/red-commit.ts` must meet the per-file
floor, which Task 1's 11 tests cover.

- [ ] **Step 9: Commit**

```bash
git add src/prompts/sections/role-task.ts src/operations/write-test.ts test/unit/prompts/sections/role-task.test.ts test/unit/operations/tdd-session-op-tools.test.ts
git commit -m "feat(prompts): test-writer RED state is type-error tolerant and nax-committed"
```

---

## After the tasks

- Code review before any push (working agreement): run a fresh reviewer over `git diff main...HEAD`.
- Then push `feat/tdd-red-commit` and open the PR against `main`, only on the user's go-ahead.
- The measurement is a follow-up, not part of this plan. Re-run the `ab-r17r19` seed with the treatment harness
  rebuilt on this branch, one run at a time to avoid MiniMax rate limits, as a new billed A/B that needs
  approval at launch. The expected signal: M3 test-writer failed commits → 0, `/tmp` probes → ~0, test-writer
  billed well below 16.8-34.0M, and no `test-ratchet-allow` added.
