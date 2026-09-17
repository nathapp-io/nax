import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeConfigSlice } from "@test/helpers";
import { _scopedLintDeps, runScopedLintCheck } from "@/review/scoped-lint";
import type { ReviewConfig } from "@/review/types";

const baseReviewConfig: ReviewConfig = makeConfigSlice("review", {
  enabled: true,
  checks: ["lint"],
  commands: {
    lint: "eslint --max-warnings=0",
  },
});

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
      commandName: "lint",
      command,
      success: true,
      exitCode: 0,
      output: "ok",
      durationMs: 12,
      timedOut: false,
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
    expect(result.lintScope?.packageGroups[0]?.packageDir).toBe(".");
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
      commandName: "lint",
      command,
      success: true,
      exitCode: 0,
      output: "ok",
      durationMs: 12,
      timedOut: false,
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

  test("degraded mode filters out-of-scope diagnostics for unsupported command shape", async () => {
    _scopedLintDeps.listChangedFiles = mock(async () => ["src/in.ts"]);
    _scopedLintDeps.runLintCommand = mock(async () => ({
      commandName: "lint",
      command: "custom-lint",
      success: false,
      exitCode: 1,
      output: "src/in.ts:1:1 error in scope\nsrc/out.ts:2:2 error out scope",
      durationMs: 9,
      timedOut: false,
    }));

    const result = await runScopedLintCheck({
      resolvedLintCommand: "custom-lint",
      configCommands: baseReviewConfig.commands,
      lintOutputFormat: "auto",
      workdir: "/repo",
      storyId: "US-001",
      storyGitRef: "abc123",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("src/in.ts");
    expect(result.output).not.toContain("src/out.ts");
    expect(result.lintScope?.status).toBe("in_scope");
    expect(result.lintScope?.outOfScopeDiagnosticCount).toBe(1);
    expect(result.findings?.every((f) => f.file?.includes("src/in.ts") ?? false)).toBe(true);
  });

  test("degraded mode fails closed when lint output is unparseable", async () => {
    _scopedLintDeps.listChangedFiles = mock(async () => ["src/in.ts"]);
    _scopedLintDeps.runLintCommand = mock(async () => ({
      commandName: "lint",
      command: "custom-lint",
      success: false,
      exitCode: 1,
      output: "totally unparseable lint output",
      durationMs: 9,
      timedOut: false,
    }));

    const result = await runScopedLintCheck({
      resolvedLintCommand: "custom-lint",
      configCommands: baseReviewConfig.commands,
      lintOutputFormat: "auto",
      workdir: "/repo",
      storyId: "US-001",
      storyGitRef: "abc123",
    });

    expect(result.success).toBe(false);
    expect(result.output).toBe("totally unparseable lint output");
  });

  test("attaches findings for failing scoped lint results when output is parseable", async () => {
    _scopedLintDeps.runLintCommand = mock(async (_workdir, _storyId, _env, command) => ({
      commandName: "lint",
      command,
      success: false,
      exitCode: 1,
      output: "src/alpha.ts:10:4 Unexpected console statement",
      durationMs: 7,
      timedOut: false,
    }));

    const result = await runScopedLintCheck({
      resolvedLintCommand: "custom-lint",
      configCommands: { ...baseReviewConfig.commands, lintScoped: "custom-lint {{files}}" },
      lintOutputFormat: "text",
      qualityCommands: {},
      workdir: "/repo",
      storyId: "US-001",
      storyGitRef: "abc123",
    });

    expect(result.success).toBe(false);
    expect(result.findings?.length).toBeGreaterThan(0);
    expect(result.findings?.[0]?.file).toContain("src/alpha.ts");
  });

  // Contract pin (issue #2087): runReview's production call site
  // (src/execution/lifecycle/run-initialization.ts:95) passes only
  // { config, workdir, executionConfig } — no story, no projectDir, no
  // storyGitRef, no scope. resolveLintScope must therefore route through the
  // missing_story_git_ref arm and run the FULL lint, never the empty-scope
  // false-green at scoped-lint.ts:268-280. If a future re-wire threads
  // story/projectDir/storyGitRef into runReview, this test must fail loudly.
  test("runReview call shape: no story/projectDir/storyGitRef/scope degrades to full lint", async () => {
    const runMock = mock(async (_workdir, _storyId, _env, command) => ({
      commandName: "lint",
      command,
      success: true,
      exitCode: 0,
      output: "ok",
      durationMs: 12,
      timedOut: false,
    }));
    _scopedLintDeps.runLintCommand = runMock;

    const result = await runScopedLintCheck({
      resolvedLintCommand: "eslint --max-warnings=0",
      configCommands: baseReviewConfig.commands,
      qualityCommands: {},
      workdir: "/repo",
    });

    expect(result.lintScope?.status).toBe("degraded");
    expect(result.command).toBe("eslint --max-warnings=0");
    expect(runMock).toHaveBeenCalled();
  });
});
