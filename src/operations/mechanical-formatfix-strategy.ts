import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { QualityCommandOptions, QualityCommandResult } from "../quality/runner";
import { runQualityCommand } from "../quality/runner";
import type { CallContext, DeterministicOperation } from "./types";

export interface MechanicalFormatFixInput {
  readonly workdir: string;
  readonly storyId: string;
  readonly scopeFiles?: string[];
}

export interface MechanicalFormatFixOutput {
  readonly applied: true;
  readonly exitCode: number;
}

export interface MechanicalFormatFixDeps {
  runQualityCommand: (opts: QualityCommandOptions) => Promise<QualityCommandResult>;
}

export const _mechanicalFormatFixDeps: MechanicalFormatFixDeps = {
  runQualityCommand,
};

const mechanicalFormatFixOp: DeterministicOperation<
  MechanicalFormatFixInput,
  MechanicalFormatFixOutput,
  QualityConfig
> = {
  kind: "deterministic",
  name: "mechanical-formatfix",
  stage: "rectification",
  config: qualityConfigSelector,
  async execute(
    input: MechanicalFormatFixInput,
    ctx: CallContext,
    deps: MechanicalFormatFixDeps = _mechanicalFormatFixDeps,
  ): Promise<MechanicalFormatFixOutput> {
    const broad = (ctx as unknown as { config?: QualityConfig }).config?.quality?.commands?.formatFix;
    if (!broad) return { applied: true, exitCode: 0 };
    const command = input.scopeFiles?.length ? `${broad} ${input.scopeFiles.join(" ")}` : broad;
    const result = await deps.runQualityCommand({
      commandName: "formatFix",
      command,
      workdir: input.workdir,
      storyId: input.storyId,
    });
    return { applied: true, exitCode: result.exitCode };
  },
};

export function makeMechanicalFormatFixStrategy(): FixStrategy<
  Finding,
  MechanicalFormatFixInput,
  MechanicalFormatFixOutput,
  QualityConfig
> {
  return {
    name: "mechanical-formatfix",
    appliesTo: (f) => f.source === "lint",
    fixOp: mechanicalFormatFixOp,
    buildInput: (_findings, _prior, cycleCtx) => ({
      workdir: cycleCtx.packageDir,
      storyId: cycleCtx.storyId,
      scopeFiles: undefined,
    }),
    extractApplied: () => ({ targetFiles: [], summary: "format --fix" }),
    maxAttempts: 1,
    coRun: "exclusive",
  };
}
