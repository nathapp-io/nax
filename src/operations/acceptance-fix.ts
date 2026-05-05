import { acceptanceFixConfigSelector } from "../config";
import type { AcceptanceFixConfig } from "../config/selectors";
import { AcceptancePromptBuilder } from "../prompts";
import type { RunOperation } from "./types";

export interface AcceptanceFixSourceInput {
  testOutput: string;
  testCommand?: string;
  diagnosisReasoning?: string;
  priorIterationsBlock?: string;
  acceptanceTestPath: string;
}

export interface AcceptanceFixTestInput {
  testOutput: string;
  testCommand?: string;
  diagnosisReasoning?: string;
  priorIterationsBlock?: string;
  failedACs: string[];
  acceptanceTestPath: string;
}

export interface AcceptanceFixOutput {
  applied: true;
}

export const acceptanceFixSourceOp: RunOperation<AcceptanceFixSourceInput, AcceptanceFixOutput, AcceptanceFixConfig> = {
  kind: "run",
  name: "acceptance-fix-source",
  stage: "acceptance",
  session: { role: "source-fix", lifetime: "fresh" },
  config: acceptanceFixConfigSelector,
  model: (_input, ctx) => ctx.config.acceptance.fix?.fixModel ?? ctx.config.acceptance.model,
  timeoutMs: (_input, ctx) => ctx.config.execution.sessionTimeoutSeconds * 1000,
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildSourceFixPrompt({
      testOutput: input.testOutput,
      testCommand: input.testCommand,
      diagnosisReasoning: input.diagnosisReasoning,
      priorIterationsBlock: input.priorIterationsBlock,
      acceptanceTestPath: input.acceptanceTestPath,
    });
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(_output, _input, _ctx) {
    return { applied: true };
  },
};

export const acceptanceFixTestOp: RunOperation<AcceptanceFixTestInput, AcceptanceFixOutput, AcceptanceFixConfig> = {
  kind: "run",
  name: "acceptance-fix-test",
  stage: "acceptance",
  session: { role: "test-fix", lifetime: "fresh" },
  config: acceptanceFixConfigSelector,
  model: (_input, ctx) => ctx.config.acceptance.fix?.fixModel ?? ctx.config.acceptance.model,
  timeoutMs: (_input, ctx) => ctx.config.execution.sessionTimeoutSeconds * 1000,
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildTestFixPrompt({
      testOutput: input.testOutput,
      testCommand: input.testCommand,
      diagnosisReasoning: input.diagnosisReasoning,
      priorIterationsBlock: input.priorIterationsBlock,
      failedACs: input.failedACs,
      acceptanceTestPath: input.acceptanceTestPath,
    });
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(_output, _input, _ctx) {
    return { applied: true };
  },
};
