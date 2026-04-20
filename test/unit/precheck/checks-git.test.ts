/**
 * Unit tests for checks-git.ts — BUG-074 nax runtime file allowlist
 *
 * Tests the NAX_RUNTIME_PATTERNS allowlist in checkWorkingTreeClean:
 * - passes when only nax runtime files are dirty
 * - fails when non-nax files are dirty
 * - message lists dirty non-nax filenames (not nax runtime files)
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWorkingTreeClean } from "../../../src/precheck/checks-git";
import { makeTempDir } from "../../helpers/temp";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a git repo with the nax directory structure pre-committed.
 * This ensures that individual file paths (not just ".nax/") appear in git status.
 */
async function makeGitRepoWithNax(): Promise<string> {
  const dir = makeTempDir("nax-git-test-");

  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });

  git(["init"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "user.name", "Test"]);

  // Create a baseline committed file
  await Bun.write(join(dir, "README.md"), "# test\n");

  // Pre-commit the nax directory structure so individual files show in git status
  mkdirSync(join(dir, ".nax", "features", "feat-001", "runs"), { recursive: true });
  await Bun.write(join(dir, "nax.lock"), "");
  await Bun.write(join(dir, ".nax", "metrics.json"), "{}");
  await Bun.write(join(dir, ".nax", "features", "feat-001", "status.json"), "{}");
  await Bun.write(join(dir, ".nax", "features", "feat-001", "prd.json"), "{}");
  await Bun.write(join(dir, ".nax", "features", "feat-001", "progress.txt"), "");
  await Bun.write(join(dir, ".nax", "features", "feat-001", "acp-sessions.json"), "{}");
  await Bun.write(join(dir, ".nax", "features", "feat-001", "acceptance-refined.json"), "[]");
  await Bun.write(join(dir, ".nax-pids"), "");
  mkdirSync(join(dir, ".nax-wt"), { recursive: true });
  await Bun.write(join(dir, ".nax-wt", "placeholder"), "");
  await Bun.write(join(dir, ".nax-verifier-verdict.json"), "{}");

  git(["add", "."]);
  git(["commit", "-m", "init"]);

  return dir;
}

/**
 * Create a minimal git repo with only README committed.
 */
async function makeGitRepo(): Promise<string> {
  const dir = makeTempDir("nax-git-test-");

  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });

  git(["init"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "user.name", "Test"]);
  await Bun.write(join(dir, "README.md"), "# test\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "init"]);

  return dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// BUG-074
describe("checkWorkingTreeClean — nax runtime files are excluded from dirty-tree check", () => {
  test("passes when working tree is clean", async () => {
    const dir = await makeGitRepo();
    try {
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(true);
      expect(result.message).toBe("Working tree is clean");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("passes when only nax.lock is dirty (new untracked file)", async () => {
    const dir = await makeGitRepo();
    try {
      await Bun.write(join(dir, "nax.lock"), "locked\n");
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("passes when only nax/metrics.json is dirty (modified tracked file)", async () => {
    const dir = await makeGitRepoWithNax();
    try {
      // Modify the tracked file to make it dirty
      await Bun.write(join(dir, ".nax", "metrics.json"), '{"updated": true}');
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("passes when only nax feature runtime files are dirty (modified tracked files)", async () => {
    const dir = await makeGitRepoWithNax();
    try {
      await Bun.write(join(dir, ".nax", "features", "feat-001", "status.json"), '{"status":"running"}');
      await Bun.write(join(dir, ".nax", "features", "feat-001", "progress.txt"), "50%");
      await Bun.write(join(dir, ".nax", "features", "feat-001", "acp-sessions.json"), '{"session":"abc"}');
      await Bun.write(join(dir, ".nax", "features", "feat-001", "acceptance-refined.json"), '[{"ac":"1"}]');
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("fails when a non-nax file is dirty", async () => {
    const dir = await makeGitRepo();
    try {
      await Bun.write(join(dir, "src.ts"), "export const x = 1;\n");
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("fails when both nax and non-nax files are dirty", async () => {
    const dir = await makeGitRepo();
    try {
      await Bun.write(join(dir, "nax.lock"), "locked\n");
      await Bun.write(join(dir, "dirty.ts"), "export const x = 1;\n");
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("message includes dirty non-nax filename when not passed", async () => {
    const dir = await makeGitRepo();
    try {
      await Bun.write(join(dir, "dirty.ts"), "export const x = 1;\n");
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(false);
      expect(result.message).toContain("dirty.ts");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("message does NOT include nax.lock when only nax runtime files are dirty", async () => {
    const dir = await makeGitRepo();
    try {
      await Bun.write(join(dir, "nax.lock"), "locked\n");
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(true);
      expect(result.message).not.toContain("nax.lock");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("message lists multiple dirty non-nax files", async () => {
    const dir = await makeGitRepo();
    try {
      await Bun.write(join(dir, "a.ts"), "export const a = 1;\n");
      await Bun.write(join(dir, "b.ts"), "export const b = 2;\n");
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(false);
      expect(result.message).toContain("a.ts");
      expect(result.message).toContain("b.ts");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // US-003 (ACC-002): .nax-acceptance* files are nax runtime files
  test("US-003: passes when only .nax-acceptance.test.ts is dirty (root level)", async () => {
    const dir = await makeGitRepo();
    try {
      await Bun.write(join(dir, ".nax-acceptance.test.ts"), 'test("AC-1", () => {});\n');
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("US-003: passes when .nax-acceptance.test.ts in a tracked package subdir is dirty", async () => {
    const dir = makeTempDir("nax-git-test-");
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    try {
      git(["init"]);
      git(["config", "user.email", "test@test.com"]);
      git(["config", "user.name", "Test"]);
      // Commit a file inside apps/api/ so the directory is tracked
      mkdirSync(join(dir, "apps", "api"), { recursive: true });
      await Bun.write(join(dir, "apps", "api", "index.ts"), "export {};\n");
      git(["add", "."]);
      git(["commit", "-m", "init"]);
      // Now add the nax acceptance file as untracked in a tracked directory
      await Bun.write(join(dir, "apps", "api", ".nax-acceptance.test.ts"), 'test("AC-1", () => {});\n');
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
