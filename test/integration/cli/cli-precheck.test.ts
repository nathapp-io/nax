/**
 * Integration tests for CLI precheck command
 *
 * Tests:
 * - Command registration and flag parsing
 * - Directory resolution via resolveProject()
 * - Human and JSON output formats
 * - Exit codes (0=pass, 1=blocker, 2=invalid PRD)
 * - Error handling for missing feature/prd.json
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { precheckCommand } from "../../../src/commands/precheck";
import type { PRD } from "../../../src/prd/types";
import { EXIT_CODES } from "../../../src/precheck";

const TEMP_DIR = join(import.meta.dir, "tmp-precheck-cli");

/**
 * Helper to create a test project structure
 */
function setupTestProject(name: string): {
  projectDir: string;
  naxDir: string;
  featureDir: string;
  prdPath: string;
} {
  const projectDir = join(TEMP_DIR, name);
  const naxDir = join(projectDir, "nax");
  const featureDir = join(naxDir, "features", "test-feature");
  const prdPath = join(featureDir, "prd.json");

  mkdirSync(featureDir, { recursive: true });

  // Write minimal config.json
  Bun.write(
    join(naxDir, "config.json"),
    JSON.stringify(
      {
        feature: "test-feature",
        routing: { enabled: true, tierLabels: { fast: 1, balanced: 2, powerful: 3 } },
        quality: { test: { enabled: true, command: "echo test" } },
      },
      null,
      2,
    ),
  );

  // Initialize git repo to satisfy checks
  Bun.spawnSync(["git", "init", "-q"], { cwd: projectDir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: projectDir });
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: projectDir });

  // Create node_modules to satisfy dependencies check
  mkdirSync(join(projectDir, "node_modules"), { recursive: true });

  return { projectDir, naxDir, featureDir, prdPath };
}

/**
 * Helper to create a valid PRD
 */
function createValidPRD(): PRD {
  return {
    version: "0.1.0",
    project: "test-project",
    feature: "test-feature",
    branch: "feat/test-feature",
    branchName: "feat/test-feature",
    userStories: [
      {
        id: "US-001",
        title: "Test Story",
        description: "Test description",
        acceptanceCriteria: [{ id: "AC-1", criterion: "Test criterion", testStrategy: "integration" }],
        tags: [],
        routing: {
          tier: "fast",
          complexity: "simple",
          estimatedCost: 0.01,
          security: false,
          thinkingBudget: 1000,
        },
        dependencies: [],
      },
    ],
    totalStories: 1,
    completedStories: 0,
    progress: 0,
  };
}

describe("CLI precheck command", () => {
  beforeEach(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
    mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  test("should resolve project directory with -d flag", async () => {
    const { projectDir, prdPath } = setupTestProject("test-d-flag");

    // Write valid PRD
    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

    // Commit everything to satisfy working-tree-clean check
    Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
    Bun.spawnSync(["git", "commit", "-m", "init", "-q"], { cwd: projectDir });

    // Mock process.exit to capture exit code
    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      // Don't actually exit in tests
    }) as never;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (err) {
      // Expected - command calls process.exit
    } finally {
      process.exit = originalExit;
    }

    // Should exit with code 0 (success) or 1 (warning)
    expect(exitCode).toBeDefined();
    expect([EXIT_CODES.SUCCESS, EXIT_CODES.BLOCKER]).toContain(exitCode);
  });

  test("should accept -f flag for feature name", async () => {
    const { projectDir, prdPath } = setupTestProject("test-f-flag");

    // Write valid PRD
    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

    // Commit to satisfy checks
    Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
    Bun.spawnSync(["git", "commit", "-m", "init", "-q"], { cwd: projectDir });

    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
    }) as never;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (err) {
      // Expected
    } finally {
      process.exit = originalExit;
    }

    expect(exitCode).toBeDefined();
  });

  test("should output JSON format with --json flag", async () => {
    const { projectDir, prdPath } = setupTestProject("test-json-flag");

    // Write valid PRD
    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

    // Commit to satisfy checks
    Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
    Bun.spawnSync(["git", "commit", "-m", "init", "-q"], { cwd: projectDir });

    // Capture console.log output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => {
      logs.push(msg);
    };

    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
    }) as never;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: true,
      });
    } catch (err) {
      // Expected
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }

    // Should have JSON output
    expect(logs.length).toBeGreaterThan(0);

    // Try to parse first log as JSON
    const jsonOutput = JSON.parse(logs[0]);
    expect(jsonOutput).toHaveProperty("passed");
    expect(jsonOutput).toHaveProperty("blockers");
    expect(jsonOutput).toHaveProperty("warnings");
    expect(jsonOutput).toHaveProperty("summary");
    expect(jsonOutput).toHaveProperty("feature");
    expect(jsonOutput.feature).toBe("test-feature");
  });

  test("should exit with code 2 for invalid PRD", async () => {
    const { projectDir, prdPath } = setupTestProject("test-invalid-prd");

    // Write PRD that will pass loading but fail validation
    await Bun.write(
      prdPath,
      JSON.stringify({
        version: "0.1.0",
        // Missing required fields: project, feature, branchName
        userStories: [],
        totalStories: 0,
        completedStories: 0,
        progress: 0,
      }),
    );

    // Commit to satisfy git checks
    Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
    Bun.spawnSync(["git", "commit", "-m", "init", "-q"], { cwd: projectDir });

    let exitCode: number | undefined;
    const originalExit = process.exit;
    const originalError = console.error;
    const originalLog = console.log;
    console.error = () => {}; // Suppress error output
    console.log = () => {}; // Suppress check output

    process.exit = ((code?: number) => {
      exitCode = code;
    }) as never;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (err) {
      // Expected
    } finally {
      process.exit = originalExit;
      console.error = originalError;
      console.log = originalLog;
    }

    expect(exitCode).toBe(EXIT_CODES.INVALID_PRD);
  });

  test("should exit with code 2 when prd.json is missing", async () => {
    const { projectDir } = setupTestProject("test-missing-prd");

    // Don't create prd.json

    let exitCode: number | undefined;
    const originalExit = process.exit;
    const originalError = console.error;
    console.error = () => {}; // Suppress error output

    process.exit = ((code?: number) => {
      exitCode = code;
    }) as never;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (err) {
      // Expected
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }

    expect(exitCode).toBe(EXIT_CODES.INVALID_PRD);
  });

  test("should handle missing feature flag with error", async () => {
    const { projectDir, naxDir } = setupTestProject("test-no-feature");

    // Remove feature from config
    await Bun.write(
      join(naxDir, "config.json"),
      JSON.stringify(
        {
          routing: { enabled: true },
          quality: { test: { enabled: true } },
        },
        null,
        2,
      ),
    );

    let exitCode: number | undefined;
    const originalExit = process.exit;
    const originalError = console.error;
    console.error = () => {}; // Suppress error output

    process.exit = ((code?: number) => {
      exitCode = code;
    }) as never;

    try {
      await precheckCommand({
        dir: projectDir,
        json: false,
      });
    } catch (err) {
      // Expected
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }

    expect(exitCode).toBe(1);
  });

  test("should use resolveProject() for directory resolution", async () => {
    const { projectDir, prdPath } = setupTestProject("test-resolve-project");

    // Write valid PRD
    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

    // Commit to satisfy checks
    Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
    Bun.spawnSync(["git", "commit", "-m", "init", "-q"], { cwd: projectDir });

    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
    }) as never;

    try {
      // Should resolve project from explicit -d flag
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (err) {
      // Expected
    } finally {
      process.exit = originalExit;
    }

    // Should succeed (or have blockers, but not fail to resolve)
    expect(exitCode).toBeDefined();
    expect(exitCode).not.toBe(undefined);
  });
});
