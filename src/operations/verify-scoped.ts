import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import { testSummaryToFindings } from "../findings";
import type { Finding } from "../findings/types";
import type { QualityCommandOptions, QualityCommandResult } from "../quality/runner";
import { runQualityCommand } from "../quality/runner";
import { parseTestOutput } from "../test-runners";
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
  runQualityCommand,
  parseTestOutput,
  testSummaryToFindings,
};

export const verifyScopedOp: DeterministicOperation<VerifyScopedInput, VerifyScopedOutput, QualityConfig> = {
  kind: "deterministic",
  name: "verify-scoped",
  stage: "verify",
  config: qualityConfigSelector,
  async execute(
    input: VerifyScopedInput,
    ctx: CallContext,
    deps: VerifyScopedDeps = _verifyScopedDeps,
  ): Promise<VerifyScopedOutput> {
    // ctx.config is injected by tests; in production resolved via callOp's config slice
    const ctxConfig = (ctx as unknown as { config?: QualityConfig }).config;
    const command = ctxConfig?.quality?.commands?.test;

    if (ctxConfig !== undefined && !command) {
      return { success: true, findings: [], durationMs: 0 };
    }

    const start = Date.now();
    const result = await deps.runQualityCommand({
      commandName: "test",
      command: command ?? "",
      workdir: input.workdir,
      storyId: input.storyId,
    });

    if (result.exitCode === 0) {
      return { success: true, findings: [], durationMs: Date.now() - start };
    }

    const summary = deps.parseTestOutput(result.output);
    const findings = deps.testSummaryToFindings(summary);
    return { success: false, findings, durationMs: Date.now() - start };
  },
};
