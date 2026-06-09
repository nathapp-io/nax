import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import { getSafeLogger } from "../logger";
import type { QualityCommandOptions, QualityCommandResult } from "../quality/runner";
import { runQualityCommand } from "../quality/runner";
import type { LintOutputFormat, LintParseResult } from "../review/lint-parsing";
import { parseLintOutput } from "../review/lint-parsing";
import type { CallContext, DeterministicOperation } from "./types";

export interface LintCheckInput {
  readonly workdir: string;
  readonly storyId: string;
}

export interface LintCheckOutput {
  readonly success: boolean;
  readonly status?: "passed" | "skipped";
  readonly findings: Finding[];
  readonly durationMs: number;
}

export interface LintCheckDeps {
  runQualityCommand: (opts: QualityCommandOptions) => Promise<QualityCommandResult>;
  parseLintOutput: (output: string, format?: LintOutputFormat, opts?: { workdir: string }) => LintParseResult | null;
}

export const _lintCheckDeps: LintCheckDeps = {
  runQualityCommand,
  parseLintOutput,
};

export const lintCheckOp: DeterministicOperation<LintCheckInput, LintCheckOutput, QualityConfig> = {
  kind: "deterministic",
  name: "lint-check",
  stage: "review",
  config: qualityConfigSelector,
  async execute(
    input: LintCheckInput,
    ctx: CallContext,
    deps: LintCheckDeps = _lintCheckDeps,
  ): Promise<LintCheckOutput> {
    const quality = ctx.packageView.select(qualityConfigSelector).quality;
    const command = quality?.commands?.lint;

    // No command configured → skip (success, non-blocking) with a warning.
    // Never spawn an empty command (that would exit 0 and read as a false pass).
    if (!command) {
      getSafeLogger()?.warn("quality", "No lint command configured — skipping lint gate", {
        storyId: input.storyId,
        packageDir: ctx.packageView.packageDir,
      });
      return { success: true, status: "skipped", findings: [], durationMs: 0 };
    }

    // Root-config fallback: command was not defined per-package, so run from repo root.
    const cmdWorkdir = ctx.packageView.hasOverride ? input.workdir : ctx.packageView.repoRoot;
    const start = Date.now();
    const result = await deps.runQualityCommand({
      commandName: "lint",
      command,
      workdir: cmdWorkdir,
      storyId: input.storyId,
      stripEnvVars: quality?.stripEnvVars ?? [],
    });

    if (result.exitCode === 0) {
      return { success: true, status: "passed", findings: [], durationMs: Date.now() - start };
    }

    const parsed = deps.parseLintOutput(result.output, "auto", { workdir: input.workdir });
    const parsedFindings = parsed?.findings ?? [];
    // Sentinel ensures mechanical-lintfix strategy fires even when the linter's
    // output format is unrecognised (parsedFindings empty).
    const sentinel: Finding = {
      source: "lint",
      severity: "error",
      category: "lint-failure",
      message: "lint failed (no structured findings parsed)",
    };
    const findings = parsedFindings.length > 0 ? parsedFindings : [sentinel];
    return { success: false, findings, durationMs: Date.now() - start };
  },
};
