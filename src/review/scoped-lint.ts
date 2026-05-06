import { join, relative } from "node:path";
import type { QualityConfig } from "../config/schema";
import { getSafeLogger } from "../logger";
import { type UserStory, getContextFiles } from "../prd";
import { type QualityCommandResult, runQualityCommand } from "../quality";
import { findPackageDir } from "../test-runners/resolver";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import { formatDiagnosticsOutput, parseLintOutput } from "./lint-parsing";
import type { LintOutputFormat } from "./lint-parsing";
import type { ReviewCheckResult, ReviewConfig } from "./types";

interface ScopedLintArgs {
  resolvedLintCommand: string;
  configCommands: ReviewConfig["commands"];
  qualityCommands?: QualityConfig["commands"];
  lintOutputFormat?: LintOutputFormat;
  workdir: string;
  projectDir?: string;
  storyId?: string;
  story?: UserStory;
  storyGitRef?: string;
  env?: Record<string, string | undefined>;
  naxIgnoreIndex?: NaxIgnoreIndex;
}

interface ScopeResult {
  files: string[];
  degradedReason?: string;
}

const SCOPED_LINT_CHECK = "lint";

function shellQuotePath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isSupportedDerivedScopedCommand(command: string): boolean {
  const trimmed = command.trim();
  const supported = ["eslint", "biome", "ruff", "flake8"];
  if (supported.some((tool) => trimmed === tool || trimmed.startsWith(`${tool} `))) return true;
  if (trimmed.startsWith("bunx ")) return supported.some((tool) => trimmed.startsWith(`bunx ${tool}`));
  return false;
}

function appendFilesToCommand(command: string, files: readonly string[]): string {
  const fileArgs = files.map(shellQuotePath).join(" ");
  return `${command} ${fileArgs}`;
}

async function listChangedFiles(workdir: string, baseRef: string): Promise<string[] | null> {
  const proc = Bun.spawn({
    cmd: ["git", "diff", "--name-only", `${baseRef}..HEAD`],
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  const output = await new Response(proc.stdout).text();
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizePath);
}

function inferActivePackageDir(workdir: string, projectDir?: string): string | undefined {
  if (!projectDir) return undefined;
  const rel = normalizePath(relative(projectDir, workdir));
  if (!rel || rel === "." || rel.startsWith("..")) return undefined;
  return rel;
}

function uniqueFiles(files: readonly string[]): string[] {
  return [...new Set(files.map(normalizePath).filter(Boolean))];
}

async function filterFilesToScope(
  files: readonly string[],
  workdir: string,
  projectDir: string | undefined,
  activePackageDir: string | undefined,
): Promise<string[]> {
  const inScope: string[] = [];
  for (const relPath of files) {
    const absPath = join(workdir, relPath);
    const exists = await _scopedLintDeps.fileExists(absPath);
    if (!exists) continue;
    if (activePackageDir && projectDir) {
      const filePackageDir = await _scopedLintDeps.findPackageDir(relPath, projectDir);
      if (filePackageDir !== activePackageDir) continue;
    }
    inScope.push(relPath);
  }
  return inScope;
}

async function resolveLintScope(args: ScopedLintArgs): Promise<ScopeResult> {
  const storyContextFiles = args.story ? getContextFiles(args.story) : [];
  if (!args.storyGitRef) {
    return {
      files: uniqueFiles(storyContextFiles),
      degradedReason: "missing_story_git_ref",
    };
  }

  const changed = await _scopedLintDeps.listChangedFiles(args.workdir, args.storyGitRef);
  if (changed === null) {
    return {
      files: uniqueFiles(storyContextFiles),
      degradedReason: "failed_to_compute_diff",
    };
  }

  const activePackageDir = inferActivePackageDir(args.workdir, args.projectDir);
  const union = uniqueFiles([...changed, ...storyContextFiles]);
  const packageScoped = await filterFilesToScope(union, args.workdir, args.projectDir, activePackageDir);
  const withIgnore = args.naxIgnoreIndex ? args.naxIgnoreIndex.filter(packageScoped, args.workdir) : packageScoped;
  return { files: uniqueFiles(withIgnore) };
}

function resolveScopedTemplate(
  reviewCommands: ReviewConfig["commands"],
  qualityCommands: QualityConfig["commands"] | undefined,
): string | undefined {
  return reviewCommands.lintScoped ?? qualityCommands?.lintScoped;
}

async function runLintCommand(
  workdir: string,
  storyId: string | undefined,
  env: Record<string, string | undefined> | undefined,
  command: string,
): Promise<QualityCommandResult> {
  return runQualityCommand({
    commandName: SCOPED_LINT_CHECK,
    command,
    workdir,
    storyId,
    env,
  });
}

function toReviewCheck(result: QualityCommandResult): ReviewCheckResult {
  return {
    check: "lint",
    command: result.command,
    success: result.success,
    exitCode: result.exitCode,
    output: result.output,
    durationMs: result.durationMs,
  };
}

export async function runScopedLintCheck(args: ScopedLintArgs): Promise<ReviewCheckResult> {
  const logger = getSafeLogger();
  const fullLintCommand = args.resolvedLintCommand;

  const scope = await resolveLintScope(args);
  const scopedTemplate = resolveScopedTemplate(args.configCommands, args.qualityCommands);
  if (scope.files.length === 0) {
    if (scope.degradedReason) {
      logger?.warn("review", "lint_scope_degraded", {
        storyId: args.storyId,
        reason: scope.degradedReason,
      });
      const fullResult = await _scopedLintDeps.runLintCommand(args.workdir, args.storyId, args.env, fullLintCommand);
      return toReviewCheck(fullResult);
    }
    logger?.info("review", "lint_scope_empty", { storyId: args.storyId });
    return {
      check: "lint",
      command: scopedTemplate ?? fullLintCommand,
      success: true,
      exitCode: 0,
      output: "lint skipped: no in-scope files",
      durationMs: 0,
    };
  }

  if (scope.degradedReason) {
    logger?.warn("review", "lint_scope_degraded", {
      storyId: args.storyId,
      reason: scope.degradedReason,
    });
  }

  if (scopedTemplate) {
    const scopedCommand = scopedTemplate.replaceAll("{{files}}", scope.files.map(shellQuotePath).join(" "));
    const scopedResult = await _scopedLintDeps.runLintCommand(args.workdir, args.storyId, args.env, scopedCommand);
    return toReviewCheck(scopedResult);
  }

  if (!scope.degradedReason && isSupportedDerivedScopedCommand(fullLintCommand)) {
    const scopedCommand = appendFilesToCommand(fullLintCommand, scope.files);
    const scopedResult = await _scopedLintDeps.runLintCommand(args.workdir, args.storyId, args.env, scopedCommand);
    return toReviewCheck(scopedResult);
  }

  // Degraded mode: run full lint then post-filter diagnostics to in-scope files.
  logger?.warn("review", "lint_scope_degraded", {
    storyId: args.storyId,
    reason: scope.degradedReason ?? "unsupported_scoped_command_shape",
  });
  const fullResult = await _scopedLintDeps.runLintCommand(args.workdir, args.storyId, args.env, fullLintCommand);
  if (fullResult.exitCode === 0) return toReviewCheck(fullResult);

  const parsed = parseLintOutput(fullResult.output, args.lintOutputFormat ?? "auto", {
    workdir: args.workdir,
  });
  if (!parsed) return toReviewCheck(fullResult);

  const scopedSet = new Set(scope.files.map(normalizePath));
  const inScopeDiagnostics = parsed.diagnostics.filter((d) => scopedSet.has(normalizePath(d.file)));
  const scopedOutput = formatDiagnosticsOutput(inScopeDiagnostics);
  if (!scopedOutput) {
    return {
      check: "lint",
      command: fullResult.command,
      success: true,
      exitCode: 0,
      output: "lint warnings/errors were out of story scope",
      durationMs: fullResult.durationMs,
    };
  }

  return {
    check: "lint",
    command: fullResult.command,
    success: false,
    exitCode: fullResult.exitCode,
    output: scopedOutput,
    durationMs: fullResult.durationMs,
  };
}

export const _scopedLintDeps = {
  listChangedFiles,
  findPackageDir,
  runLintCommand,
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
};
