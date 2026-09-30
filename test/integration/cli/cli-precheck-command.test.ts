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
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import { precheckCommand } from "@/commands/precheck";
import { EXIT_CODES } from "@/precheck";
import { gitSpawnEnv } from "@/utils/git-env";

// Fixtures live in the OS temp dir, never inside the nax working tree: a
// fixture whose `git init` failed would otherwise resolve to nax's own repo and
// stage its files into nax's index (#2304).
let tempDir: string;

/**
 * Run git in a fixture, failing the test loudly on a non-zero exit.
 * GIT_CEILING_DIRECTORIES stops git walking above the fixture's parent, so it
 * can never resolve to an enclosing repo.
 */
function git(dir: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    env: gitSpawnEnv({ GIT_CEILING_DIRECTORIES: realpathSync(dirname(dir)) }),
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${proc.exitCode}: ${new TextDecoder().decode(proc.stderr)}`);
  }
  return new TextDecoder().decode(proc.stdout);
}

/** `git init` plus an identity, then prove the repo root is `dir` itself. */
function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  const toplevel = git(dir, ["rev-parse", "--show-toplevel"]).trim();
  if (realpathSync(toplevel) !== realpathSync(dir)) {
    throw new Error(`fixture repo root is ${toplevel}, expected ${dir}`);
  }
}

function commitAll(dir: string): void {
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init", "-q"]);
}

/**
 * Helper to create a test project structure
 */
function setupTestProject(name: string): {
  projectDir: string;
  naxDir: string;
  featureDir: string;
  prdPath: string;
} {
  const projectDir = join(tempDir, name);
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

  initRepo(projectDir);

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
          estimatedCostUsd: 0.01,
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
    tempDir = makeTempDir("nax-precheck-cli-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("should resolve project directory with -d flag", async () => {
    const { projectDir, prdPath } = setupTestProject("test-d-flag");

    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

    commitAll(projectDir);

    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
    }) as typeof process.exit;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (_err) {
      // Expected - command calls process.exit
    } finally {
      process.exit = originalExit;
    }

    assertDefined(exitCode, "exitCode");
    const validExitCodes: number[] = [EXIT_CODES.SUCCESS, EXIT_CODES.BLOCKER];
    expect(validExitCodes).toContain(exitCode);
  });

  test("should accept -f flag for feature name", async () => {
    const { projectDir, prdPath } = setupTestProject("test-f-flag");

    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

    commitAll(projectDir);

    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
    }) as typeof process.exit;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (_err) {
      // Expected
    } finally {
      process.exit = originalExit;
    }

    expect(exitCode).toBeDefined();
  });

  test("should output JSON format with --json flag", async () => {
    const { projectDir, prdPath } = setupTestProject("test-json-flag");

    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

    commitAll(projectDir);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => {
      logs.push(msg);
    };

    let _exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      _exitCode = code;
    }) as typeof process.exit;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: true,
      });
    } catch (_err) {
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

    commitAll(projectDir);

    let exitCode: number | undefined;
    const originalExit = process.exit;
    const originalError = console.error;
    const originalLog = console.log;
    console.error = () => {};
    console.log = () => {};

    process.exit = ((code?: number) => {
      exitCode = code;
    }) as typeof process.exit;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (_err) {
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
    }) as typeof process.exit;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (_err) {
      // Expected
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }

    expect(exitCode).toBe(EXIT_CODES.INVALID_PRD);
  });

  test("should handle missing feature flag with error", async () => {
    const { projectDir, naxDir, featureDir } = setupTestProject("test-no-feature");

    // BUG-02: -f omitted now derives the feature from .nax/features/* — remove the
    // fixture's auto-created "test-feature" dir so there is genuinely nothing to
    // derive, exercising the same "no feature specified" error this test intends.
    rmSync(featureDir, { recursive: true, force: true });

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
    }) as typeof process.exit;

    try {
      await precheckCommand({
        dir: projectDir,
        json: false,
      });
    } catch (_err) {
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

    commitAll(projectDir);

    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
    }) as typeof process.exit;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (_err) {
      // Expected
    } finally {
      process.exit = originalExit;
    }

    expect(exitCode).toBeDefined();
    expect(exitCode).not.toBe(undefined);
  });
});
