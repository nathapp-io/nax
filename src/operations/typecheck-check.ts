import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import { getSafeLogger } from "../logger";
import type { QualityCommandOptions, QualityCommandResult } from "../quality/runner";
import { runQualityCommand } from "../quality/runner";
import { parseTypecheckOutput } from "../review/typecheck-parsing";
import type { TypecheckOutputFormat, TypecheckParseResult } from "../review/typecheck-parsing/types";
import type { CallContext, DeterministicOperation } from "./types";

export interface TypecheckCheckInput {
  readonly workdir: string;
  readonly storyId: string;
}

export interface TypecheckCheckOutput {
  readonly success: boolean;
  readonly status?: "passed" | "skipped";
  readonly findings: Finding[];
  readonly durationMs: number;
}

export interface TypecheckCheckDeps {
  runQualityCommand: (opts: QualityCommandOptions) => Promise<QualityCommandResult>;
  parseTypecheckOutput: (
    output: string,
    format?: TypecheckOutputFormat,
    opts?: { workdir: string },
  ) => TypecheckParseResult | null;
}

export const _typecheckCheckDeps: TypecheckCheckDeps = {
  runQualityCommand,
  parseTypecheckOutput,
};

export const typecheckCheckOp: DeterministicOperation<TypecheckCheckInput, TypecheckCheckOutput, QualityConfig> = {
  kind: "deterministic",
  name: "typecheck-check",
  stage: "review",
  config: qualityConfigSelector,
  async execute(
    input: TypecheckCheckInput,
    ctx: CallContext,
    deps: TypecheckCheckDeps = _typecheckCheckDeps,
  ): Promise<TypecheckCheckOutput> {
    const quality = ctx.packageView.select(qualityConfigSelector).quality;
    const command = quality?.commands?.typecheck;

    if (!command) {
      getSafeLogger()?.warn("quality", "No typecheck command configured — skipping typecheck gate", {
        storyId: input.storyId,
        packageDir: ctx.packageView.packageDir,
      });
      return { success: true, status: "skipped", findings: [], durationMs: 0 };
    }

    // Root-config fallback: command was not defined per-package, so run from repo root.
    const cmdWorkdir = ctx.packageView.hasOverride ? input.workdir : ctx.packageView.repoRoot;
    const start = Date.now();
    const result = await deps.runQualityCommand({
      commandName: "typecheck",
      command,
      workdir: cmdWorkdir,
      storyId: input.storyId,
      stripEnvVars: quality?.stripEnvVars ?? [],
    });

    if (result.exitCode === 0) {
      return { success: true, status: "passed", findings: [], durationMs: Date.now() - start };
    }

    const parsed = deps.parseTypecheckOutput(result.output, "auto", { workdir: input.workdir });
    const parsedFindings = parsed?.findings ?? [];
    // Sentinel ensures autofix-implementer strategy fires even when the typecheck
    // output format is unrecognised. fixTarget="source" is required — autofix-implementer
    // gates on it, and typecheck errors always land in source code.
    const sentinel: Finding = {
      source: "typecheck",
      severity: "error",
      category: "typecheck-failure",
      fixTarget: "source",
      message: `typecheck failed (no structured findings parsed), please run the typecheck command: ${command}`,
    };
    const findings = parsedFindings.length > 0 ? parsedFindings : [sentinel];
    return { success: false, findings, durationMs: Date.now() - start };
  },
};
