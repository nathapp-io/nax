import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import type { QualityCommandOptions, QualityCommandResult } from "../quality/runner";
import type { TestSummary } from "../test-runners";
import type { CallContext, DeterministicOperation } from "./types";

export interface VerifyScopedInput {
  readonly workdir: string;
  readonly storyId: string;
  readonly packageDir?: string;
}

export interface VerifyScopedOutput {
  readonly success: boolean;
  readonly findings: Finding[];
  readonly durationMs: number;
}

export interface VerifyScopedDeps {
  runQualityCommand: (opts: QualityCommandOptions) => Promise<QualityCommandResult>;
  parseTestOutput: (output: string) => TestSummary;
  testSummaryToFindings: (summary: TestSummary) => Finding[];
}

export const _verifyScopedDeps: VerifyScopedDeps = {
  runQualityCommand: async () => {
    throw new Error("not implemented");
  },
  parseTestOutput: () => {
    throw new Error("not implemented");
  },
  testSummaryToFindings: () => {
    throw new Error("not implemented");
  },
};

export const verifyScopedOp: DeterministicOperation<VerifyScopedInput, VerifyScopedOutput, QualityConfig> = {
  kind: "deterministic",
  name: "verify-scoped",
  stage: "verify",
  config: qualityConfigSelector,
  async execute(
    _input: VerifyScopedInput,
    _ctx: CallContext,
    _deps: VerifyScopedDeps = _verifyScopedDeps,
  ): Promise<VerifyScopedOutput> {
    return { success: false, findings: [], durationMs: 0 };
  },
};
