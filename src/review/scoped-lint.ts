import { join, relative } from "node:path";
import type { QualityConfig } from "../config/schema";
import { getSafeLogger } from "../logger";
import { getContextFiles, type UserStory } from "../prd";
import { type QualityCommandResult, runQualityCommand } from "../quality";
import { findPackageDir } from "../test-runners/resolver";
import { gitWithTimeout } from "../utils/git";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import { shellQuoteArg } from "../verification/shell-quote";
import type { LintOutputFormat } from "./lint-parsing";
import { formatDiagnosticsOutput, parseLintOutput } from "./lint-parsing";
import type { ReviewCheckResult, ReviewConfig } from "./types";

export interface AutofixLintScope {
  changedFiles: string[];
  contextFiles: string[];
  packageDir: string;
}

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
  /** Secret env var names to strip before spawning the lint command. */
  stripEnvVars?: string[];
  naxIgnoreIndex?: NaxIgnoreIndex;
  scope?: AutofixLintScope;
}

interface ScopeResult {
  files: string[];
  packageGroups: Array<{ packageDir: string; files: string[] }>;
  degradedReason?: string;
}

const SCOPED_LINT_CHECK = "lint";

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
  const fileArgs = files.map(shellQuoteArg).join(" ");
  return `${command} ${fileArgs}`;
}

async function listChangedFiles(workdir: string, baseRef: string): Promise<string[] | null> {
  // BUG-31: route through gitWithTimeout so a wedged git (NFS / lock
  // contention) cannot stall the review's lint scope enumeration.
  const { stdout, exitCode } = await gitWithTimeout(
    [
      // --relative: git emits paths relative to the repo root by default, even when run
      // from a subdirectory. In a monorepo `workdir` is the package dir, and
      // filterFilesToScope() below does `join(workdir, relPath)` — without --relative
      // that double-prefixes every path (e.g. packages/api/packages/api/src/foo.ts),
      // so every file fails the existence check and the scope comes back empty — a
      // false-green "lint skipped" with zero lint actually run (BUG-31).
      "diff",
      "--relative",
      "--name-only",
      `${baseRef}..HEAD`,
    ],
    workdir,
  );
  if (exitCode !== 0) return null;
  return stdout
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
  const storyContextFiles = args.scope?.contextFiles ?? (args.story ? getContextFiles(args.story) : []);
  const explicitChangedFiles = args.scope?.changedFiles;
  const explicitPackageDir = args.scope?.packageDir ?? ".";

  if (explicitChangedFiles) {
    const union = uniqueFiles([...explicitChangedFiles, ...storyContextFiles]);
    const packageScoped = await filterFilesToScope(
      union,
      args.workdir,
      args.projectDir,
      explicitPackageDir ?? inferActivePackageDir(args.workdir, args.projectDir),
    );
    const withIgnore = args.naxIgnoreIndex ? args.naxIgnoreIndex.filter(packageScoped, args.workdir) : packageScoped;
    const files = uniqueFiles(withIgnore);
    return {
      files,
      packageGroups: [{ packageDir: explicitPackageDir, files }],
    };
  }

  if (!args.storyGitRef) {
    const files = uniqueFiles(storyContextFiles);
    return {
      files,
      packageGroups: [{ packageDir: inferActivePackageDir(args.workdir, args.projectDir) ?? ".", files }],
      degradedReason: "missing_story_git_ref",
    };
  }

  const changed = await _scopedLintDeps.listChangedFiles(args.workdir, args.storyGitRef);
  if (changed === null) {
    const files = uniqueFiles(storyContextFiles);
    return {
      files,
      packageGroups: [{ packageDir: inferActivePackageDir(args.workdir, args.projectDir) ?? ".", files }],
      degradedReason: "failed_to_compute_diff",
    };
  }

  const activePackageDir = inferActivePackageDir(args.workdir, args.projectDir);
  const union = uniqueFiles([...changed, ...storyContextFiles]);
  const packageScoped = await filterFilesToScope(union, args.workdir, args.projectDir, activePackageDir);
  const withIgnore = args.naxIgnoreIndex ? args.naxIgnoreIndex.filter(packageScoped, args.workdir) : packageScoped;
  const files = uniqueFiles(withIgnore);
  return {
    files,
    packageGroups: [{ packageDir: activePackageDir ?? ".", files }],
  };
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
  stripEnvVars?: string[],
): Promise<QualityCommandResult> {
  return runQualityCommand({
    commandName: SCOPED_LINT_CHECK,
    command,
    workdir,
    storyId,
    env,
    stripEnvVars,
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

function attachLintFindings(
  result: ReviewCheckResult,
  lintOutputFormat: LintOutputFormat | undefined,
  workdir: string,
): ReviewCheckResult {
  if (result.success) return result;
  const parsed = parseLintOutput(result.output, lintOutputFormat ?? "auto", { workdir });
  if (!parsed?.findings || parsed.findings.length === 0) return result;
  return { ...result, findings: parsed.findings };
}

function withLintScope(
  result: ReviewCheckResult,
  scope: ScopeResult,
  status: "in_scope" | "out_of_scope" | "degraded" = "in_scope",
): ReviewCheckResult {
  return {
    ...result,
    lintScope: {
      status,
      packageGroups: scope.packageGroups,
    },
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
      const fullResult = await _scopedLintDeps.runLintCommand(
        args.workdir,
        args.storyId,
        args.env,
        fullLintCommand,
        args.stripEnvVars,
      );
      return withLintScope(
        attachLintFindings(toReviewCheck(fullResult), args.lintOutputFormat, args.workdir),
        scope,
        "degraded",
      );
    }
    logger?.info("review", "lint_scope_empty", { storyId: args.storyId });
    return {
      check: "lint",
      command: scopedTemplate ?? fullLintCommand,
      success: true,
      exitCode: 0,
      output: "lint skipped: no in-scope files",
      durationMs: 0,
      lintScope: {
        status: scope.degradedReason ? "degraded" : "in_scope",
        packageGroups: scope.packageGroups,
      },
    };
  }

  if (scope.degradedReason) {
    logger?.warn("review", "lint_scope_degraded", {
      storyId: args.storyId,
      reason: scope.degradedReason,
    });
  }

  if (scopedTemplate) {
    const scopedCommand = scopedTemplate.replaceAll("{{files}}", scope.files.map(shellQuoteArg).join(" "));
    const scopedResult = await _scopedLintDeps.runLintCommand(
      args.workdir,
      args.storyId,
      args.env,
      scopedCommand,
      args.stripEnvVars,
    );
    return withLintScope(attachLintFindings(toReviewCheck(scopedResult), args.lintOutputFormat, args.workdir), scope);
  }

  if (!scope.degradedReason && isSupportedDerivedScopedCommand(fullLintCommand)) {
    const scopedCommand = appendFilesToCommand(fullLintCommand, scope.files);
    const scopedResult = await _scopedLintDeps.runLintCommand(
      args.workdir,
      args.storyId,
      args.env,
      scopedCommand,
      args.stripEnvVars,
    );
    return withLintScope(attachLintFindings(toReviewCheck(scopedResult), args.lintOutputFormat, args.workdir), scope);
  }

  // Degraded mode: run full lint then post-filter diagnostics to in-scope files.
  logger?.warn("review", "lint_scope_degraded", {
    storyId: args.storyId,
    reason: scope.degradedReason ?? "unsupported_scoped_command_shape",
  });
  const fullResult = await _scopedLintDeps.runLintCommand(
    args.workdir,
    args.storyId,
    args.env,
    fullLintCommand,
    args.stripEnvVars,
  );
  if (fullResult.exitCode === 0) return withLintScope(toReviewCheck(fullResult), scope, "degraded");

  const parsed = parseLintOutput(fullResult.output, args.lintOutputFormat ?? "auto", {
    workdir: args.workdir,
  });
  if (!parsed) {
    logger?.warn("review", "lint_scope_degraded", {
      storyId: args.storyId,
      reason: "unparseable_output",
    });
    return toReviewCheck(fullResult);
  }

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
      lintScope: {
        status: "out_of_scope",
        packageGroups: scope.packageGroups,
        outOfScopeDiagnosticCount: parsed.diagnostics.length,
      },
    };
  }

  return {
    check: "lint",
    command: fullResult.command,
    success: false,
    exitCode: fullResult.exitCode,
    output: scopedOutput,
    durationMs: fullResult.durationMs,
    lintScope: {
      status: "in_scope",
      packageGroups: scope.packageGroups,
      outOfScopeDiagnosticCount: parsed.diagnostics.length - inScopeDiagnostics.length,
    },
    findings: parsed.findings?.filter((f) => typeof f.file === "string" && scopedSet.has(normalizePath(f.file))),
  };
}

export async function runAutofixLint(args: {
  resolvedLintCommand: string;
  configCommands: ReviewConfig["commands"];
  qualityCommands?: QualityConfig["commands"];
  lintOutputFormat?: LintOutputFormat;
  workdir: string;
  projectDir?: string;
  storyId?: string;
  env?: Record<string, string | undefined>;
  /** Secret env var names to strip before spawning the lint command. */
  stripEnvVars?: string[];
  naxIgnoreIndex?: NaxIgnoreIndex;
  scope: AutofixLintScope;
}): Promise<ReviewCheckResult> {
  return runScopedLintCheck(args);
}

export const _scopedLintDeps = {
  listChangedFiles,
  findPackageDir,
  runLintCommand,
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
};
