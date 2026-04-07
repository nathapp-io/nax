// RE-ARCH: keep
/**
 * Review Stage Plugin Integration Tests
 *
 * Tests plugin reviewer integration in the review pipeline stage.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { reviewStage } from "../../../src/pipeline/stages/review";
import type { PipelineContext } from "../../../src/pipeline/types";
import { PluginRegistry } from "../../../src/plugins/registry";
import type { IReviewPlugin, NaxPlugin } from "../../../src/plugins/types";
import { makeTempDir } from "../../helpers/temp";

/**
 * Create a mock pipeline context with minimal required fields
 */
function createMockContext(workdir: string, plugins?: PluginRegistry): PipelineContext {
  return {
    config: {
      review: {
        enabled: true,
        checks: [],
        commands: {},
      },
      quality: {
        commands: {},
      },
    } as any,
    rootConfig: {
      autoMode: { defaultAgent: "nax-agent-claude", fallbackOrder: [] },
    } as any,
    prd: {} as any,
    story: { id: "US-003" } as any,
    stories: [],
    routing: {} as any,
    projectDir: workdir,
    workdir,
    hooks: {} as any,
    plugins,
  };
}

/**
 * Initialize a git repo in the test directory
 */
async function initGitRepo(workdir: string) {
  await spawn({ cmd: ["git", "init"], cwd: workdir, stdout: "ignore", stderr: "ignore" }).exited;
  await spawn({
    cmd: ["git", "config", "user.email", "test@example.com"],
    cwd: workdir,
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  await spawn({
    cmd: ["git", "config", "user.name", "Test User"],
    cwd: workdir,
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  await spawn({ cmd: ["git", "add", "-A"], cwd: workdir, stdout: "ignore", stderr: "ignore" }).exited;
  await spawn({
    cmd: ["git", "commit", "-m", "initial"],
    cwd: workdir,
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
}

describe("Review Stage - Plugin Integration", () => {
  describe("AC1: Plugin reviewers run after built-in checks pass", () => {
    test("plugin reviewers execute when built-in checks pass", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      let pluginCalled = false;
      const mockReviewer: IReviewPlugin = {
        name: "test-reviewer",
        description: "Test reviewer",
        async check() {
          pluginCalled = true;
          return { passed: true, output: "All good" };
        },
      };

      const mockPlugin: NaxPlugin = {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: mockReviewer },
      };

      const registry = new PluginRegistry([mockPlugin]);
      const ctx = createMockContext(tempDir, registry);

      const result = await reviewStage.execute(ctx);

      expect(pluginCalled).toBe(true);
      expect(result.action).toBe("continue");
    });

    test("plugin reviewers do not run if built-in checks fail", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      let pluginCalled = false;
      const mockReviewer: IReviewPlugin = {
        name: "test-reviewer",
        description: "Test reviewer",
        async check() {
          pluginCalled = true;
          return { passed: true, output: "All good" };
        },
      };

      const mockPlugin: NaxPlugin = {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: mockReviewer },
      };

      const registry = new PluginRegistry([mockPlugin]);
      const ctx = createMockContext(tempDir, registry);
      // Configure a failing built-in check
      ctx.config.review.checks = ["typecheck"];
      ctx.config.review.commands = { typecheck: "sh -c 'exit 1'" };

      const result = await reviewStage.execute(ctx);

      expect(pluginCalled).toBe(false);
      // Built-in check failures return continue — autofix stage handles the retry
      expect(result.action).toBe("continue");
      expect(ctx.reviewResult?.success).toBe(false);
    });

    test("no plugin reviewers registered - continues normally", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      const registry = new PluginRegistry([]);
      const ctx = createMockContext(tempDir, registry);

      const result = await reviewStage.execute(ctx);

      expect(result.action).toBe("continue");
    });
  });

  describe("AC2: Each reviewer receives workdir and changed files", () => {
    test("reviewer receives correct workdir", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      let receivedWorkdir: string | undefined;
      const mockReviewer: IReviewPlugin = {
        name: "test-reviewer",
        description: "Test reviewer",
        async check(workdir) {
          receivedWorkdir = workdir;
          return { passed: true, output: "OK" };
        },
      };

      const mockPlugin: NaxPlugin = {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: mockReviewer },
      };

      const registry = new PluginRegistry([mockPlugin]);
      const ctx = createMockContext(tempDir, registry);

      await reviewStage.execute(ctx);

      expect(receivedWorkdir).toBe(tempDir);
    });

    test("BUG-074: auto-commits dirty files before review so review proceeds (bun.lock scenario)", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");

      // Create a file first
      writeFileSync(join(tempDir, "test.ts"), "// initial");

      await initGitRepo(tempDir);

      // Simulate agent leaving dirty files (e.g. bun add modifying bun.lock/package.json)
      writeFileSync(join(tempDir, "test.ts"), "// modified by agent — not yet committed");

      let reviewerCalled = false;
      const mockReviewer: IReviewPlugin = {
        name: "test-reviewer",
        description: "Test reviewer",
        async check(_workdir) {
          reviewerCalled = true;
          return { passed: true, output: "OK" };
        },
      };

      const mockPlugin: NaxPlugin = {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: mockReviewer },
      };

      const registry = new PluginRegistry([mockPlugin]);
      const ctx = createMockContext(tempDir, registry);

      const result = await reviewStage.execute(ctx);

      // BUG-074: dirty files are auto-committed before the dirty-tree check,
      // so review proceeds. The reviewer IS called (not blocked by dirty check).
      expect(reviewerCalled).toBe(true);
      expect(ctx.reviewResult?.success).toBe(true);
      // Stage returns "continue" or "complete" — not blocked
      expect(result.action).not.toBe("fail");
    });

    test("reviewer receives empty array when no files changed", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      let receivedFiles: string[] | undefined;
      const mockReviewer: IReviewPlugin = {
        name: "test-reviewer",
        description: "Test reviewer",
        async check(_workdir, changedFiles) {
          receivedFiles = changedFiles;
          return { passed: true, output: "OK" };
        },
      };

      const mockPlugin: NaxPlugin = {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: mockReviewer },
      };

      const registry = new PluginRegistry([mockPlugin]);
      const ctx = createMockContext(tempDir, registry);

      await reviewStage.execute(ctx);

      expect(receivedFiles).toEqual([]);
    });
  });

  describe("AC3: Reviewer failure triggers retry/escalation", () => {
    test("failing reviewer returns fail action", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      const mockReviewer: IReviewPlugin = {
        name: "failing-reviewer",
        description: "Failing reviewer",
        async check() {
          return { passed: false, output: "Security issues found" };
        },
      };

      const mockPlugin: NaxPlugin = {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: mockReviewer },
      };

      const registry = new PluginRegistry([mockPlugin]);
      const ctx = createMockContext(tempDir, registry);

      const result = await reviewStage.execute(ctx);

      expect(result.action).toBe("fail");
      expect(result.reason).toContain("failing-reviewer");
      expect(result.reason).toContain("failed");
    });

    test("reviewer failure includes plugin name in reason", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      const mockReviewer: IReviewPlugin = {
        name: "security-scanner",
        description: "Security scanner",
        async check() {
          return { passed: false, output: "Vulnerabilities detected" };
        },
      };

      const mockPlugin: NaxPlugin = {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: mockReviewer },
      };

      const registry = new PluginRegistry([mockPlugin]);
      const ctx = createMockContext(tempDir, registry);

      const result = await reviewStage.execute(ctx);

      expect(result.action).toBe("fail");
      expect(result.reason).toContain("security-scanner");
    });
  });

  describe("AC4: Reviewer output included in story result", () => {
    test("passing reviewer output is captured", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      const mockReviewer: IReviewPlugin = {
        name: "test-reviewer",
        description: "Test reviewer",
        async check() {
          return { passed: true, output: "All checks passed successfully", exitCode: 0 };
        },
      };

      const mockPlugin: NaxPlugin = {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: mockReviewer },
      };

      const registry = new PluginRegistry([mockPlugin]);
      const ctx = createMockContext(tempDir, registry);

      await reviewStage.execute(ctx);

      expect(ctx.reviewResult).toBeDefined();
      expect(ctx.reviewResult?.pluginReviewers).toBeDefined();
      expect(ctx.reviewResult?.pluginReviewers).toHaveLength(1);
      expect(ctx.reviewResult?.pluginReviewers?.[0].name).toBe("test-reviewer");
      expect(ctx.reviewResult?.pluginReviewers?.[0].passed).toBe(true);
      expect(ctx.reviewResult?.pluginReviewers?.[0].output).toBe("All checks passed successfully");
      expect(ctx.reviewResult?.pluginReviewers?.[0].exitCode).toBe(0);
    });

    test("failing reviewer output is captured", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      const mockReviewer: IReviewPlugin = {
        name: "security-scanner",
        description: "Security scanner",
        async check() {
          return {
            passed: false,
            output: "Found 3 critical vulnerabilities",
            exitCode: 1,
          };
        },
      };

      const mockPlugin: NaxPlugin = {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: mockReviewer },
      };

      const registry = new PluginRegistry([mockPlugin]);
      const ctx = createMockContext(tempDir, registry);

      await reviewStage.execute(ctx);

      expect(ctx.reviewResult?.pluginReviewers).toBeDefined();
      expect(ctx.reviewResult?.pluginReviewers).toHaveLength(1);
      expect(ctx.reviewResult?.pluginReviewers?.[0].name).toBe("security-scanner");
      expect(ctx.reviewResult?.pluginReviewers?.[0].passed).toBe(false);
      expect(ctx.reviewResult?.pluginReviewers?.[0].output).toBe("Found 3 critical vulnerabilities");
      expect(ctx.reviewResult?.pluginReviewers?.[0].exitCode).toBe(1);
    });
  });

  describe("AC5: Exceptions count as failures", () => {
    test("reviewer throwing exception counts as failure", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      const mockReviewer: IReviewPlugin = {
        name: "buggy-reviewer",
        description: "Buggy reviewer",
        async check() {
          throw new Error("Unexpected error in reviewer");
        },
      };

      const mockPlugin: NaxPlugin = {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: mockReviewer },
      };

      const registry = new PluginRegistry([mockPlugin]);
      const ctx = createMockContext(tempDir, registry);

      const result = await reviewStage.execute(ctx);

      expect(result.action).toBe("fail");
      expect(result.reason).toContain("buggy-reviewer");
      expect(result.reason).toContain("threw error");
    });

    test("exception message captured in output", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      const mockReviewer: IReviewPlugin = {
        name: "failing-reviewer",
        description: "Failing reviewer",
        async check() {
          throw new Error("Connection timeout");
        },
      };

      const mockPlugin: NaxPlugin = {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: mockReviewer },
      };

      const registry = new PluginRegistry([mockPlugin]);
      const ctx = createMockContext(tempDir, registry);

      await reviewStage.execute(ctx);

      expect(ctx.reviewResult?.pluginReviewers).toBeDefined();
      expect(ctx.reviewResult?.pluginReviewers).toHaveLength(1);
      expect(ctx.reviewResult?.pluginReviewers?.[0].passed).toBe(false);
      expect(ctx.reviewResult?.pluginReviewers?.[0].error).toBe("Connection timeout");
    });

    test("non-Error exception converted to string", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      const mockReviewer: IReviewPlugin = {
        name: "string-thrower",
        description: "String thrower",
        async check() {
          throw "Something went wrong"; // eslint-disable-line
        },
      };

      const mockPlugin: NaxPlugin = {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: mockReviewer },
      };

      const registry = new PluginRegistry([mockPlugin]);
      const ctx = createMockContext(tempDir, registry);

      await reviewStage.execute(ctx);

      expect(ctx.reviewResult?.pluginReviewers?.[0].error).toBe("Something went wrong");
    });
  });

  describe("AC6: Multiple reviewers run sequentially with short-circuiting", () => {
    test("multiple reviewers run in order when all pass", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      const callOrder: string[] = [];

      const reviewer1: IReviewPlugin = {
        name: "reviewer-1",
        description: "First reviewer",
        async check() {
          callOrder.push("reviewer-1");
          return { passed: true, output: "OK" };
        },
      };

      const reviewer2: IReviewPlugin = {
        name: "reviewer-2",
        description: "Second reviewer",
        async check() {
          callOrder.push("reviewer-2");
          return { passed: true, output: "OK" };
        },
      };

      const reviewer3: IReviewPlugin = {
        name: "reviewer-3",
        description: "Third reviewer",
        async check() {
          callOrder.push("reviewer-3");
          return { passed: true, output: "OK" };
        },
      };

      const plugin1: NaxPlugin = {
        name: "plugin-1",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: reviewer1 },
      };

      const plugin2: NaxPlugin = {
        name: "plugin-2",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: reviewer2 },
      };

      const plugin3: NaxPlugin = {
        name: "plugin-3",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: reviewer3 },
      };

      const registry = new PluginRegistry([plugin1, plugin2, plugin3]);
      const ctx = createMockContext(tempDir, registry);

      const result = await reviewStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(callOrder).toEqual(["reviewer-1", "reviewer-2", "reviewer-3"]);
      expect(ctx.reviewResult?.pluginReviewers).toHaveLength(3);
    });

    test("first failure short-circuits remaining reviewers", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      const callOrder: string[] = [];

      const reviewer1: IReviewPlugin = {
        name: "reviewer-1",
        description: "First reviewer",
        async check() {
          callOrder.push("reviewer-1");
          return { passed: true, output: "OK" };
        },
      };

      const reviewer2: IReviewPlugin = {
        name: "reviewer-2",
        description: "Second reviewer (fails)",
        async check() {
          callOrder.push("reviewer-2");
          return { passed: false, output: "Failed" };
        },
      };

      const reviewer3: IReviewPlugin = {
        name: "reviewer-3",
        description: "Third reviewer (should not run)",
        async check() {
          callOrder.push("reviewer-3");
          return { passed: true, output: "OK" };
        },
      };

      const plugin1: NaxPlugin = {
        name: "plugin-1",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: reviewer1 },
      };

      const plugin2: NaxPlugin = {
        name: "plugin-2",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: reviewer2 },
      };

      const plugin3: NaxPlugin = {
        name: "plugin-3",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: reviewer3 },
      };

      const registry = new PluginRegistry([plugin1, plugin2, plugin3]);
      const ctx = createMockContext(tempDir, registry);

      const result = await reviewStage.execute(ctx);

      expect(result.action).toBe("fail");
      expect(callOrder).toEqual(["reviewer-1", "reviewer-2"]);
      expect(callOrder).not.toContain("reviewer-3");
      expect(ctx.reviewResult?.pluginReviewers).toHaveLength(2);
    });

    test("exception short-circuits remaining reviewers", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      const callOrder: string[] = [];

      const reviewer1: IReviewPlugin = {
        name: "reviewer-1",
        description: "First reviewer",
        async check() {
          callOrder.push("reviewer-1");
          return { passed: true, output: "OK" };
        },
      };

      const reviewer2: IReviewPlugin = {
        name: "reviewer-2",
        description: "Second reviewer (throws)",
        async check() {
          callOrder.push("reviewer-2");
          throw new Error("Boom!");
        },
      };

      const reviewer3: IReviewPlugin = {
        name: "reviewer-3",
        description: "Third reviewer (should not run)",
        async check() {
          callOrder.push("reviewer-3");
          return { passed: true, output: "OK" };
        },
      };

      const plugin1: NaxPlugin = {
        name: "plugin-1",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: reviewer1 },
      };

      const plugin2: NaxPlugin = {
        name: "plugin-2",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: reviewer2 },
      };

      const plugin3: NaxPlugin = {
        name: "plugin-3",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: reviewer3 },
      };

      const registry = new PluginRegistry([plugin1, plugin2, plugin3]);
      const ctx = createMockContext(tempDir, registry);

      const result = await reviewStage.execute(ctx);

      expect(result.action).toBe("fail");
      expect(callOrder).toEqual(["reviewer-1", "reviewer-2"]);
      expect(callOrder).not.toContain("reviewer-3");
      expect(ctx.reviewResult?.pluginReviewers).toHaveLength(2);
    });
  });

  describe("Edge Cases", () => {
    test("no plugins context - continues normally", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      const ctx = createMockContext(tempDir, undefined);

      const result = await reviewStage.execute(ctx);

      expect(result.action).toBe("continue");
    });

    test("reviewer returns empty output", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      const mockReviewer: IReviewPlugin = {
        name: "silent-reviewer",
        description: "Silent reviewer",
        async check() {
          return { passed: true, output: "" };
        },
      };

      const mockPlugin: NaxPlugin = {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: mockReviewer },
      };

      const registry = new PluginRegistry([mockPlugin]);
      const ctx = createMockContext(tempDir, registry);

      const result = await reviewStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(ctx.reviewResult?.pluginReviewers?.[0].output).toBe("");
    });

    test("reviewer without exitCode works", async () => {
      const tempDir = makeTempDir("nax-review-plugin-");
      await initGitRepo(tempDir);

      const mockReviewer: IReviewPlugin = {
        name: "test-reviewer",
        description: "Test reviewer",
        async check() {
          return { passed: true, output: "OK" }; // No exitCode
        },
      };

      const mockPlugin: NaxPlugin = {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: { reviewer: mockReviewer },
      };

      const registry = new PluginRegistry([mockPlugin]);
      const ctx = createMockContext(tempDir, registry);

      const result = await reviewStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(ctx.reviewResult?.pluginReviewers?.[0].exitCode).toBeUndefined();
    });
  });
});
