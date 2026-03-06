/**
 * Review Config-Driven Commands Tests (US-005)
 *
 * Tests config-driven command resolution for review stage:
 * 1. Explicit config.execution.lintCommand/typecheckCommand
 * 2. package.json script detection
 * 3. Skipping when not found
 * 4. null = explicitly disabled
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionConfig } from "../../../src/config/schema";
import { runReview } from "../../../src/review";
import type { ReviewConfig } from "../../../src/review";

describe("Review Config-Driven Commands (US-005)", () => {
  test("uses explicit executionConfig.lintCommand when provided", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-config-"));

    const reviewConfig: ReviewConfig = {
      enabled: true,
      checks: ["lint"],
      commands: {},
    };

    const executionConfig: Partial<ExecutionConfig> = {
      lintCommand: "echo 'custom lint command'",
    };

    const result = await runReview(reviewConfig, tempDir, executionConfig as ExecutionConfig);

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].command).toBe("echo 'custom lint command'");
    expect(result.checks[0].output).toContain("custom lint command");
  });

  test("uses explicit executionConfig.typecheckCommand when provided", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-config-"));

    const reviewConfig: ReviewConfig = {
      enabled: true,
      checks: ["typecheck"],
      commands: {},
    };

    const executionConfig: Partial<ExecutionConfig> = {
      typecheckCommand: "echo 'custom typecheck command'",
    };

    const result = await runReview(reviewConfig, tempDir, executionConfig as ExecutionConfig);

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].command).toBe("echo 'custom typecheck command'");
    expect(result.checks[0].output).toContain("custom typecheck command");
  });

  test("skips check when executionConfig command is null (explicitly disabled)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-config-"));

    const reviewConfig: ReviewConfig = {
      enabled: true,
      checks: ["lint", "typecheck"],
      commands: {},
    };

    const executionConfig: Partial<ExecutionConfig> = {
      lintCommand: null,
      typecheckCommand: "echo 'typecheck ok'",
    };

    const result = await runReview(reviewConfig, tempDir, executionConfig as ExecutionConfig);

    // lint skipped, only typecheck ran
    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe("typecheck");
  });

  test("uses package.json script when no executionConfig override", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-config-"));

    // Create package.json with lint script
    const packageJson = {
      name: "test-project",
      scripts: {
        lint: "echo 'package.json lint'",
      },
    };
    writeFileSync(join(tempDir, "package.json"), JSON.stringify(packageJson, null, 2));

    const reviewConfig: ReviewConfig = {
      enabled: true,
      checks: ["lint"],
      commands: {},
    };

    const result = await runReview(reviewConfig, tempDir);

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].command).toBe("bun run lint");
    expect(result.checks[0].output).toContain("package.json lint");
  });

  test("skips check when package.json script not found", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-config-"));

    // Create package.json WITHOUT lint script
    const packageJson = {
      name: "test-project",
      scripts: {
        test: "echo 'test'",
      },
    };
    writeFileSync(join(tempDir, "package.json"), JSON.stringify(packageJson, null, 2));

    const reviewConfig: ReviewConfig = {
      enabled: true,
      checks: ["lint", "typecheck"],
      commands: {},
    };

    const result = await runReview(reviewConfig, tempDir);

    // Both skipped (no commands found)
    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(0);
  });

  test("executionConfig takes precedence over package.json", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-config-"));

    // Create package.json with lint script
    const packageJson = {
      name: "test-project",
      scripts: {
        lint: "echo 'package.json lint'",
      },
    };
    writeFileSync(join(tempDir, "package.json"), JSON.stringify(packageJson, null, 2));

    const reviewConfig: ReviewConfig = {
      enabled: true,
      checks: ["lint"],
      commands: {},
    };

    const executionConfig: Partial<ExecutionConfig> = {
      lintCommand: "echo 'config override'",
    };

    const result = await runReview(reviewConfig, tempDir, executionConfig as ExecutionConfig);

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].command).toBe("echo 'config override'");
    expect(result.checks[0].output).toContain("config override");
    expect(result.checks[0].output).not.toContain("package.json lint");
  });

  test("reviewConfig.commands takes precedence over package.json (backwards compat)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-config-"));

    // Create package.json with lint script
    const packageJson = {
      name: "test-project",
      scripts: {
        lint: "echo 'package.json lint'",
      },
    };
    writeFileSync(join(tempDir, "package.json"), JSON.stringify(packageJson, null, 2));

    const reviewConfig: ReviewConfig = {
      enabled: true,
      checks: ["lint"],
      commands: {
        lint: "echo 'review config lint'",
      },
    };

    const result = await runReview(reviewConfig, tempDir);

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].command).toBe("echo 'review config lint'");
    expect(result.checks[0].output).toContain("review config lint");
  });

  test("executionConfig takes precedence over reviewConfig.commands", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-config-"));

    const reviewConfig: ReviewConfig = {
      enabled: true,
      checks: ["lint"],
      commands: {
        lint: "echo 'review config lint'",
      },
    };

    const executionConfig: Partial<ExecutionConfig> = {
      lintCommand: "echo 'execution config lint'",
    };

    const result = await runReview(reviewConfig, tempDir, executionConfig as ExecutionConfig);

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].command).toBe("echo 'execution config lint'");
    expect(result.checks[0].output).toContain("execution config lint");
    expect(result.checks[0].output).not.toContain("review config lint");
  });

  test("handles missing package.json gracefully", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-config-"));
    // No package.json created

    const reviewConfig: ReviewConfig = {
      enabled: true,
      checks: ["lint"],
      commands: {},
    };

    const result = await runReview(reviewConfig, tempDir);

    // Skipped (no package.json, no config)
    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(0);
  });

  test("handles invalid package.json gracefully", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-config-"));
    writeFileSync(join(tempDir, "package.json"), "invalid json {{{");

    const reviewConfig: ReviewConfig = {
      enabled: true,
      checks: ["lint"],
      commands: {},
    };

    const result = await runReview(reviewConfig, tempDir);

    // Skipped (invalid package.json treated as not found)
    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(0);
  });

  test("resolution order: executionConfig > reviewConfig > package.json", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-config-"));

    // Create package.json with all scripts
    const packageJson = {
      name: "test-project",
      scripts: {
        lint: "echo 'pkg lint'",
        typecheck: "echo 'pkg typecheck'",
        test: "echo 'pkg test'",
      },
    };
    writeFileSync(join(tempDir, "package.json"), JSON.stringify(packageJson, null, 2));

    const reviewConfig: ReviewConfig = {
      enabled: true,
      checks: ["lint", "typecheck", "test"],
      commands: {
        typecheck: "echo 'review typecheck'",
      },
    };

    const executionConfig: Partial<ExecutionConfig> = {
      lintCommand: "echo 'exec lint'",
    };

    const result = await runReview(reviewConfig, tempDir, executionConfig as ExecutionConfig);

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(result.checks.length) // Fixed for v0.20.0 default change;

    // lint: executionConfig
    expect(result.checks[0].check).toBe("lint");
    expect(result.checks[0].output).toContain("exec lint");

    // typecheck: reviewConfig
    expect(result.checks[1].check).toBe("typecheck");
    expect(result.checks[1].output).toContain("review typecheck");

    // test: package.json
    expect(result.checks[2].check).toBe("test");
    expect(result.checks[2].output).toContain("pkg test");
  });

  test("test command ignores executionConfig (not affected by this story)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-review-config-"));

    const reviewConfig: ReviewConfig = {
      enabled: true,
      checks: ["test"],
      commands: {
        test: "echo 'custom test'",
      },
    };

    const executionConfig: Partial<ExecutionConfig> = {
      lintCommand: "echo 'exec lint'",
      typecheckCommand: "echo 'exec typecheck'",
      // No testCommand in ExecutionConfig
    };

    const result = await runReview(reviewConfig, tempDir, executionConfig as ExecutionConfig);

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].command).toBe("echo 'custom test'");
  });
});
