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

const mechanicalFormatFixOp: DeterministicOperation<MechanicalFormatFixInput, MechanicalFormatFixOutput, QualityConfig> =
  {
    kind: "deterministic",
    name: "",
    stage: "rectification",
    config: qualityConfigSelector,
    async execute(
      _input: MechanicalFormatFixInput,
      _ctx: CallContext,
      _deps: MechanicalFormatFixDeps = _mechanicalFormatFixDeps,
    ): Promise<MechanicalFormatFixOutput> {
      return { applied: false as unknown as true, exitCode: -1 };
    },
  };

export function makeMechanicalFormatFixStrategy(): FixStrategy<
  Finding,
  MechanicalFormatFixInput,
  MechanicalFormatFixOutput,
  QualityConfig
> {
  return {
    name: "",
    appliesTo: () => null as unknown as boolean,
    fixOp: mechanicalFormatFixOp,
    buildInput: () => null as any,
    extractApplied: () => ({ targetFiles: [], summary: "" }),
    maxAttempts: 0,
    coRun: "exclusive",
  };
}
