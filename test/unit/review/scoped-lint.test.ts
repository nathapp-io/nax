import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeConfigSlice, makeSpawn } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { _reconcileDeps } from "@/execution/lifecycle/run-initialization";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { _reviewGitDeps } from "@/review/runner";
import { _scopedLintDeps, runScopedLintCheck } from "@/review/scoped-lint";
import type { ReviewConfig } from "@/review/types";
import { _gitDeps } from "@/utils/git";

const baseReviewConfig: ReviewConfig = makeConfigSlice("review", {
  enabled: true,
  checks: ["lint"],
  commands: {
    lint: "eslint --max-warnings=0",
  },
});

// Captured before any test replaces `_scopedLintDeps.listChangedFiles`, so the
// argv-retention test below exercises the real implementation.
const realListChangedFiles = _scopedLintDeps.listChangedFiles;

// scoped-lint is the ONE collector that intentionally RETAINS `--relative` — a
// ruled exemption from diff-utils' no-`--relative` consolidation. Its live
// consumer, filterFilesToScope(), does `join(workdir, relPath)` and therefore
// needs package-relative paths. Unlike diff-utils' collectors (which only
// compare/report the pathspec, never re-join it onto `workdir`), dropping the
// flag here would double-prefix every path and silently skip all lint (BUG-31).
describe("listChangedFiles() --relative retention (scoped-lint exemption)", () => {
  let originalSpawn: typeof _gitDeps.spawn;

  beforeEach(() => {
    originalSpawn = _gitDeps.spawn;
  });

  afterEach(() => {
    _gitDeps.spawn = originalSpawn;
  });

  test("keeps --relative because filterFilesToScope joins relPath onto workdir", async () => {
    const stub = makeSpawn(() => "src/a.ts\n");
    _gitDeps.spawn = stub.spawn;

    const files = await realListChangedFiles("/repo/packages/api", "abc123");

    expect(stub.calls[0]?.cmd).toContain("--relative");
    expect(stub.calls[0]?.cmd).toEqual(["git", "diff", "--relative", "--name-only", "abc123..HEAD"]);
    expect(files).toEqual(["src/a.ts"]);
  });
});

/**
 * Run `fn` with a fresh silent logger and collect every redacted warn entry it
 * emits. `scoped-lint.ts` reports the resolved scope arm only through
 * `lint_scope_degraded` logs (the `degradedReason` is not carried on the
 * `ReviewCheckResult`), so this is the seam that exposes the specific arm.
 */
async function captureWarns<T>(fn: () => Promise<T>): Promise<{ result: T; warns: LogEntry[] }> {
  resetLogger();
  initLogger({ level: "silent", suppressConsole: true });
  const warns: LogEntry[] = [];
  const unsubscribe = addSink((entry) => {
    if (entry.level === "warn") warns.push(entry);
  });
  try {
    const result = await fn();
    return { result, warns };
  } finally {
    unsubscribe();
    resetLogger();
  }
}

describe("runScopedLintCheck", () => {
  const originalListChangedFiles = _scopedLintDeps.listChangedFiles;
  const originalFindPackageDir = _scopedLintDeps.findPackageDir;
  const originalRunLintCommand = _scopedLintDeps.runLintCommand;
  const originalFileExists = _scopedLintDeps.fileExists;
  const originalGetUncommittedFiles = _reviewGitDeps.getUncommittedFiles;

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
    _reviewGitDeps.getUncommittedFiles = originalGetUncommittedFiles;
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

  // Restored from #2102 — deleting the runAutofixLint shim took the only
  // out_of_scope coverage with it. The shim was a pure forward to
  // runScopedLintCheck, so the same arguments are retargeted here directly.
  test("dogfood replay shape: sibling-package lint debt is reported as out_of_scope", async () => {
    _scopedLintDeps.runLintCommand = mock(async () => ({
      commandName: "lint",
      command: "custom-lint",
      success: false,
      exitCode: 1,
      output: "packages/web/src/sibling.ts:3:1 error sibling debt",
      durationMs: 9,
      timedOut: false,
    }));

    const result = await runScopedLintCheck({
      resolvedLintCommand: "custom-lint",
      configCommands: baseReviewConfig.commands,
      lintOutputFormat: "auto",
      workdir: "/repo",
      storyId: "US-001",
      scope: {
        changedFiles: ["packages/api/src/in.ts"],
        contextFiles: [],
        packageDir: "packages/api",
      },
    });

    expect(result.success).toBe(true);
    expect(result.lintScope?.status).toBe("out_of_scope");
    expect(result.lintScope?.packageGroups).toEqual([
      { packageDir: "packages/api", files: ["packages/api/src/in.ts"] },
    ]);
    expect(result.output).toContain("out of story scope");
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

  // Contract pin (issue #2087 / post-merge finding H3): runReview's production
  // call site is the `_reconcileDeps.runReview` adapter in
  // src/execution/lifecycle/run-initialization.ts:36-37, which forwards only
  // { config, workdir, executionConfig } — no story, no projectDir, no
  // storyGitRef, no scope. resolveLintScope must therefore route through the
  // missing_story_git_ref arm and run the FULL lint, never the empty-scope
  // false-green at scoped-lint.ts:268-280. If a future re-wire threads story,
  // projectDir, storyGitRef or scope into that call site, this test must fail
  // loudly — it invokes the production adapter rather than re-stating its
  // argument shape, so the re-wire reaches the assertions.
  test("runReview production call shape: no story/projectDir/storyGitRef/scope takes the missing_story_git_ref arm and runs full lint", async () => {
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
    _reviewGitDeps.getUncommittedFiles = mock(async () => []);

    const { result, warns } = await captureWarns(() =>
      _reconcileDeps.runReview(baseReviewConfig, "/repo", DEFAULT_CONFIG.execution),
    );

    expect(warns.find((entry) => entry.message === "lint_scope_degraded")?.data?.reason).toBe("missing_story_git_ref");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.lintScope?.status).toBe("degraded");
    expect(result.checks[0]?.command).toBe("eslint --max-warnings=0");
    expect(runMock).toHaveBeenCalledWith("/repo", undefined, undefined, "eslint --max-warnings=0", []);
  });
});
