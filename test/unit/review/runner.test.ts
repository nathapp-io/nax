/**
 * Unit tests for src/review/runner.ts
 * RQ-001: Assert clean working tree before running review typecheck/lint (BUG-049)
 *
 * Tests verify that runReview() checks for uncommitted tracked-file changes
 * (via git diff --name-only HEAD) before running typecheck or lint.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _deps, runReview } from "../../../src/review/runner";
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

      const result = await runReview(typecheckConfig, "/tmp/fake-workdir");

      expect(result.success).toBe(false);
      expect(result.failureReason).toBeDefined();
      expect(result.failureReason).toContain("src/types.ts");
      expect(result.failureReason).toContain("src/routing.ts");
    });

    test("does not run typecheck when working tree is dirty", async () => {
      _deps.getUncommittedFiles = mock(async (_workdir: string) => ["src/types.ts"]);

      // If typecheck were run it would fail (no real workdir), but we expect
      // an early return with zero checks executed.
      const result = await runReview(typecheckConfig, "/tmp/fake-workdir");

      expect(result.checks).toHaveLength(0);
    });

    test("calls getUncommittedFiles with the provided workdir", async () => {
      const mockFn = mock(async (_workdir: string) => ["src/types.ts"]);
      _deps.getUncommittedFiles = mockFn;

      await runReview(typecheckConfig, "/tmp/my-project");

      expect(mockFn).toHaveBeenCalledWith("/tmp/my-project");
    });
  });

  describe("clean working tree", () => {
    test("proceeds past dirty-tree guard when no uncommitted files", async () => {
      _deps.getUncommittedFiles = mock(async (_workdir: string) => []);

      // typecheckCommand: null disables the check so no real process is spawned.
      const result = await runReview(typecheckConfig, "/tmp/fake-workdir", {
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
      });

      expect(result.success).toBe(true);
    });

    test("calls getUncommittedFiles before running checks", async () => {
      const mockFn = mock(async (_workdir: string) => []);
      _deps.getUncommittedFiles = mockFn;

      await runReview(noChecksConfig, "/tmp/clean-workdir");

      expect(mockFn).toHaveBeenCalledWith("/tmp/clean-workdir");
    });
  });

  describe("untracked files only", () => {
    test("review proceeds when git diff HEAD returns empty (only untracked files exist)", async () => {
      // git diff --name-only HEAD only reports tracked files with changes.
      // Untracked files are invisible to this command — working tree is considered clean.
      _deps.getUncommittedFiles = mock(async (_workdir: string) => []);

      const result = await runReview(noChecksConfig, "/tmp/fake-workdir");

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

  test("nax/status.json is excluded from uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => ["nax/status.json"]);
    const result = await runReview(noChecksConfig, "/tmp/fake-workdir");
    expect(result.success).toBe(true);
  });

  test(".nax-verifier-verdict.json is excluded from uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [".nax-verifier-verdict.json"]);
    const result = await runReview(noChecksConfig, "/tmp/fake-workdir");
    expect(result.success).toBe(true);
  });

  test("nax/features/*/prd.json is excluded from uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => ["nax/features/ctx-simplify/prd.json"]);
    const result = await runReview(noChecksConfig, "/tmp/fake-workdir");
    expect(result.success).toBe(true);
  });

  test("nax/features/*/acp-sessions.json is excluded from uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => ["nax/features/cli/acp-sessions.json"]);
    const result = await runReview(noChecksConfig, "/tmp/fake-workdir");
    expect(result.success).toBe(true);
  });

  test("monorepo-prefixed acp-sessions.json is excluded (apps/cli/nax/features/*/acp-sessions.json)", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [
      "apps/cli/nax/features/cli/acp-sessions.json",
    ]);
    const result = await runReview(noChecksConfig, "/tmp/fake-workdir");
    expect(result.success).toBe(true);
  });

  test("agent source files are still caught by uncommitted check", async () => {
    _deps.getUncommittedFiles = mock(async (_workdir: string) => [
      "nax/status.json",
      "src/config/types.ts",
    ]);
    const result = await runReview(noChecksConfig, "/tmp/fake-workdir");
    expect(result.success).toBe(false);
    expect(result.failureReason).toContain("src/config/types.ts");
    expect(result.failureReason).not.toContain("nax/status.json");
  });
});
