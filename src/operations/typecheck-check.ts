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
      return { success: true, findings: [], durationMs: 0 };
    }

    const start = Date.now();
    const result = await deps.runQualityCommand({
      commandName: "typecheck",
      command,
      workdir: input.workdir,
      storyId: input.storyId,
      stripEnvVars: quality?.stripEnvVars ?? [],
    });

    if (result.exitCode === 0) {
      return { success: true, findings: [], durationMs: Date.now() - start };
    }

    const parsed = deps.parseTypecheckOutput(result.output, "auto", { workdir: input.workdir });
    return { success: false, findings: parsed?.findings ?? [], durationMs: Date.now() - start };
  },
};
