import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { QualityCommandOptions, QualityCommandResult } from "../quality/runner";
import { runQualityCommand } from "../quality/runner";
import { shellQuoteArg } from "../verification/shell-quote";
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

function buildCommand(
  broad: string | undefined,
  scoped: string | undefined,
  scopeFiles?: readonly string[],
): string | null {
  if (scoped && scopeFiles && scopeFiles.length > 0) {
    return scoped.replaceAll("{{files}}", scopeFiles.map(shellQuoteArg).join(" "));
  }
  if (broad) {
    return broad;
  }
  return null;
}

const mechanicalFormatFixOp: DeterministicOperation<
  MechanicalFormatFixInput,
  MechanicalFormatFixOutput,
  QualityConfig,
  MechanicalFormatFixDeps
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
    const quality = ctx.packageView.select(qualityConfigSelector).quality;
    const broad = quality?.commands?.formatFix;
    const scoped = quality?.commands?.formatFixScoped;
    const command = buildCommand(broad, scoped, input.scopeFiles);
    if (!command) return { applied: true, exitCode: 0 };
    const result = await deps.runQualityCommand({
      commandName: "formatFix",
      command,
      workdir: input.workdir,
      storyId: input.storyId,
      stripEnvVars: quality?.stripEnvVars ?? [],
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
    buildInput: (findings, _prior, cycleCtx) => ({
      workdir: cycleCtx.packageDir,
      storyId: cycleCtx.storyId,
      scopeFiles: [...new Set(findings.map((finding) => finding.file).filter((file): file is string => Boolean(file)))],
    }),
    extractApplied: () => ({ targetFiles: [], summary: "format --fix" }),
    maxAttempts: 1,
    coRun: "exclusive",
  };
}
