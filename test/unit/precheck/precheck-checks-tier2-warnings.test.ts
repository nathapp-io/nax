// RE-ARCH: keep
/**
 * Tests for src/precheck/checks.ts — Tier 2 Warning checks
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeNaxConfig, makeTempDir } from "@test/helpers";
import type { ExecutionConfig, NaxConfig } from "@/config";
import type { PRD, UserStory } from "@/prd/types";
import {
  checkClaudeMdExists,
  checkDiskSpace,
  checkGitignoreCoversNax,
  checkLintCommand,
  checkOptionalCommands,
  checkPendingStories,
  checkTestCommand,
  checkTypecheckCommand,
} from "@/precheck";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const createMockConfig = (overrides: Partial<ExecutionConfig> = {}): NaxConfig =>
  makeNaxConfig({ execution: overrides });

const createMockStory = (overrides: Partial<UserStory> = {}): UserStory => ({
  id: "US-001",
  title: "Test story",
  description: "Test description",
  acceptanceCriteria: ["AC1"],
  tags: [],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
  ...overrides,
});

const createMockPRD = (stories: UserStory[] = []): PRD => ({
  project: "test-project",
  feature: "test-feature",
  branchName: "test-branch",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  userStories: stories.length > 0 ? stories : [createMockStory()],
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 Warnings — command checks
// ─────────────────────────────────────────────────────────────────────────────

describe("checkTestCommand (Tier 2 warning)", () => {
  test("passes and reflects command in message when test command is configured", async () => {
    const result = await checkTestCommand(createMockConfig({ testCommand: "custom-test-cmd" }));
    expect(result.name).toBe("test-command-works");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("custom-test-cmd");
  });

  test.each([null, undefined])("skips silently when test command is %s", async (testCommand) => {
    const config = createMockConfig({ testCommand });
    const result = await checkTestCommand(config);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("default");
  });
});

describe("checkLintCommand (Tier 2 warning)", () => {
  test("passes and reflects command in message when lint command is configured", async () => {
    const result = await checkLintCommand(createMockConfig({ lintCommand: "custom-lint-cmd" }));
    expect(result.name).toBe("lint-command-works");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("custom-lint-cmd");
  });

  test.each([null, undefined])("skips silently when lint command is %s", async (lintCommand) => {
    const config = createMockConfig({ lintCommand });
    const result = await checkLintCommand(config);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("skip");
  });
});

describe("checkTypecheckCommand (Tier 2 warning)", () => {
  test("passes and reflects command in message when typecheck command is configured", async () => {
    const result = await checkTypecheckCommand(createMockConfig({ typecheckCommand: "tsc --noEmit" }));
    expect(result.name).toBe("typecheck-command-works");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("tsc");
  });

  test.each([null, undefined])("skips silently when typecheck command is %s", async (typecheckCommand) => {
    const config = createMockConfig({ typecheckCommand });
    const result = await checkTypecheckCommand(config);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("skip");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 Warnings — environment checks
// ─────────────────────────────────────────────────────────────────────────────

describe("checkClaudeMdExists (Tier 2 warning)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("passes when CLAUDE.md exists; fails when it does not exist", async () => {
    let result = await checkClaudeMdExists(testDir);
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("not found");

    writeFileSync(join(testDir, "CLAUDE.md"), "# Project instructions");
    result = await checkClaudeMdExists(testDir);
    expect(result.name).toBe("claude-md-exists");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("CLAUDE.md");
  });
});

describe("checkDiskSpace (Tier 2 warning)", () => {
  test("returns warning check with name, tier, and message; contains 1GB when below threshold", async () => {
    const result = await checkDiskSpace();
    expect(result.name).toBe("disk-space-sufficient");
    expect(result.tier).toBe("warning");
    if (!result.passed) expect(result.message).toContain("1GB");
    expect(typeof result.message).toBe("string");
  });
});

describe("checkPendingStories (Tier 2 warning)", () => {
  test("passes when pending or in-progress stories exist; counts both as actionable", async () => {
    expect(
      (
        await checkPendingStories(
          createMockPRD([createMockStory({ status: "pending" }), createMockStory({ status: "pending" })]),
        )
      ).passed,
    ).toBe(true);
    const result = await checkPendingStories(
      createMockPRD([
        createMockStory({ status: "pending" }),
        createMockStory({ status: "in-progress" }),
        createMockStory({ status: "passed" }),
      ]),
    );
    expect(result.name).toBe("has-pending-stories");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(true);
  });

  test("warns when all stories are passed", async () => {
    const prd = createMockPRD([createMockStory({ status: "passed" }), createMockStory({ status: "passed" })]);

    const result = await checkPendingStories(prd);

    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("no pending");
  });
});

describe("checkOptionalCommands (Tier 2 warning)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("warns and lists missing commands when optional commands are absent", async () => {
    let result = await checkOptionalCommands(
      createMockConfig({ testCommand: null, lintCommand: null, typecheckCommand: null }),
      testDir,
    );
    expect(result.name).toBe("optional-commands-configured");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(false);

    result = await checkOptionalCommands(
      createMockConfig({ testCommand: "bun test", lintCommand: null, typecheckCommand: null }),
      testDir,
    );
    expect(result.message).toContain("lint");
    expect(result.message).toContain("typecheck");
  });

  test("passes when all optional commands are configured", async () => {
    const result = await checkOptionalCommands(
      createMockConfig({ testCommand: "bun test", lintCommand: "bun run lint", typecheckCommand: "bun run typecheck" }),
      testDir,
    );
    expect(result.passed).toBe(true);
  });
});

describe("checkGitignoreCoversNax (Tier 2 warning)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("passes when .gitignore exists and covers nax runtime files", async () => {
    writeFileSync(
      join(testDir, ".gitignore"),
      `
node_modules/
nax.lock
.nax/**/runs/
.nax/metrics.json
.nax/features/*/status.json
.nax-pids
.nax-wt/
**/.nax-acceptance*
**/_nax_acceptance_test.py
**/_nax_suggested_test.py
**/.nax/features/*/fragments/
`.trim(),
    );

    const result = await checkGitignoreCoversNax(testDir);

    expect(result.name).toBe("gitignore-covers-nax");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(true);
  });

  test("fails when .gitignore is absent or missing any required nax pattern", async () => {
    // No .gitignore
    let result = await checkGitignoreCoversNax(testDir);
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(false);
    expect(result.message).toContain(".gitignore");

    // Missing nax.lock
    writeFileSync(join(testDir, ".gitignore"), "node_modules/");
    result = await checkGitignoreCoversNax(testDir);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("nax.lock");

    // Missing runs dirs
    writeFileSync(
      join(testDir, ".gitignore"),
      "nax.lock\nnax/metrics.json\nnax/features/*/status.json\n.nax-pids\n.nax-wt/",
    );
    result = await checkGitignoreCoversNax(testDir);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("runs");

    // Missing .nax-pids
    writeFileSync(
      join(testDir, ".gitignore"),
      "nax.lock\nnax/**/runs/\nnax/metrics.json\nnax/features/*/status.json\n.nax-wt/",
    );
    result = await checkGitignoreCoversNax(testDir);
    expect(result.passed).toBe(false);
    expect(result.message).toContain(".nax-pids");
  });
});
