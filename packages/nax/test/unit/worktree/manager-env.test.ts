import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, withDebugSpy } from "@test/helpers";
import { gitWithTimeout } from "@/utils/git";
import { deriveStoryWorktreeId, storyWorktreePath, WorktreeManager } from "@/worktree";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

async function makeCommittedRepo(options: { trackedEnv?: boolean; ignoredEnv?: boolean }): Promise<string> {
  const projectRoot = makeTempDir("nax-worktree-env-");
  tempDirs.push(projectRoot);
  await gitWithTimeout(["init", "-q"], projectRoot);
  await gitWithTimeout(["config", "user.email", "nax-test@example.invalid"], projectRoot);
  await gitWithTimeout(["config", "user.name", "Nax Test"], projectRoot);
  if (options.trackedEnv) writeFileSync(join(projectRoot, ".env"), "A=1\n");
  if (options.ignoredEnv) {
    writeFileSync(join(projectRoot, ".gitignore"), ".env\n");
    writeFileSync(join(projectRoot, ".env"), "A=1\n");
  }
  if (!options.trackedEnv && !options.ignoredEnv) writeFileSync(join(projectRoot, "README.md"), "seed\n");
  await gitWithTimeout(["add", "-A"], projectRoot);
  await gitWithTimeout(
    ["-c", "user.email=nax-test@example.invalid", "-c", "user.name=Nax Test", "commit", "-q", "-m", "seed"],
    projectRoot,
  );
  return projectRoot;
}

describe("WorktreeManager.create .env handling — US-004", () => {
  test("AC-10: tracked .env remains a checked-out regular file with the debug explanation", async () => {
    const projectRoot = await makeCommittedRepo({ trackedEnv: true });
    const id = deriveStoryWorktreeId("env-feature", "US-010");
    await withDebugSpy(async (debugSpy) => {
      await new WorktreeManager().create(projectRoot, id);
      const envTarget = join(storyWorktreePath(projectRoot, id), ".env");
      expect(lstatSync(envTarget).isFile()).toBe(true);
      expect(lstatSync(envTarget).isSymbolicLink()).toBe(false);
      expect(readFileSync(envTarget, "utf8")).toBe("A=1\n");
      expect(
        debugSpy.mock.calls.some((call) => call[1] === ".env is tracked; the worktree keeps the checked-out copy"),
      ).toBe(true);
    });
  });

  test("AC-11: an ignored, untracked .env is symlinked from the project root", async () => {
    const projectRoot = await makeCommittedRepo({ ignoredEnv: true });
    const id = deriveStoryWorktreeId("env-feature", "US-011");
    await new WorktreeManager().create(projectRoot, id);
    const envTarget = join(storyWorktreePath(projectRoot, id), ".env");
    expect(lstatSync(envTarget).isSymbolicLink()).toBe(true);
    expect(readlinkSync(envTarget)).toBe(join(projectRoot, ".env"));
    expect(readFileSync(envTarget, "utf8")).toBe("A=1\n");
  });

  test("AC-12: no .env source creates no .env in the worktree", async () => {
    const projectRoot = await makeCommittedRepo({});
    const id = deriveStoryWorktreeId("env-feature", "US-012");
    await new WorktreeManager().create(projectRoot, id);
    expect(await Bun.file(join(storyWorktreePath(projectRoot, id), ".env")).exists()).toBe(false);
  });
});
