import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import type { QualityCommandOptions, QualityCommandResult } from "../quality/runner";
import { runQualityCommand } from "../quality/runner";
import type { LintOutputFormat, LintParseResult } from "../review/lint-parsing";
import { parseLintOutput } from "../review/lint-parsing";
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
  parseLintOutput: (output: string, format?: LintOutputFormat, opts?: { workdir: string }) => LintParseResult | null;
}

export const _lintCheckDeps: LintCheckDeps = {
  runQualityCommand,
  parseLintOutput,
};

export const lintCheckOp: DeterministicOperation<LintCheckInput, LintCheckOutput, QualityConfig> = {
  kind: "deterministic",
  name: "lint-check",
  stage: "review",
  config: qualityConfigSelector,
  async execute(
    input: LintCheckInput,
    ctx: CallContext,
    deps: LintCheckDeps = _lintCheckDeps,
  ): Promise<LintCheckOutput> {
    // ctx.config is injected by tests; in production resolved via callOp's config slice
    const ctxConfig = (ctx as unknown as { config?: QualityConfig }).config;
    const command = ctxConfig?.quality?.commands?.lintCheck;

    if (ctxConfig !== undefined && !command) {
      return { success: true, findings: [], durationMs: 0 };
    }

    const start = Date.now();
    const result = await deps.runQualityCommand({
      commandName: "lintCheck",
      command: command ?? "",
      workdir: input.workdir,
      storyId: input.storyId,
    });

    if (result.exitCode === 0) {
      return { success: true, findings: [], durationMs: Date.now() - start };
    }

    const parsed = deps.parseLintOutput(result.output, "auto", { workdir: input.workdir });
    return { success: false, findings: parsed?.findings ?? [], durationMs: Date.now() - start };
  },
};
