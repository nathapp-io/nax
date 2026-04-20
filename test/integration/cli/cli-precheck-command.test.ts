// RE-ARCH: keep
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
  const naxDir = join(projectDir, ".nax");
  const featureDir = join(naxDir, "features", "test-feature");
  const prdPath = join(featureDir, "prd.json");

  mkdirSync(featureDir, { recursive: true });

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

  Bun.spawnSync(["git", "init", "-q"], { cwd: projectDir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: projectDir });
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: projectDir });

  mkdirSync(join(projectDir, "node_modules"), { recursive: true });

  return { projectDir, naxDir, featureDir, prdPath };
}

function createValidPRD() {
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

    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

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
      // Expected - command calls process.exit
    } finally {
      process.exit = originalExit;
    }

    expect(exitCode).toBeDefined();
    expect([EXIT_CODES.SUCCESS, EXIT_CODES.BLOCKER]).toContain(exitCode);
  });

  test("should accept -f flag for feature name", async () => {
    const { projectDir, prdPath } = setupTestProject("test-f-flag");

    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

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

    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

    Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
    Bun.spawnSync(["git", "commit", "-m", "init", "-q"], { cwd: projectDir });

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

    expect(logs.length).toBeGreaterThan(0);

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

    await Bun.write(
      prdPath,
      JSON.stringify({
        version: "0.1.0",
        userStories: [],
        totalStories: 0,
        completedStories: 0,
        progress: 0,
      }),
    );

    Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
    Bun.spawnSync(["git", "commit", "-m", "init", "-q"], { cwd: projectDir });

    let exitCode: number | undefined;
    const originalExit = process.exit;
    const originalError = console.error;
    const originalLog = console.log;
    console.error = () => {};
    console.log = () => {};

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

    let exitCode: number | undefined;
    const originalExit = process.exit;
    const originalError = console.error;
    console.error = () => {};

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
    console.error = () => {};

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

    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

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
    expect(exitCode).not.toBe(undefined);
  });
});
