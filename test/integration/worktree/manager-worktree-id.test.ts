/**
 * Integration tests for US-002 — the worktree API takes the WorktreeId identity.
 *
 * AC-1: WorktreeManager.create given identity derived for feature `f` and
 *       storyId `US-001` creates a worktree directory ending in
 *       `.nax-wt/story-f-US-001`.
 * AC-2: WorktreeManager.create given that identity creates a branch named
 *       `nax/story-f-US-001`.
 * AC-3: WorktreeManager.remove given that identity removes the branch
 *       `nax/story-f-US-001`.
 * AC-9: WorktreeManager.create given identity `story-f-US-001` and a pre-existing
 *       branch `nax/story-f-US-001` throws a NaxError with code WORKTREE_ERROR
 *       whose message names the composed branch `nax/story-f-US-001`.
 * AC-10: In a repository with a linked git worktree, `create()` from the main
 *       checkout AND `create()` from the linked checkout both resolve without
 *       throwing when the two stories share the same raw storyId but differ
 *       on feature.
 * AC-11: After the AC-10 linked-worktree create, the branch
 *       `nax/story-a-US-001` created from the main checkout still exists in
 *       the repository.
 *
 * Story: US-002 — The worktree API takes the identity.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir } from "@test/helpers";
import { deriveStoryWorktreeId, storyBranchName, storyWorktreePath, type WorktreeId } from "@/worktree";
import { WorktreeManager } from "@/worktree/manager";

async function git(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, exitCode, stderr };
}

async function initRepo(projectRoot: string): Promise<void> {
  await git(["init"], projectRoot);
  await git(["config", "user.email", "test@example.com"], projectRoot);
  await git(["config", "user.name", "Test User"], projectRoot);
  writeFileSync(join(projectRoot, "README.md"), "# test project");
  await git(["add", "README.md"], projectRoot);
  await git(["commit", "-m", "initial commit"], projectRoot);
}

async function branchExists(projectRoot: string, branchName: string): Promise<boolean> {
  const { stdout } = await git(["branch", "--list", branchName], projectRoot);
  return stdout.includes(branchName);
}

describe("US-002 WorktreeManager.create/remove — branded WorktreeId acceptance", () => {
  let testDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    testDir = makeTempDir("us002-wt-");
    projectRoot = join(testDir, "repo");
    mkdirSync(projectRoot, { recursive: true });
    await initRepo(projectRoot);
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  test("AC-1: create() with WorktreeId derived for feature 'f' and storyId 'US-001' places the directory at .nax-wt/story-f-US-001", async () => {
    const manager = new WorktreeManager();
    const worktreeId: WorktreeId = deriveStoryWorktreeId("f", "US-001");

    await manager.create(projectRoot, worktreeId);

    const expectedDir = storyWorktreePath(projectRoot, worktreeId);
    expect(expectedDir.endsWith(join(".nax-wt", "story-f-US-001"))).toBe(true);
    expect(existsSync(expectedDir)).toBe(true);
  });

  test("AC-2: create() with WorktreeId derived for feature 'f' and storyId 'US-001' creates branch nax/story-f-US-001", async () => {
    const manager = new WorktreeManager();
    const worktreeId: WorktreeId = deriveStoryWorktreeId("f", "US-001");

    await manager.create(projectRoot, worktreeId);

    const expectedBranch = storyBranchName(worktreeId);
    expect(expectedBranch).toBe("nax/story-f-US-001");
    expect(await branchExists(projectRoot, expectedBranch)).toBe(true);
  });

  test("AC-3: remove() with WorktreeId derived for feature 'f' and storyId 'US-001' removes the branch nax/story-f-US-001", async () => {
    const manager = new WorktreeManager();
    const worktreeId: WorktreeId = deriveStoryWorktreeId("f", "US-001");

    await manager.create(projectRoot, worktreeId);
    expect(await branchExists(projectRoot, storyBranchName(worktreeId))).toBe(true);

    await manager.remove(projectRoot, worktreeId);
    expect(await branchExists(projectRoot, storyBranchName(worktreeId))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-9 — create() throws NaxError(WORKTREE_ERROR) whose message names the
// composed branch when it already exists.
//
// Pre-US-002 the message would contain whatever branch string was passed.
// US-002 keeps that behaviour AND routes it through `storyBranchName(worktreeId)`
// so the spelling is composed. The test pins both the error code AND the
// presence of the composed branch name in the message.
// ---------------------------------------------------------------------------

describe("US-002 WorktreeManager.create — AC-9: error message names composed branch", () => {
  let testDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    testDir = makeTempDir("us002-wt-err-");
    projectRoot = join(testDir, "repo");
    mkdirSync(projectRoot, { recursive: true });
    await initRepo(projectRoot);
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  test("AC-9: throws NaxError(WORKTREE_ERROR) whose message names the composed branch nax/story-f-US-001", async () => {
    const manager = new WorktreeManager();
    const worktreeId: WorktreeId = deriveStoryWorktreeId("f", "US-001");
    const expectedBranch = storyBranchName(worktreeId);

    // Seed the composed branch name so `git worktree add -b <branch>` fails
    // with "fatal: a branch named <branch> already exists".
    await git(["branch", expectedBranch], projectRoot);
    expect(await branchExists(projectRoot, expectedBranch)).toBe(true);

    let caught: unknown;
    try {
      await manager.create(projectRoot, worktreeId);
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught, "create() rejection when composed branch exists");
    expect(caught.code).toBe("WORKTREE_ERROR");
    expect(caught.message).toContain(expectedBranch);
  });
});

// ---------------------------------------------------------------------------
// AC-10/AC-11 — `create()` runs from two checkouts of the same repo against
// the same raw storyId for two different features. Both resolve without
// throwing, and the branch created from the main checkout still exists
// afterwards.
//
// Both pre and post implementations produce distinct composed branches
// (`nax/story-a-US-001` vs `nax/story-b-US-001`) — the brand only composes
// differently at the type level. The pre-fix would have produced
// `nax/US-001` and `nax/US-001` (collision), but as of US-001 the
// `WorktreeId` is the composed form, so the test exercises the brand
// composition path.
// ---------------------------------------------------------------------------

describe("US-002 WorktreeManager.create — AC-10/AC-11: linked-worktree create", () => {
  let testDir: string;
  let projectRoot: string;
  let linkedPath: string;

  beforeEach(async () => {
    testDir = makeTempDir("us002-linked-wt-");
    projectRoot = join(testDir, "main");
    mkdirSync(projectRoot, { recursive: true });
    await initRepo(projectRoot);

    // Add a second commit so the first linked worktree can checkout cleanly.
    writeFileSync(join(projectRoot, "second.txt"), "second");
    await git(["add", "second.txt"], projectRoot);
    await git(["commit", "-m", "second commit"], projectRoot);

    // Create a linked git worktree at <testDir>/linked from the same .git dir.
    linkedPath = join(testDir, "linked");
    await git(["worktree", "add", "--detach", linkedPath, "HEAD"], projectRoot);
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  test("AC-10: create() from the main checkout and create() from a linked worktree both resolve without throwing", async () => {
    const manager = new WorktreeManager();
    const worktreeIdMain: WorktreeId = deriveStoryWorktreeId("a", "US-001");
    const worktreeIdLinked: WorktreeId = deriveStoryWorktreeId("b", "US-001");
    // The ids are distinct: same raw storyId, different features.
    expect(worktreeIdMain).not.toBe(worktreeIdLinked);

    await expect(manager.create(projectRoot, worktreeIdMain)).resolves.toBeUndefined();
    await expect(manager.create(linkedPath, worktreeIdLinked)).resolves.toBeUndefined();
  });

  test("AC-11: after the AC-10 linked-worktree create, the branch nax/story-a-US-001 created from the main checkout still exists", async () => {
    const manager = new WorktreeManager();
    const worktreeIdMain: WorktreeId = deriveStoryWorktreeId("a", "US-001");
    const worktreeIdLinked: WorktreeId = deriveStoryWorktreeId("b", "US-001");

    await manager.create(projectRoot, worktreeIdMain);
    await manager.create(linkedPath, worktreeIdLinked);

    const expectedMainBranch = storyBranchName(worktreeIdMain);
    const expectedLinkedBranch = storyBranchName(worktreeIdLinked);
    expect(expectedMainBranch).toBe("nax/story-a-US-001");
    expect(expectedLinkedBranch).toBe("nax/story-b-US-001");

    expect(await branchExists(projectRoot, expectedMainBranch)).toBe(true);
    expect(await branchExists(projectRoot, expectedLinkedBranch)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Brand acceptance — passes a branded WorktreeId through the API. The brand
// is compile-time only at runtime, but the API now REQUIRES it (the signature
// narrows from `string` to `WorktreeId`).
// ---------------------------------------------------------------------------

describe("US-002 WorktreeId — branded type narrows the worktree API", () => {
  test("deriveStoryWorktreeId returns a WorktreeId-shaped string", () => {
    const id = deriveStoryWorktreeId("f", "US-001");
    expect(typeof id).toBe("string");
    expect(String(id)).toBe("story-f-US-001");
    // And a WorktreeId parameter accepts the derived value (compile-time
    // brand check).
    const typed: WorktreeId = id;
    expect(typed.startsWith("story-")).toBe(true);
  });
});
