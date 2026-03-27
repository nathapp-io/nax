/**
 * Unit tests for checks-git.ts — BUG-074 nax runtime file allowlist
 *
 * Tests the NAX_RUNTIME_PATTERNS allowlist in checkWorkingTreeClean:
 * - passes when only nax runtime files are dirty
 * - fails when non-nax files are dirty
 * - message lists dirty non-nax filenames (not nax runtime files)
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkWorkingTreeClean } from "../../../src/precheck/checks-git";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a git repo with the nax directory structure pre-committed.
 * This ensures that individual file paths (not just ".nax/") appear in git status.
 */
function makeGitRepoWithNax(): string {
  const dir = mkdtempSync(join(tmpdir(), "nax-git-test-"));

  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });

  git(["init"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "user.name", "Test"]);

  // Create a baseline committed file
  writeFileSync(join(dir, "README.md"), "# test\n");

  // Pre-commit the nax directory structure so individual files show in git status
  mkdirSync(join(dir, ".nax", "features", "feat-001", "runs"), { recursive: true });
  writeFileSync(join(dir, "nax.lock"), "");
  writeFileSync(join(dir, ".nax", "metrics.json"), "{}");
  writeFileSync(join(dir, ".nax", "features", "feat-001", "status.json"), "{}");
  writeFileSync(join(dir, ".nax", "features", "feat-001", "prd.json"), "{}");
  writeFileSync(join(dir, ".nax", "features", "feat-001", "progress.txt"), "");
  writeFileSync(join(dir, ".nax", "features", "feat-001", "acp-sessions.json"), "{}");
  writeFileSync(join(dir, ".nax", "features", "feat-001", "acceptance-refined.json"), "[]");
  writeFileSync(join(dir, ".nax-pids"), "");
  mkdirSync(join(dir, ".nax-wt"), { recursive: true });
  writeFileSync(join(dir, ".nax-wt", "placeholder"), "");
  writeFileSync(join(dir, ".nax-verifier-verdict.json"), "{}");

  git(["add", "."]);
  git(["commit", "-m", "init"]);

  return dir;
}

/**
 * Create a minimal git repo with only README committed.
 */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nax-git-test-"));

  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });

  git(["init"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
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
    const dir = makeGitRepo();
    try {
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(true);
      expect(result.message).toBe("Working tree is clean");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("passes when only nax.lock is dirty (new untracked file)", async () => {
    const dir = makeGitRepo();
    try {
      writeFileSync(join(dir, "nax.lock"), "locked\n");
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("passes when only nax/metrics.json is dirty (modified tracked file)", async () => {
    const dir = makeGitRepoWithNax();
    try {
      // Modify the tracked file to make it dirty
      writeFileSync(join(dir, ".nax", "metrics.json"), '{"updated": true}');
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("passes when only nax feature runtime files are dirty (modified tracked files)", async () => {
    const dir = makeGitRepoWithNax();
    try {
      writeFileSync(join(dir, ".nax", "features", "feat-001", "status.json"), '{"status":"running"}');
      writeFileSync(join(dir, ".nax", "features", "feat-001", "progress.txt"), "50%");
      writeFileSync(join(dir, ".nax", "features", "feat-001", "acp-sessions.json"), '{"session":"abc"}');
      writeFileSync(join(dir, ".nax", "features", "feat-001", "acceptance-refined.json"), '[{"ac":"1"}]');
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("fails when a non-nax file is dirty", async () => {
    const dir = makeGitRepo();
    try {
      writeFileSync(join(dir, "src.ts"), "export const x = 1;\n");
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("fails when both nax and non-nax files are dirty", async () => {
    const dir = makeGitRepo();
    try {
      writeFileSync(join(dir, "nax.lock"), "locked\n");
      writeFileSync(join(dir, "dirty.ts"), "export const x = 1;\n");
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("message includes dirty non-nax filename when not passed", async () => {
    const dir = makeGitRepo();
    try {
      writeFileSync(join(dir, "dirty.ts"), "export const x = 1;\n");
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(false);
      expect(result.message).toContain("dirty.ts");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("message does NOT include nax.lock when only nax runtime files are dirty", async () => {
    const dir = makeGitRepo();
    try {
      writeFileSync(join(dir, "nax.lock"), "locked\n");
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(true);
      expect(result.message).not.toContain("nax.lock");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("message lists multiple dirty non-nax files", async () => {
    const dir = makeGitRepo();
    try {
      writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
      writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
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
    const dir = makeGitRepo();
    try {
      writeFileSync(join(dir, ".nax-acceptance.test.ts"), 'test("AC-1", () => {});\n');
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("US-003: passes when .nax-acceptance.test.ts in a tracked package subdir is dirty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nax-git-test-"));
    const git = (args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    try {
      git(["init"]);
      git(["config", "user.email", "test@test.com"]);
      git(["config", "user.name", "Test"]);
      // Commit a file inside apps/api/ so the directory is tracked
      mkdirSync(join(dir, "apps", "api"), { recursive: true });
      writeFileSync(join(dir, "apps", "api", "index.ts"), "export {};\n");
      git(["add", "."]);
      git(["commit", "-m", "init"]);
      // Now add the nax acceptance file as untracked in a tracked directory
      writeFileSync(join(dir, "apps", "api", ".nax-acceptance.test.ts"), 'test("AC-1", () => {});\n');
      const result = await checkWorkingTreeClean(dir);
      expect(result.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
