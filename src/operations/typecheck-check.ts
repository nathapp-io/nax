import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
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
    // ctx.config is injected by tests; in production resolved via callOp's config slice
    const ctxConfig = (ctx as unknown as { config?: QualityConfig }).config;
    const command = ctxConfig?.quality?.commands?.typecheckCheck;

    if (ctxConfig !== undefined && !command) {
      return { success: true, findings: [], durationMs: 0 };
    }

    const start = Date.now();
    const result = await deps.runQualityCommand({
      commandName: "typecheckCheck",
      command: command ?? "",
      workdir: input.workdir,
      storyId: input.storyId,
    });

    if (result.exitCode === 0) {
      return { success: true, findings: [], durationMs: Date.now() - start };
    }

    const parsed = deps.parseTypecheckOutput(result.output, "auto", { workdir: input.workdir });
    return { success: false, findings: parsed?.findings ?? [], durationMs: Date.now() - start };
  },
};
