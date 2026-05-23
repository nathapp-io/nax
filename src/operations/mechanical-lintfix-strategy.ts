import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { QualityCommandOptions, QualityCommandResult } from "../quality/runner";
import { runQualityCommand } from "../quality/runner";
import type { CallContext, DeterministicOperation } from "./types";

export interface MechanicalLintFixInput {
  readonly workdir: string;
  readonly storyId: string;
  readonly scopeFiles?: string[];
}

export interface MechanicalLintFixOutput {
  readonly applied: true;
  readonly exitCode: number;
}

export interface MechanicalLintFixDeps {
  runQualityCommand: (opts: QualityCommandOptions) => Promise<QualityCommandResult>;
}

export const _mechanicalLintFixDeps: MechanicalLintFixDeps = {
  runQualityCommand,
};

const mechanicalLintFixOp: DeterministicOperation<MechanicalLintFixInput, MechanicalLintFixOutput, QualityConfig> = {
  kind: "deterministic",
  name: "mechanical-lintfix",
  stage: "rectification",
  config: qualityConfigSelector,
  async execute(
    input: MechanicalLintFixInput,
    ctx: CallContext,
    deps: MechanicalLintFixDeps = _mechanicalLintFixDeps,
  ): Promise<MechanicalLintFixOutput> {
    const broad = (ctx as any).config?.quality?.commands?.lintFix as string | undefined;
    if (!broad) return { applied: true, exitCode: 0 };
    const command = input.scopeFiles?.length ? `${broad} ${input.scopeFiles.join(" ")}` : broad;
    const result = await deps.runQualityCommand({
      commandName: "lintFix",
      command,
      workdir: input.workdir,
      storyId: input.storyId,
    });
    return { applied: true, exitCode: result.exitCode };
  },
};

export function makeMechanicalLintFixStrategy(): FixStrategy<
  Finding,
  MechanicalLintFixInput,
  MechanicalLintFixOutput,
  QualityConfig
> {
  return {
    name: "mechanical-lintfix",
    appliesTo: (f) => f.source === "lint",
    fixOp: mechanicalLintFixOp,
    buildInput: (_findings, _prior, cycleCtx) => ({
      workdir: cycleCtx.packageDir,
      storyId: cycleCtx.storyId,
      scopeFiles: undefined,
    }),
    extractApplied: () => ({ targetFiles: [], summary: "lint --fix" }),
    maxAttempts: 1,
    coRun: "exclusive",
  };
}
