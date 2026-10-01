/**
 * Integration test for src/bakeoff/preflight.ts — `reclaimStaleBakeoffBranches`.
 *
 * Covers US-004 AC-6 and AC-7: a leftover `nax/bakeoff-<id>` branch with no
 * live worktree record is reclaimed (removed) during preflight so a
 * subsequent worktree creation for that ID succeeds; branches outside the
 * `nax/bakeoff-` namespace are left untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { deriveBakeoffWorktreeId, reclaimStaleBakeoffBranches } from "@/bakeoff";
import { WorktreeManager } from "@/worktree";

async function git(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { stdout, exitCode };
}

async function branchExists(projectRoot: string, branchName: string): Promise<boolean> {
  const { stdout } = await git(["branch", "--list", branchName], projectRoot);
  return stdout.trim().length > 0;
}

describe("reclaimStaleBakeoffBranches", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = makeTempDir("bakeoff-reclaim-test-");
    mkdirSync(projectRoot, { recursive: true });
    await git(["init"], projectRoot);
    await git(["config", "user.email", "test@example.com"], projectRoot);
    await git(["config", "user.name", "Test User"], projectRoot);
    writeFileSync(join(projectRoot, "README.md"), "# test project");
    await git(["add", "README.md"], projectRoot);
    await git(["commit", "-m", "initial commit"], projectRoot);
  });

  afterEach(() => {
    cleanupTempDir(projectRoot);
  });

  // AC-6: a leftover nax/bakeoff-<id> branch with no worktree record is
  // removed, and worktree creation for that same ID subsequently succeeds.
  it("US-004 AC6: removes a leftover nax/bakeoff-<id> branch with no worktree record and lets worktree creation succeed", async () => {
    const feature = "orphan";
    const profile = "id";
    // US-002: derive the bakeoff identity through the producer so the
    // manager's `WorktreeId` signature is satisfied at the call site.
    const worktreeId = deriveBakeoffWorktreeId(feature, profile);
    const branchName = `nax/${worktreeId}`;
    // Simulate an orphaned branch left by a crashed prior run: a real
    // branch, but no matching worktree directory/record.
    await git(["branch", branchName], projectRoot);
    expect(await branchExists(projectRoot, branchName)).toBe(true);

    await reclaimStaleBakeoffBranches(projectRoot);

    expect(await branchExists(projectRoot, branchName)).toBe(false);

    const manager = new WorktreeManager();
    await manager.create(projectRoot, worktreeId);
    await manager.remove(projectRoot, worktreeId);
  });

  // AC-7: a branch outside the nax/bakeoff- namespace is never touched.
  it("US-004 AC7: leaves a branch not beginning with nax/bakeoff- in place", async () => {
    const branchName = "feature/unrelated-work";
    await git(["branch", branchName], projectRoot);
    expect(await branchExists(projectRoot, branchName)).toBe(true);

    await reclaimStaleBakeoffBranches(projectRoot);

    expect(await branchExists(projectRoot, branchName)).toBe(true);
  });
});
