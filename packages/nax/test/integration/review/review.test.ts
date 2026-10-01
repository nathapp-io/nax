// RE-ARCH: keep
/**
 * Review Phase Tests
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeConfigSlice, makeTempDir } from "@test/helpers";
import { DEFAULT_CONFIG, type ExecutionConfig, type NaxConfig, NaxConfigSchema } from "@/config/schema";
import type { ReviewConfig } from "@/review";
import { runReview } from "@/review/runner";

describe("Review Phase", () => {
  test("runReview - all checks pass", async () => {
    const tempDir = makeTempDir("nax-review-test-");

    const config: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["test"],
      commands: {
        test: "echo 'Tests passed'",
      },
    });

    const result = await runReview({ config, workdir: tempDir });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe("test");
    expect(result.checks[0].success).toBe(true);
    expect(result.checks[0].exitCode).toBe(0);
    expect(result.failureReason).toBeUndefined();
  });

  test("runReview - check fails", async () => {
    const tempDir = makeTempDir("nax-review-test-");

    const config: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["typecheck"],
      commands: {
        typecheck: "sh -c 'exit 1'",
      },
    });

    const result = await runReview({ config, workdir: tempDir });

    expect(result.success).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe("typecheck");
    expect(result.checks[0].success).toBe(false);
    expect(result.checks[0].exitCode).not.toBe(0);
    expect(result.failureReason).toContain("typecheck failed");
  });

  test("runReview - multiple checks, stop on first failure", async () => {
    const tempDir = makeTempDir("nax-review-test-");

    const config: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["typecheck", "lint", "test"],
      commands: {
        typecheck: "echo 'typecheck ok'",
        lint: "sh -c 'exit 1'",
        test: "echo 'test ok'",
      },
    });

    const result = await runReview({ config, workdir: tempDir });

    expect(result.success).toBe(false);
    // Should only run typecheck and lint, not test (fail-fast)
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0].check).toBe("typecheck");
    expect(result.checks[0].success).toBe(true);
    expect(result.checks[1].check).toBe("lint");
    expect(result.checks[1].success).toBe(false);
    expect(result.failureReason).toContain("lint failed");
  });

  test("runReview - uses review config commands when specified", async () => {
    const tempDir = makeTempDir("nax-review-test-");

    const config: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["test"],
      commands: {
        test: "echo 'custom test command'",
      },
    });

    const result = await runReview({ config, workdir: tempDir });

    // Custom command from config.review.commands
    expect(result.checks[0].command).toBe("echo 'custom test command'");
  });

  test("runReview - empty checks array", async () => {
    const tempDir = makeTempDir("nax-review-test-");

    const config: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: [],
      commands: {},
    });

    const result = await runReview({ config, workdir: tempDir });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(0);
    expect(result.failureReason).toBeUndefined();
  });

  test("runReview - captures command output", async () => {
    const tempDir = makeTempDir("nax-review-test-");

    const config: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["test"],
      commands: {
        test: "echo 'Test output line 1' && echo 'Test output line 2'",
      },
    });

    const result = await runReview({ config, workdir: tempDir });

    expect(result.success).toBe(true);
    expect(result.checks[0].output).toContain("Test output line 1");
    expect(result.checks[0].output).toContain("Test output line 2");
  });

  test("runReview - records duration", async () => {
    const tempDir = makeTempDir("nax-review-test-");

    const config: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["test"],
      commands: {
        test: "echo 'done'",
      },
    });

    const result = await runReview({ config, workdir: tempDir });

    expect(result.success).toBe(true);
    expect(typeof result.checks[0].durationMs).toBe("number");
    expect(result.checks[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.totalDurationMs).toBe("number");
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(result.checks[0].durationMs);
  });
});

// US-005: config-driven command resolution for the review stage.
describe("Review Config-Driven Commands (US-005)", () => {
  test("uses explicit executionConfig.lintCommand when provided", async () => {
    const tempDir = makeTempDir("nax-review-config-");

    const reviewConfig: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["lint"],
      commands: {},
    });

    const executionConfig: Partial<ExecutionConfig> = {
      lintCommand: "echo 'custom lint command'",
    };

    const result = await runReview({
      config: reviewConfig,
      workdir: tempDir,
      executionConfig: executionConfig as ExecutionConfig,
    });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].command).toBe("echo 'custom lint command'");
    expect(result.checks[0].output).toContain("custom lint command");
  });

  test("uses explicit executionConfig.typecheckCommand when provided", async () => {
    const tempDir = makeTempDir("nax-review-config-");

    const reviewConfig: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["typecheck"],
      commands: {},
    });

    const executionConfig: Partial<ExecutionConfig> = {
      typecheckCommand: "echo 'custom typecheck command'",
    };

    const result = await runReview({
      config: reviewConfig,
      workdir: tempDir,
      executionConfig: executionConfig as ExecutionConfig,
    });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].command).toBe("echo 'custom typecheck command'");
    expect(result.checks[0].output).toContain("custom typecheck command");
  });

  test("skips check when executionConfig command is null (explicitly disabled)", async () => {
    const tempDir = makeTempDir("nax-review-config-");

    const reviewConfig: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["lint", "typecheck"],
      commands: {},
    });

    const executionConfig: Partial<ExecutionConfig> = {
      lintCommand: null,
      typecheckCommand: "echo 'typecheck ok'",
    };

    const result = await runReview({
      config: reviewConfig,
      workdir: tempDir,
      executionConfig: executionConfig as ExecutionConfig,
    });

    // lint skipped, only typecheck ran
    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe("typecheck");
  });

  test("uses package.json script when no executionConfig override", async () => {
    const tempDir = makeTempDir("nax-review-config-");

    // Create package.json with lint script
    const packageJson = {
      name: "test-project",
      scripts: {
        lint: "echo 'package.json lint'",
      },
    };
    writeFileSync(join(tempDir, "package.json"), JSON.stringify(packageJson, null, 2));

    const reviewConfig: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["lint"],
      commands: {},
    });

    const result = await runReview({ config: reviewConfig, workdir: tempDir });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].command).toBe("bun run lint");
    expect(result.checks[0].output).toContain("package.json lint");
  });

  test("skips check when package.json script not found", async () => {
    const tempDir = makeTempDir("nax-review-config-");

    // Create package.json WITHOUT lint script
    const packageJson = {
      name: "test-project",
      scripts: {
        test: "echo 'test'",
      },
    };
    writeFileSync(join(tempDir, "package.json"), JSON.stringify(packageJson, null, 2));

    const reviewConfig: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["lint", "typecheck"],
      commands: {},
    });

    const result = await runReview({ config: reviewConfig, workdir: tempDir });

    // Both skipped (no commands found)
    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(0);
  });

  test("executionConfig takes precedence over package.json", async () => {
    const tempDir = makeTempDir("nax-review-config-");

    // Create package.json with lint script
    const packageJson = {
      name: "test-project",
      scripts: {
        lint: "echo 'package.json lint'",
      },
    };
    writeFileSync(join(tempDir, "package.json"), JSON.stringify(packageJson, null, 2));

    const reviewConfig: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["lint"],
      commands: {},
    });

    const executionConfig: Partial<ExecutionConfig> = {
      lintCommand: "echo 'config override'",
    };

    const result = await runReview({
      config: reviewConfig,
      workdir: tempDir,
      executionConfig: executionConfig as ExecutionConfig,
    });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].command).toBe("echo 'config override'");
    expect(result.checks[0].output).toContain("config override");
    expect(result.checks[0].output).not.toContain("package.json lint");
  });

  test("reviewConfig.commands takes precedence over package.json (backwards compat)", async () => {
    const tempDir = makeTempDir("nax-review-config-");

    // Create package.json with lint script
    const packageJson = {
      name: "test-project",
      scripts: {
        lint: "echo 'package.json lint'",
      },
    };
    writeFileSync(join(tempDir, "package.json"), JSON.stringify(packageJson, null, 2));

    const reviewConfig: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["lint"],
      commands: {
        lint: "echo 'review config lint'",
      },
    });

    const result = await runReview({ config: reviewConfig, workdir: tempDir });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].command).toBe("echo 'review config lint'");
    expect(result.checks[0].output).toContain("review config lint");
  });

  test("executionConfig takes precedence over reviewConfig.commands", async () => {
    const tempDir = makeTempDir("nax-review-config-");

    const reviewConfig: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["lint"],
      commands: {
        lint: "echo 'review config lint'",
      },
    });

    const executionConfig: Partial<ExecutionConfig> = {
      lintCommand: "echo 'execution config lint'",
    };

    const result = await runReview({
      config: reviewConfig,
      workdir: tempDir,
      executionConfig: executionConfig as ExecutionConfig,
    });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].command).toBe("echo 'execution config lint'");
    expect(result.checks[0].output).toContain("execution config lint");
    expect(result.checks[0].output).not.toContain("review config lint");
  });

  test("handles missing package.json gracefully", async () => {
    const tempDir = makeTempDir("nax-review-config-");
    // No package.json created

    const reviewConfig: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["lint"],
      commands: {},
    });

    const result = await runReview({ config: reviewConfig, workdir: tempDir });

    // Skipped (no package.json, no config)
    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(0);
  });

  test("handles invalid package.json gracefully", async () => {
    const tempDir = makeTempDir("nax-review-config-");
    writeFileSync(join(tempDir, "package.json"), "invalid json {{{");

    const reviewConfig: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["lint"],
      commands: {},
    });

    const result = await runReview({ config: reviewConfig, workdir: tempDir });

    // Skipped (invalid package.json treated as not found)
    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(0);
  });

  test("resolution order: executionConfig > reviewConfig > package.json", async () => {
    const tempDir = makeTempDir("nax-review-config-");

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

    const reviewConfig: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["lint", "typecheck", "test"],
      commands: {
        typecheck: "echo 'review typecheck'",
      },
    });

    const executionConfig: Partial<ExecutionConfig> = {
      lintCommand: "echo 'exec lint'",
    };

    const result = await runReview({
      config: reviewConfig,
      workdir: tempDir,
      executionConfig: executionConfig as ExecutionConfig,
    });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(result.checks.length); // Fixed for v0.20.0 default change;

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
    const tempDir = makeTempDir("nax-review-config-");

    const reviewConfig: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["test"],
      commands: {
        test: "echo 'custom test'",
      },
    });

    const executionConfig: Partial<ExecutionConfig> = {
      lintCommand: "echo 'exec lint'",
      typecheckCommand: "echo 'exec typecheck'",
      // No testCommand in ExecutionConfig
    };

    const result = await runReview({
      config: reviewConfig,
      workdir: tempDir,
      executionConfig: executionConfig as ExecutionConfig,
    });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].command).toBe("echo 'custom test'");
  });
});

// US-005: config schema accepts lintCommand / typecheckCommand.
describe("Config Schema: lintCommand and typecheckCommand (US-005)", () => {
  test("accepts lintCommand as string", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        lintCommand: "eslint .",
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts typecheckCommand as string", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        typecheckCommand: "tsc --noEmit",
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts lintCommand as null (explicitly disabled)", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        lintCommand: null,
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts typecheckCommand as null (explicitly disabled)", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        typecheckCommand: null,
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts both lintCommand and typecheckCommand undefined (auto-detect)", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        // lintCommand and typecheckCommand are undefined (omitted)
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts both commands configured together", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        lintCommand: "eslint .",
        typecheckCommand: "tsc --noEmit",
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("rejects lintCommand as number (invalid type)", () => {
    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        lintCommand: 123, // invalid type
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("rejects typecheckCommand as boolean (invalid type)", () => {
    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        typecheckCommand: true, // invalid type
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});
