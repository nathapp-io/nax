import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _scopedLintDeps, runScopedLintCheck } from "../../../src/review/scoped-lint";
import type { ReviewConfig } from "../../../src/review/types";

const baseReviewConfig: ReviewConfig = {
  enabled: true,
  checks: ["lint"],
  commands: {
    lint: "eslint --max-warnings=0",
  },
};

describe("runScopedLintCheck", () => {
  const originalListChangedFiles = _scopedLintDeps.listChangedFiles;
  const originalFindPackageDir = _scopedLintDeps.findPackageDir;
  const originalRunLintCommand = _scopedLintDeps.runLintCommand;
  const originalFileExists = _scopedLintDeps.fileExists;

  beforeEach(() => {
    _scopedLintDeps.listChangedFiles = mock(async () => ["src/alpha.ts"]);
    _scopedLintDeps.findPackageDir = mock(async () => undefined);
    _scopedLintDeps.fileExists = mock(async () => true);
    _scopedLintDeps.runLintCommand = mock(async (_workdir, _storyId, _env, command) => ({
      command,
      success: true,
      exitCode: 0,
      output: "ok",
      durationMs: 12,
    }));
  });

  afterEach(() => {
    mock.restore();
    _scopedLintDeps.listChangedFiles = originalListChangedFiles;
    _scopedLintDeps.findPackageDir = originalFindPackageDir;
    _scopedLintDeps.runLintCommand = originalRunLintCommand;
    _scopedLintDeps.fileExists = originalFileExists;
  });

  test("uses lintScoped template with {{files}} substitution", async () => {
    const result = await runScopedLintCheck({
      resolvedLintCommand: "eslint --max-warnings=0",
      configCommands: { ...baseReviewConfig.commands, lintScoped: "biome check {{files}}" },
      qualityCommands: {},
      workdir: "/repo",
      storyId: "US-001",
      storyGitRef: "abc123",
    });

    expect(result.success).toBe(true);
    expect(result.command).toBe("biome check 'src/alpha.ts'");
  });

  test("derives scoped lint command for supported tools when template is absent", async () => {
    const result = await runScopedLintCheck({
      resolvedLintCommand: "eslint --max-warnings=0",
      configCommands: baseReviewConfig.commands,
      qualityCommands: {},
      workdir: "/repo",
      storyId: "US-001",
      storyGitRef: "abc123",
    });

    expect(result.command).toBe("eslint --max-warnings=0 'src/alpha.ts'");
  });

  test("skips lint when scoped file set is empty", async () => {
    _scopedLintDeps.listChangedFiles = mock(async () => []);

    const result = await runScopedLintCheck({
      resolvedLintCommand: "eslint --max-warnings=0",
      configCommands: baseReviewConfig.commands,
      qualityCommands: {},
      workdir: "/repo",
      storyId: "US-001",
      storyGitRef: "abc123",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("no in-scope files");
  });

  test("degrades to full lint command when storyGitRef is missing", async () => {
    const result = await runScopedLintCheck({
      resolvedLintCommand: "eslint --max-warnings=0",
      configCommands: baseReviewConfig.commands,
      qualityCommands: {},
      workdir: "/repo",
      storyId: "US-001",
    });

    expect(result.command).toBe("eslint --max-warnings=0");
  });

  test("filters scope to active package in monorepo mode", async () => {
    _scopedLintDeps.listChangedFiles = mock(async () => ["packages/api/src/in.ts", "packages/web/src/out.ts"]);
    _scopedLintDeps.findPackageDir = mock(async (file) => {
      if (file.startsWith("packages/api/")) return "packages/api";
      if (file.startsWith("packages/web/")) return "packages/web";
      return undefined;
    });

    const result = await runScopedLintCheck({
      resolvedLintCommand: "eslint --max-warnings=0",
      configCommands: { ...baseReviewConfig.commands, lintScoped: "eslint {{files}}" },
      qualityCommands: {},
      workdir: "/repo/packages/api",
      projectDir: "/repo",
      storyGitRef: "abc123",
    });

    expect(result.command).toBe("eslint 'packages/api/src/in.ts'");
  });

  test("uses resolved lint command override when storyGitRef is missing and scope is empty", async () => {
    const runMock = mock(async (_workdir, _storyId, _env, command) => ({
      command,
      success: true,
      exitCode: 0,
      output: "ok",
      durationMs: 12,
    }));
    _scopedLintDeps.runLintCommand = runMock;

    const result = await runScopedLintCheck({
      resolvedLintCommand: "custom-lint --from-exec",
      configCommands: baseReviewConfig.commands,
      qualityCommands: {},
      workdir: "/repo",
      storyId: "US-001",
    });

    expect(result.command).toBe("custom-lint --from-exec");
    expect(runMock).toHaveBeenCalled();
  });
});
