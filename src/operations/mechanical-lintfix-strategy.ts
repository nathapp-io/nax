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

function shellQuotePath(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function buildCommand(
  broad: string | undefined,
  scoped: string | undefined,
  scopeFiles?: readonly string[],
): string | null {
  if (scoped && scopeFiles && scopeFiles.length > 0) {
    return scoped.replaceAll("{{files}}", scopeFiles.map(shellQuotePath).join(" "));
  }
  if (broad) {
    return broad;
  }
  return null;
}

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
    const ctxConfig = (ctx as unknown as { config?: QualityConfig }).config;
    const broad = ctxConfig?.quality?.commands?.lintFix;
    const scoped = ctxConfig?.quality?.commands?.lintFixScoped;
    const command = buildCommand(broad, scoped, input.scopeFiles);
    if (!command) return { applied: true, exitCode: 0 };
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
    buildInput: (findings, _prior, cycleCtx) => ({
      workdir: cycleCtx.packageDir,
      storyId: cycleCtx.storyId,
      scopeFiles: [...new Set(findings.map((finding) => finding.file).filter((file): file is string => Boolean(file)))],
    }),
    extractApplied: () => ({ targetFiles: [], summary: "lint --fix" }),
    maxAttempts: 1,
    coRun: "exclusive",
  };
}
