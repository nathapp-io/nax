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
  name: "",
  stage: "rectification",
  config: qualityConfigSelector,
  async execute(
    _input: MechanicalLintFixInput,
    _ctx: CallContext,
    _deps: MechanicalLintFixDeps = _mechanicalLintFixDeps,
  ): Promise<MechanicalLintFixOutput> {
    return { applied: false as unknown as true, exitCode: -1 };
  },
};

export function makeMechanicalLintFixStrategy(): FixStrategy<
  Finding,
  MechanicalLintFixInput,
  MechanicalLintFixOutput,
  QualityConfig
> {
  return {
    name: "",
    appliesTo: () => null as unknown as boolean,
    fixOp: mechanicalLintFixOp,
    buildInput: () => null as any,
    extractApplied: () => ({ targetFiles: [], summary: "" }),
    maxAttempts: 0,
    coRun: "exclusive",
  };
}
