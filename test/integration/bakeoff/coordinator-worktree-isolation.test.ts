/**
 * Integration test for src/bakeoff/coordinator.ts + src/bakeoff/contestant.ts
 * + src/worktree/manager.ts.
 *
 * Covers US-002 AC-10: a two-contestant bake-off, run against a real git
 * repository with a real `WorktreeManager`, creates two distinct `.nax-wt`
 * directories (one per contestant) and removes both before `runBakeoff`
 * returns.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBakeoff, runContestant } from "@/bakeoff";
import type { BakeoffCoordinatorDeps, ContestantOptions, ContestantRunnerDeps } from "@/bakeoff";
import type { NaxConfig } from "@/config";
import { WorktreeManager } from "@/worktree";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

describe("runBakeoff worktree isolation (US-002 AC10)", () => {
  let testDir: string;
  let projectRoot: string;
  let outputDir: string;

  beforeEach(async () => {
    testDir = makeTempDir("bakeoff-wt-isolation-");
    projectRoot = join(testDir, "project");
    outputDir = join(testDir, "output");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    await git(["init"], projectRoot);
    await git(["config", "user.email", "test@example.com"], projectRoot);
    await git(["config", "user.name", "Test User"], projectRoot);
    writeFileSync(join(projectRoot, "README.md"), "# test project");
    await git(["add", "README.md"], projectRoot);
    await git(["commit", "-m", "initial commit"], projectRoot);
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it("US-002 AC10: creates two distinct .nax-wt directories and removes both before returning", async () => {
    const manager = new WorktreeManager();
    const observedPaths: string[] = [];

    const worktreeManager: ContestantRunnerDeps["worktreeManager"] = {
      create: async (root: string, storyId: string) => {
        await manager.create(root, storyId);
        observedPaths.push(join(root, ".nax-wt", storyId));
      },
      remove: (root: string, storyId: string) => manager.remove(root, storyId),
    };
    const pipeline: ContestantRunnerDeps["pipeline"] = async () => ({
      results: [{ status: "passed" }],
      metrics: [],
    });

    const runContestantSpy = (agent: string, options: ContestantOptions) =>
      runContestant(agent, options, { worktreeManager, pipeline });

    const deps: Partial<BakeoffCoordinatorDeps> = {
      validateContestants: async (names: string[]) => ({
        errors: [],
        validAgents: names,
        profileData: {},
      }),
      runContestant: runContestantSpy,
      persistBakeoffResult: mock(async () => {}),
    };

    await runBakeoff(
      {
        agents: ["claude", "codex"],
        feature: "test-feature",
        projectRoot,
        outputDir,
        config: {} as unknown as NaxConfig,
      },
      deps,
    );

    expect(observedPaths).toHaveLength(2);
    expect(new Set(observedPaths).size).toBe(2);
    for (const path of observedPaths) {
      expect(existsSync(path)).toBe(false);
    }
  });
});
