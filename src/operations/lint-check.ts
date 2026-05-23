import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import type { QualityCommandOptions, QualityCommandResult } from "../quality/runner";
import type { LintParseResult } from "../review/lint-parsing";
import type { CallContext, DeterministicOperation } from "./types";

export interface LintCheckInput {
  readonly workdir: string;
  readonly storyId: string;
}

export interface LintCheckOutput {
  readonly success: boolean;
  readonly findings: Finding[];
  readonly durationMs: number;
}

export interface LintCheckDeps {
  runQualityCommand: (opts: QualityCommandOptions) => Promise<QualityCommandResult>;
  parseLintOutput: (output: string, format?: string, opts?: { workdir: string }) => LintParseResult | null;
}

export const _lintCheckDeps: LintCheckDeps = {
  runQualityCommand: async () => {
    throw new Error("not implemented");
  },
  parseLintOutput: () => {
    throw new Error("not implemented");
  },
};

export const lintCheckOp: DeterministicOperation<LintCheckInput, LintCheckOutput, QualityConfig> = {
  kind: "deterministic",
  name: "lint-check",
  stage: "review",
  config: qualityConfigSelector,
  async execute(
    _input: LintCheckInput,
    _ctx: CallContext,
    _deps: LintCheckDeps = _lintCheckDeps,
  ): Promise<LintCheckOutput> {
    return { success: false, findings: [], durationMs: 0 };
  },
};
