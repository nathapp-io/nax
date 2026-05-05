/**
 * Unit tests for src/review/runner.ts
 * RQ-001: Assert clean working tree before running review typecheck/lint (BUG-049)
 *
 * Tests verify that runReview() checks for uncommitted tracked-file changes
 * (via git diff --name-only HEAD) before running typecheck or lint.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _reviewGitDeps as _deps,
  _reviewSemanticDeps as _semanticDeps,
  runReview,
} from "../../../src/review/runner";
import { _qualityRunnerDeps as _runnerDeps } from "../../../src/quality/runner";
import type { ReviewConfig } from "../../../src/review/types";

/** Minimal ReviewConfig with typecheck enabled but command set to disable via executionConfig */
const typecheckConfig: ReviewConfig = {
  enabled: true,
  checks: ["typecheck"],
  commands: {},
};

/** ReviewConfig with no checks — used to isolate the dirty-tree guard logic */
const noChecksConfig: ReviewConfig = {
  enabled: true,
  checks: [],
  commands: {},
};

/** Build check config with explicit command */
const buildConfig: ReviewConfig = {
  enabled: true,
  checks: ["build"],
  commands: { build: "echo 'build passed'" },
};

describe("runReview — dirty working tree guard (RQ-001)", () => {
  let originalGetUncommittedFiles: typeof _deps.getUncommittedFiles;

  beforeEach(() => {
    originalGetUncommittedFiles = _deps.getUncommittedFiles;
  });

  afterEach(() => {
    mock.restore();
    _deps.getUncommittedFiles = originalGetUncommittedFiles;
  });

  describe("dirty working tree", () => {
    test("returns failure with uncommitted files listed in failureReason", async () => {
      _deps.getUncommittedFiles = mock(async (_workdir: string) => [
        "src/types.ts",
        "src/routing.ts",
      ]);

      const result = await runReview({ config: typecheckConfig, workdir: "/tmp/fake-workdir" });

      expect(result.success).toBe(false);
      expect(result.failureReason).toBeDefined();
      expect(result.failureReason).toContain("src/types.ts");
      expect(result.failureReason).toContain("src/routing.ts");
    });

    test("does not run typecheck when working tree is dirty", async () => {
      _deps.getUncommittedFiles = mock(async (_workdir: string) => ["src/types.ts"]);

      // Early return with a single git-clean failed check — typecheck is never executed.
      const result = await runReview({ config: typecheckConfig, workdir: "/tmp/fake-workdir" });

      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]).toMatchObject({ check: "git-clean", success: false });
    });

    test("calls getUncommittedFiles with the provided workdir", async () => {
      const mockFn = mock(async (_workdir: string) => ["src/types.ts"]);
      _deps.getUncommittedFiles = mockFn;

      await runReview({ config: typecheckConfig, workdir: "/tmp/my-project" });

      expect(mockFn).toHaveBeenCalledWith("/tmp/my-project");
    });
  });

  describe("clean working tree", () => {
    test("proceeds past dirty-tree guard when no uncommitted files", async () => {
      _deps.getUncommittedFiles = mock(async (_workdir: string) => []);

      // typecheckCommand: null disables the check so no real process is spawned.
      const result = await runReview({
        config: typecheckConfig,
        workdir: "/tmp/fake-workdir",
        executionConfig: {
          typecheckCommand: null,
          maxIterations: 5,
          iterationDelayMs: 0,
          costLimit: 10,
          sessionTimeoutSeconds: 300,
          verificationTimeoutSeconds: 60,
          maxStoriesPerFeature: 20,
          contextProviderTokenBudget: 2000,
          rectification: { enabled: false, maxIterations: 3 },
          regressionGate: { enabled: false },
        },
      });

      expect(result.success).toBe(true);
    });

    test("calls getUncommittedFiles before running checks", async () => {
      const mockFn = mock(async (_workdir: string) => []);
      _deps.getUncommittedFiles = mockFn;

      await runReview({ config: noChecksConfig, workdir: "/tmp/clean-workdir" });

      expect(mockFn).toHaveBeenCalledWith("/tmp/clean-workdir");
    });
  });

  describe("untracked files only", () => {
    test("review proceeds when git diff HEAD returns empty (only untracked files exist)", async () => {
      // git diff --name-only HEAD only reports tracked files with changes.
      // Untracked files are invisible to this command — working tree is considered clean.
      _deps.getUncommittedFiles = mock(async (_workdir: string) => []);

      const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });

      // Should succeed — no dirty tracked files, review can proceed
      expect(result.success).toBe(true);
    });
  });
});

describe("nax runtime file exclusions", () => {
  let originalGetUncommittedFiles: typeof _deps.getUncommittedFiles;

  beforeEach(() => {
    originalGetUncommittedFiles = _deps.getUncommittedFiles;
  });

  afterEach(() => {
    mock.restore();
    _deps.getUncommittedFiles = originalGetUncommittedFiles;
  });

  test(".nax/status.json is excluded from uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [".nax/status.json"]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(true);
  });

  test(".nax-verifier-verdict.json is excluded from uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [".nax-verifier-verdict.json"]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(true);
  });

  test(".nax/features/*/prd.json is excluded from uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [".nax/features/ctx-simplify/prd.json"]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(true);
  });

  test(".nax/features/*/acp-sessions.json is excluded from uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [".nax/features/cli/acp-sessions.json"]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(true);
  });

  test("monorepo-prefixed acp-sessions.json is excluded (apps/cli/nax/features/*/acp-sessions.json)", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [
      "apps/cli/nax/features/cli/acp-sessions.json",
    ]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(true);
  });

  test(".nax/features/*/stories/*/context-manifest-*.json is excluded from uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [
      ".nax/features/memory-guardrails/stories/US-001/context-manifest-review-semantic.json",
    ]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(true);
  });

  test("monorepo-prefixed context-manifest is excluded", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [
      "apps/backend/nax/features/memory-guardrails/stories/US-001/context-manifest-verify.json",
    ]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(true);
  });

  test(".nax/features/*/stories/*/rebuild-manifest.json is excluded from uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [
      ".nax/features/memory-guardrails/stories/US-001/rebuild-manifest.json",
    ]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(true);
  });

  test("agent source files are still caught by uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [
      ".nax/status.json",
      "src/config/types.ts",
    ]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(false);
    expect(result.failureReason).toContain("src/config/types.ts");
    expect(result.failureReason).not.toContain(".nax/status.json");
  });

  test("test-output .jsonl files under test/ are excluded from uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [
      "test/unit/runtime/middleware/test-logging-sub-abc123.jsonl",
    ]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(true);
  });

  test("coverage/ directory files are excluded from uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => ["coverage/lcov.info"]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(true);
  });

  test(".lcov files are excluded from uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => ["report.lcov"]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(true);
  });

  test("test artifact mixed with real file — real file still triggers failure", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [
      "test/unit/runtime/middleware/test-logging-sub-abc123.jsonl",
      "src/real.ts",
    ]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(false);
    expect(result.checks[0]?.output).toContain("src/real.ts");
    expect(result.checks[0]?.output).not.toContain("test-logging-sub");
  });
});

describe("runReview — git-clean named check (2C)", () => {
  let originalGetUncommittedFiles: typeof _deps.getUncommittedFiles;

  beforeEach(() => {
    originalGetUncommittedFiles = _deps.getUncommittedFiles;
  });

  afterEach(() => {
    mock.restore();
    _deps.getUncommittedFiles = originalGetUncommittedFiles;
  });

  test("uncommitted changes return a named git-clean failed check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => ["src/foo.ts"]);

    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });

    expect(result.success).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      check: "git-clean",
      success: false,
      command: "git status --porcelain",
      exitCode: 1,
    });
    expect(result.checks[0]?.output).toContain("?? src/foo.ts");
  });

  test("git-clean check has no findings field (non-LLM check)", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => ["src/foo.ts"]);

    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });

    expect((result.checks[0] as any).findings).toBeUndefined();
  });
});

describe("runReview — build check (BUILD-001)", () => {
  let originalGetUncommittedFiles: typeof _deps.getUncommittedFiles;
  let originalSpawn: typeof _runnerDeps.spawn;

  beforeEach(() => {
    originalGetUncommittedFiles = _deps.getUncommittedFiles;
    originalSpawn = _runnerDeps.spawn;
  });

  afterEach(() => {
    mock.restore();
    _deps.getUncommittedFiles = originalGetUncommittedFiles;
    _runnerDeps.spawn = originalSpawn;
  });

  test("build check runs and passes when command succeeds", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => []);

    // Mock spawn to simulate successful build
    _runnerDeps.spawn = mock((_args: unknown) => {
      return {
        exited: Promise.resolve(0),
        stdout: { text: () => Promise.resolve("build output") },
        stderr: { text: () => Promise.resolve("") },
        kill: () => {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    });

    const result = await runReview({ config: buildConfig, workdir: "/tmp/fake-workdir" });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe("build");
    expect(result.checks[0].success).toBe(true);
    expect(result.checks[0].command).toBe("echo 'build passed'");
  });

  test("build check runs and fails when command fails", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => []);

    // Mock spawn to simulate failed build
    _runnerDeps.spawn = mock((_args: unknown) => {
      return {
        exited: Promise.resolve(1),
        stdout: { text: () => Promise.resolve("") },
        stderr: { text: () => Promise.resolve("Build failed") },
        kill: () => {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    });

    const result = await runReview({ config: buildConfig, workdir: "/tmp/fake-workdir" });

    expect(result.success).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe("build");
    expect(result.checks[0].success).toBe(false);
    expect(result.checks[0].exitCode).toBe(1);
  });

  test("build check is skipped when build is not in checks array", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => []);

    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(0);
  });

  test("build check is skipped when neither review.commands.build nor quality.commands.build is set (no package.json fallback)", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => []);
    let spawnCalled = false;
    _runnerDeps.spawn = mock((_args: unknown) => {
      spawnCalled = true;
      return {
        exited: Promise.resolve(0),
        stdout: { text: () => Promise.resolve("") },
        stderr: { text: () => Promise.resolve("") },
        kill: () => {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    });

    // build in checks, but no command in review.commands or quality.commands
    const configNoBuildCmd: ReviewConfig = {
      enabled: true,
      checks: ["build"],
      commands: {},
    };

    const result = await runReview({ config: configNoBuildCmd, workdir: "/tmp/fake-workdir" });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(0); // skipped — no command configured
    expect(spawnCalled).toBe(false);
  });

  test("build check uses quality.commands.build when review.commands.build not set", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => []);

    // Mock spawn to simulate successful build
    _runnerDeps.spawn = mock((_args: unknown) => {
      return {
        exited: Promise.resolve(0),
        stdout: { text: () => Promise.resolve("build output") },
        stderr: { text: () => Promise.resolve("") },
        kill: () => {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    });

    // Config with build in checks but no explicit command - should use quality.commands.build
    const configWithQualityBuild: ReviewConfig = {
      enabled: true,
      checks: ["build"],
      commands: {},
    };
    const qualityCommands = { build: "bun run build" };

    const result = await runReview({ config: configWithQualityBuild, workdir: "/tmp/fake-workdir", qualityCommands });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe("build");
    expect(result.checks[0].command).toBe("bun run build");
  });

  test("build check respects fail-fast — stops on first failure", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => []);

    // Mock spawn: first call fails, second would succeed but should not be reached
    let callCount = 0;
    _runnerDeps.spawn = mock((_args: unknown) => {
      callCount++;
      return {
        exited: Promise.resolve(1),
        stdout: { text: () => Promise.resolve("") },
        stderr: { text: () => Promise.resolve("Build failed") },
        kill: () => {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    });

    const configWithMultipleChecks: ReviewConfig = {
      enabled: true,
      checks: ["build", "lint"],
      commands: { build: "echo build", lint: "echo lint" },
    };

    const result = await runReview({ config: configWithMultipleChecks, workdir: "/tmp/fake-workdir" });

    expect(result.success).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe("build");
    expect(callCount).toBe(1); // Should only run build, not lint
  });
});

// ---------------------------------------------------------------------------
// AC-9: runReview() calls runSemanticReview() for the 'semantic' check
// ---------------------------------------------------------------------------

describe("runReview — semantic check integration (AC-9)", () => {
  let originalGetUncommittedFiles: typeof _deps.getUncommittedFiles;
  let originalRunSemanticReview: typeof _semanticDeps.runSemanticReview;
  let originalSpawn: typeof _runnerDeps.spawn;

  beforeEach(() => {
    originalGetUncommittedFiles = _deps.getUncommittedFiles;
    originalRunSemanticReview = _semanticDeps.runSemanticReview;
    originalSpawn = _runnerDeps.spawn;
  });

  afterEach(() => {
    mock.restore();
    _deps.getUncommittedFiles = originalGetUncommittedFiles;
    _semanticDeps.runSemanticReview = originalRunSemanticReview;
    _runnerDeps.spawn = originalSpawn;
  });

  const semanticConfig: ReviewConfig = {
    enabled: true,
    checks: ["semantic"],
    commands: {},
  };

  test("calls runSemanticReview() when 'semantic' is in checks list", async () => {
    _deps.getUncommittedFiles = mock(async () => []);

    const mockSemanticResult = {
      check: "semantic" as const,
      success: true,
      command: "",
      exitCode: 0,
      output: "all good",
      durationMs: 10,
    };
    _semanticDeps.runSemanticReview = mock(async () => mockSemanticResult);

    await runReview({ config: semanticConfig, workdir: "/tmp/fake-workdir" });

    expect(_semanticDeps.runSemanticReview).toHaveBeenCalled();
  });

  test("does NOT call runCheck shell spawn for 'semantic' check", async () => {
    _deps.getUncommittedFiles = mock(async () => []);

    let spawnCalled = false;
    _runnerDeps.spawn = mock((_args: unknown) => {
      spawnCalled = true;
      return {
        exited: Promise.resolve(0),
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        kill: () => {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    });

    const mockSemanticResult = {
      check: "semantic" as const,
      success: true,
      command: "",
      exitCode: 0,
      output: "semantic passed",
      durationMs: 10,
    };
    _semanticDeps.runSemanticReview = mock(async () => mockSemanticResult);

    await runReview({ config: semanticConfig, workdir: "/tmp/fake-workdir" });

    expect(spawnCalled).toBe(false);
  });

  test("includes the semantic check result in checks array", async () => {
    _deps.getUncommittedFiles = mock(async () => []);

    const mockSemanticResult = {
      check: "semantic" as const,
      success: true,
      command: "",
      exitCode: 0,
      output: "semantic passed",
      durationMs: 10,
    };
    _semanticDeps.runSemanticReview = mock(async () => mockSemanticResult);

    const result = await runReview({ config: semanticConfig, workdir: "/tmp/fake-workdir" });

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe("semantic");
  });

  test("runReview returns success=false when runSemanticReview returns success=false", async () => {
    _deps.getUncommittedFiles = mock(async () => []);

    const failingResult = {
      check: "semantic" as const,
      success: false,
      command: "",
      exitCode: 1,
      output: "semantic check found issues",
      durationMs: 10,
    };
    _semanticDeps.runSemanticReview = mock(async () => failingResult);

    const result = await runReview({ config: semanticConfig, workdir: "/tmp/fake-workdir" });

    expect(result.success).toBe(false);
  });

  test("passes storyGitRef, story, and modelResolver to runSemanticReview", async () => {
    _deps.getUncommittedFiles = mock(async () => []);

    const mockSemanticResult = {
      check: "semantic" as const,
      success: true,
      command: "",
      exitCode: 0,
      output: "passed",
      durationMs: 5,
    };
    _semanticDeps.runSemanticReview = mock(async () => mockSemanticResult);

    const story = { id: "US-001", title: "My story", description: "Does something", acceptanceCriteria: ["AC1"] };
    const mockResolver = () => null;

    await runReview({
      config: semanticConfig,
      workdir: "/tmp/fake-workdir",
      storyId: "US-001",
      storyGitRef: "abc1234",
      story,
      agentManager: mockResolver,
    });

    expect(_semanticDeps.runSemanticReview).toHaveBeenCalledWith(
      expect.objectContaining({
        workdir: "/tmp/fake-workdir",
        storyGitRef: "abc1234",
        story: expect.objectContaining({ id: "US-001" }),
      }),
    );
  });

  test("passes config.semantic to runSemanticReview when set", async () => {
    _deps.getUncommittedFiles = mock(async () => []);

    const mockSemanticResult = {
      check: "semantic" as const,
      success: true,
      command: "",
      exitCode: 0,
      output: "passed",
      durationMs: 5,
    };
    _semanticDeps.runSemanticReview = mock(async () => mockSemanticResult);

    const configWithSemantic: ReviewConfig = {
      ...semanticConfig,
      semantic: { modelTier: "powerful", rules: ["no stubs"], timeoutMs: 600_000, excludePatterns: [":!test/"], diffMode: "embedded" as const, resetRefOnRerun: false },
    };

    await runReview({ config: configWithSemantic, workdir: "/tmp/fake-workdir" });

    expect(_semanticDeps.runSemanticReview).toHaveBeenCalledWith(
      expect.objectContaining({
        workdir: "/tmp/fake-workdir",
        storyGitRef: undefined,
        story: expect.any(Object),
        semanticConfig: { modelTier: "powerful", rules: ["no stubs"], timeoutMs: 600_000, excludePatterns: [":!test/"], diffMode: "embedded", resetRefOnRerun: false },
      }),
    );
  });
});
