/**
 * Unit tests for src/review/runner.ts
 * RQ-001: Assert clean working tree before running review typecheck/lint (BUG-049)
 *
 * Tests verify that runReview() checks for uncommitted tracked-file changes
 * (via git diff --name-only HEAD) before running typecheck or lint.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _qualityRunnerDeps as _runnerDeps } from "@/quality/runner";
import {
  _reviewGitDeps as _deps,
  _reviewLintDeps as _lintDeps,
  _reviewSemanticDeps as _semanticDeps,
  runReview,
} from "@/review/runner";
import type { ReviewConfig } from "@/review/types";
import { _gitDeps } from "@/utils/git";
import { makeConfigSlice, makeSpawn, makeSpawnResult } from "@test/helpers";

/** Minimal ReviewConfig with typecheck enabled but command set to disable via executionConfig */
const typecheckConfig: ReviewConfig = makeConfigSlice("review", {
  enabled: true,
  checks: ["typecheck"],
  commands: {},
});

/** ReviewConfig with no checks — used to isolate the dirty-tree guard logic */
const noChecksConfig: ReviewConfig = makeConfigSlice("review", {
  enabled: true,
  checks: [],
  commands: {},
});

/** Build check config with explicit command */
const buildConfig: ReviewConfig = makeConfigSlice("review", {
  enabled: true,
  checks: ["build"],
  commands: { build: "echo 'build passed'" },
});

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
    test("review proceeds without git-clean check; calls getUncommittedFiles with workdir", async () => {
      _deps.getUncommittedFiles = mock(async (_workdir: string) => ["src/types.ts", "src/routing.ts"]);
      const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
      expect(result.success).toBe(true);
      expect(result.checks.some((c) => c.check === "git-clean")).toBe(false);
      expect(result.checks).toHaveLength(0);

      const mockFn = mock(async (_workdir: string) => ["src/types.ts"]);
      _deps.getUncommittedFiles = mockFn;
      await runReview({ config: noChecksConfig, workdir: "/tmp/my-project" });
      expect(mockFn).toHaveBeenCalledWith("/tmp/my-project");
    });
  });

  describe("clean working tree", () => {
    test("proceeds when no uncommitted files; calls getUncommittedFiles with workdir", async () => {
      _deps.getUncommittedFiles = mock(async (_workdir: string) => []);
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

      const mockFn = mock(async (_workdir: string) => []);
      _deps.getUncommittedFiles = mockFn;
      await runReview({ config: noChecksConfig, workdir: "/tmp/clean-workdir" });
      expect(mockFn).toHaveBeenCalledWith("/tmp/clean-workdir");
    });
  });
});

describe("runReview — scoped lint integration", () => {
  const originalGetUncommittedFiles = _deps.getUncommittedFiles;
  const originalScopedLint = _lintDeps.runScopedLintCheck;

  afterEach(() => {
    mock.restore();
    _deps.getUncommittedFiles = originalGetUncommittedFiles;
    _lintDeps.runScopedLintCheck = originalScopedLint;
  });

  test("routes lint checks through scoped lint helper", async () => {
    _deps.getUncommittedFiles = mock(async () => []);
    const scopedLintMock = mock(async () => ({
      check: "lint" as const,
      success: true,
      command: "biome check 'src/foo.ts'",
      exitCode: 0,
      output: "ok",
      durationMs: 5,
    }));
    _lintDeps.runScopedLintCheck = scopedLintMock;

    const result = await runReview({
      config: makeConfigSlice("review", { enabled: true, checks: ["lint"], commands: { lint: "bun run lint" } }),
      workdir: "/tmp/fake-workdir",
      storyGitRef: "abc123",
      storyId: "US-001",
    });

    expect(result.success).toBe(true);
    expect(scopedLintMock).toHaveBeenCalled();
    expect(result.checks[0]?.command).toContain("biome check");
  });
});

describe("runReview — typecheck findings normalization", () => {
  const originalGetUncommittedFiles = _deps.getUncommittedFiles;
  const originalSpawn = _runnerDeps.spawn;

  afterEach(() => {
    mock.restore();
    _deps.getUncommittedFiles = originalGetUncommittedFiles;
    _runnerDeps.spawn = originalSpawn;
  });

  test("attaches structured findings when typecheck output is parseable", async () => {
    _deps.getUncommittedFiles = mock(async () => []);
    _runnerDeps.spawn = makeSpawn(() => ({
      exitCode: 1,
      stdout: "src/index.ts(10,3): error TS2304: Cannot find name 'foo'\nFound 1 error in 1 file.",
    })).spawn;

    const result = await runReview({
      config: makeConfigSlice("review", {
        enabled: true,
        checks: ["typecheck"],
        commands: { typecheck: "bun run typecheck" },
      }),
      workdir: "/tmp/fake-workdir",
    });

    expect(result.success).toBe(false);
    expect(result.checks[0]?.findings?.length).toBe(1);
    expect(result.checks[0]?.findings?.[0]?.file).toContain("src/index.ts");
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

  test.each([
    [".nax/status.json", [".nax/status.json"]],
    [".nax-verifier-verdict.json", [".nax-verifier-verdict.json"]],
    [".nax/features/*/prd.json", [".nax/features/ctx-simplify/prd.json"]],
    [".nax/features/*/acp-sessions.json", [".nax/features/cli/acp-sessions.json"]],
    ["monorepo-prefixed acp-sessions.json", ["apps/cli/nax/features/cli/acp-sessions.json"]],
    [
      ".nax/features/*/stories/*/context-manifest-*.json",
      [".nax/features/memory-guardrails/stories/US-001/context-manifest-review-semantic.json"],
    ],
    [
      "monorepo-prefixed context-manifest",
      ["apps/backend/nax/features/memory-guardrails/stories/US-001/context-manifest-verify.json"],
    ],
    [
      ".nax/features/*/stories/*/rebuild-manifest.json",
      [".nax/features/memory-guardrails/stories/US-001/rebuild-manifest.json"],
    ],
    ["test-output .jsonl files under test/", ["test/unit/runtime/middleware/test-logging-sub-abc123.jsonl"]],
    ["coverage/ directory files", ["coverage/lcov.info"]],
    [".lcov files", ["report.lcov"]],
  ] as const)("%s is excluded from uncommitted check", async (_label, files) => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [...files]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(true);
  });

  test("agent source files trigger a warning but review still proceeds", async () => {
    // Dirty agent files produce a warning; review is not failed/escalated since
    // escalation cannot fix structural commit-scope gaps in auto-commit.
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [".nax/status.json", "src/config/types.ts"]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(true);
    expect(result.checks.some((c) => c.check === "git-clean")).toBe(false);
  });

  test("test artifact mixed with real file — real file triggers warning, test artifact is excluded", async () => {
    // The nax-ignore filtering still applies: test artifacts are filtered out of
    // the warning; real agent files remain in the warning. Review proceeds either way.
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [
      "test/unit/runtime/middleware/test-logging-sub-abc123.jsonl",
      "src/real.ts",
    ]);
    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(result.success).toBe(true);
    expect(result.checks.some((c) => c.check === "git-clean")).toBe(false);
  });
});

describe("runReview — git-clean warn-and-continue (2C)", () => {
  let originalGetUncommittedFiles: typeof _deps.getUncommittedFiles;

  beforeEach(() => {
    originalGetUncommittedFiles = _deps.getUncommittedFiles;
  });

  afterEach(() => {
    mock.restore();
    _deps.getUncommittedFiles = originalGetUncommittedFiles;
  });

  test("uncommitted changes do not produce a git-clean check entry in results", async () => {
    // Dirty files are logged as a warning; no synthetic git-clean check is added
    // to result.checks so downstream consumers see only real check outcomes.
    _deps.getUncommittedFiles = mock(async (_workdir: string) => ["src/foo.ts"]);

    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });

    expect(result.success).toBe(true);
    expect(result.checks.some((c) => c.check === "git-clean")).toBe(false);
  });

  test("review succeeds with no checks configured even when dirty files exist", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => ["src/foo.ts"]);

    const result = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(0);
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

  test("build check passes when command succeeds; fails when command fails", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => []);
    _runnerDeps.spawn = makeSpawn(() => "build output").spawn;
    const pass = await runReview({ config: buildConfig, workdir: "/tmp/fake-workdir" });
    expect(pass.success).toBe(true);
    expect(pass.checks[0].check).toBe("build");
    expect(pass.checks[0].success).toBe(true);
    expect(pass.checks[0].command).toBe("echo 'build passed'");

    _runnerDeps.spawn = makeSpawn(() => ({ exitCode: 1, stderr: "Build failed" })).spawn;
    const fail = await runReview({ config: buildConfig, workdir: "/tmp/fake-workdir" });
    expect(fail.success).toBe(false);
    expect(fail.checks[0].success).toBe(false);
    expect(fail.checks[0].exitCode).toBe(1);
  });

  test("build check is skipped when not in checks array or when no build command configured", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => []);

    // Not in checks array
    const r1 = await runReview({ config: noChecksConfig, workdir: "/tmp/fake-workdir" });
    expect(r1.success).toBe(true);
    expect(r1.checks).toHaveLength(0);

    // In checks but no command
    let spawnCalled = false;
    _runnerDeps.spawn = makeSpawn(() => {
      spawnCalled = true;
      return "";
    }).spawn;
    const r2 = await runReview({
      config: makeConfigSlice("review", { enabled: true, checks: ["build"], commands: {} }),
      workdir: "/tmp/fake-workdir",
    });
    expect(r2.success).toBe(true);
    expect(r2.checks).toHaveLength(0);
    expect(spawnCalled).toBe(false);
  });

  test("build check uses quality.commands.build when review.commands.build not set", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => []);

    // Mock spawn to simulate successful build
    _runnerDeps.spawn = makeSpawn(() => "build output").spawn;

    // Config with build in checks but no explicit command - should use quality.commands.build
    const configWithQualityBuild: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["build"],
      commands: {},
    });
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
    _runnerDeps.spawn = makeSpawn(() => {
      callCount++;
      return { exitCode: 1, stderr: "Build failed" };
    }).spawn;

    const configWithMultipleChecks: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["build", "lint"],
      commands: { build: "echo build", lint: "echo lint" },
    });

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

  const semanticConfig: ReviewConfig = makeConfigSlice("review", {
    enabled: true,
    checks: ["semantic"],
    commands: {},
  });

  test("calls runSemanticReview (not spawn); result appears in checks array", async () => {
    _deps.getUncommittedFiles = mock(async () => []);
    let spawnCalled = false;
    _runnerDeps.spawn = makeSpawn(() => {
      spawnCalled = true;
      return "";
    }).spawn;
    _semanticDeps.runSemanticReview = mock(async () => ({
      check: "semantic" as const,
      success: true,
      command: "",
      exitCode: 0,
      output: "all good",
      durationMs: 10,
    }));

    const result = await runReview({ config: semanticConfig, workdir: "/tmp/fake-workdir" });

    expect(_semanticDeps.runSemanticReview).toHaveBeenCalled();
    expect(spawnCalled).toBe(false);
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

  test("passes storyGitRef+story to runSemanticReview; passes config.semantic when set", async () => {
    _deps.getUncommittedFiles = mock(async () => []);
    const mockResult = {
      check: "semantic" as const,
      success: true,
      command: "",
      exitCode: 0,
      output: "passed",
      durationMs: 5,
    };
    _semanticDeps.runSemanticReview = mock(async () => mockResult);

    const story = { id: "US-001", title: "My story", description: "Does something", acceptanceCriteria: ["AC1"] };
    await runReview({
      config: semanticConfig,
      workdir: "/tmp/fake-workdir",
      storyId: "US-001",
      storyGitRef: "abc1234",
      story,
      agentManager: (() => null) as any,
    });
    expect(_semanticDeps.runSemanticReview).toHaveBeenCalledWith(
      expect.objectContaining({
        workdir: "/tmp/fake-workdir",
        storyGitRef: "abc1234",
        story: expect.objectContaining({ id: "US-001" }),
      }),
    );

    _semanticDeps.runSemanticReview = mock(async () => mockResult);
    const configWithSemantic: ReviewConfig = {
      ...semanticConfig,
      semantic: {
        modelTier: "powerful",
        rules: ["no stubs"],
        timeoutMs: 600_000,
        excludePatterns: [":!test/"],
        diffMode: "embedded" as const,
        resetRefOnRerun: false,
      },
    };
    await runReview({ config: configWithSemantic, workdir: "/tmp/fake-workdir" });
    expect(_semanticDeps.runSemanticReview).toHaveBeenCalledWith(
      expect.objectContaining({
        workdir: "/tmp/fake-workdir",
        storyGitRef: undefined,
        semanticConfig: {
          modelTier: "powerful",
          rules: ["no stubs"],
          timeoutMs: 600_000,
          excludePatterns: [":!test/"],
          diffMode: "embedded",
          resetRefOnRerun: false,
        },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// BUG-1: getUncommittedFilesImpl must route through gitWithTimeout so that
// >64KB of `git diff --name-only HEAD` output (large diffs) cannot deadlock the
// run by filling the OS pipe buffer. The pre-fix code awaited proc.exited
// before draining stdout, which hangs indefinitely once the pipe is full.
// ---------------------------------------------------------------------------

describe("getUncommittedFilesImpl — BUG-1 pipe-drain regression", () => {
  /**
   * The SIGKILL deadline under test, shrunk from the production GIT_TIMEOUT_MS
   * (10s) so the never-closing-pipe path costs milliseconds rather than ten
   * seconds of wall-clock. The contract is unchanged: gitWithTimeout must bound
   * the call and return empty rather than deadlocking on the undrained pipe.
   */
  const TEST_GIT_TIMEOUT_MS = 50;

  let originalGetUncommittedFiles: typeof _deps.getUncommittedFiles;
  let originalSpawn: typeof _gitDeps.spawn;
  let originalTimeout: number;

  beforeEach(() => {
    // Capture the impl reference at test start — previous describe blocks mock
    // _deps.getUncommittedFiles, so we restore to the impl explicitly so this
    // suite exercises the real code path. The impl is the module-load default
    // unless a previous test leaked; the afterEach below restores whatever was
    // captured here, so this is robust to test-run order.
    originalGetUncommittedFiles = _deps.getUncommittedFiles;
    originalSpawn = _gitDeps.spawn;
    originalTimeout = _gitDeps.gitTimeoutMs;
    _gitDeps.gitTimeoutMs = TEST_GIT_TIMEOUT_MS;
  });

  afterEach(() => {
    _deps.getUncommittedFiles = originalGetUncommittedFiles;
    _gitDeps.spawn = originalSpawn;
    _gitDeps.gitTimeoutMs = originalTimeout;
    mock.restore();
  });

  test("routes git diff through _gitDeps.spawn (gitWithTimeout), not Bun.spawn", async () => {
    // Pre-fix: getUncommittedFilesImpl called Bun.spawn directly, so mocking
    // _gitDeps.spawn had no effect and the test would call the real Bun.spawn.
    // Post-fix: the impl delegates to gitWithTimeout, which uses _gitDeps.spawn,
    // and we can intercept the call here.
    const stub = makeSpawn(() => "src/foo.ts\nsrc/bar.ts\n");
    _gitDeps.spawn = stub.spawn;

    // Call whatever impl the test captured — relies on beforeEach ordering
    // (other suites' afterEach restore the impl by this point in the run).
    const result = await originalGetUncommittedFiles("/tmp/repo");

    expect(stub.calls[0]?.cmd).toEqual(["git", "diff", "--name-only", "HEAD"]);
    expect(stub.calls[0]?.opts.cwd).toBe("/tmp/repo");
    expect(stub.calls[0]?.opts.stdout).toBe("pipe");
    expect(result).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  test("returns empty array on non-zero exit (gitWithTimeout contract)", async () => {
    _gitDeps.spawn = makeSpawn(() => ({ exitCode: 1 })).spawn;

    const result = await originalGetUncommittedFiles("/tmp/repo");

    expect(result).toEqual([]);
  });

  test("returns empty array when stdout pipe never closes (BUG-1 deadlock regression)", async () => {
    // Reproduces BUG-1: a hung subprocess whose stdout never closes. Pre-fix,
    // proc.exited never resolves and the run hangs forever. Post-fix,
    // gitWithTimeout's SIGKILL timer (GIT_TIMEOUT_MS = 10s) bounds the call,
    // and concurrent pipe draining prevents the deadlock even if the process
    // is wedged writing more than 64KB.
    let resolveExited: (code: number) => void = () => {};
    let killInvoked = false;
    _gitDeps.spawn = makeSpawn(() => {
      const proc = makeSpawnResult();
      Object.defineProperty(proc, "exited", {
        value: new Promise<number>((r) => {
          resolveExited = r;
        }),
      });
      // The SIGKILL from gitWithTimeout is what settles `exited`.
      Object.defineProperty(proc, "kill", {
        value: () => {
          killInvoked = true;
          resolveExited(137);
        },
      });
      return proc;
    }).spawn;

    const start = Date.now();
    const result = await originalGetUncommittedFiles("/tmp/repo");
    const elapsed = Date.now() - start;

    // TEST_GIT_TIMEOUT_MS + slack. The call must return in finite time —
    // a hang here means the fix is broken or someone reintroduced the
    // "await proc.exited before draining stdout" pattern.
    expect(elapsed).toBeLessThan(1_000);
    expect(killInvoked).toBe(true);
    expect(result).toEqual([]);
  });
});
