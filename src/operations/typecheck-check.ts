import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import type { QualityCommandOptions, QualityCommandResult } from "../quality/runner";
import type { TypecheckParseResult } from "../review/typecheck-parsing/types";
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
    format?: string,
    opts?: { workdir: string },
  ) => TypecheckParseResult | null;
}

export const _typecheckCheckDeps: TypecheckCheckDeps = {
  runQualityCommand: async () => {
    throw new Error("not implemented");
  },
  parseTypecheckOutput: () => {
    throw new Error("not implemented");
  },
};

export const typecheckCheckOp: DeterministicOperation<TypecheckCheckInput, TypecheckCheckOutput, QualityConfig> = {
  kind: "deterministic",
  name: "typecheck-check",
  stage: "review",
  config: qualityConfigSelector,
  async execute(
    _input: TypecheckCheckInput,
    _ctx: CallContext,
    _deps: TypecheckCheckDeps = _typecheckCheckDeps,
  ): Promise<TypecheckCheckOutput> {
    return { success: false, findings: [], durationMs: 0 };
  },
};
