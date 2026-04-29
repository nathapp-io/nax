import { acceptanceFixConfigSelector } from "../config";
import { AcceptancePromptBuilder } from "../prompts";
import type { RunOperation } from "./types";

export interface AcceptanceFixSourceInput {
  testOutput: string;
  diagnosisReasoning?: string;
  acceptanceTestPath: string;
  testFileContent?: string;
}

export interface AcceptanceFixTestInput {
  testOutput: string;
  diagnosisReasoning?: string;
  failedACs: string[];
  acceptanceTestPath: string;
  testFileContent?: string;
  previousFailure?: string;
}

export interface AcceptanceFixOutput {
  applied: true;
}

type AcceptanceFixConfig = ReturnType<typeof acceptanceFixConfigSelector.select>;

export const acceptanceFixSourceOp: RunOperation<AcceptanceFixSourceInput, AcceptanceFixOutput, AcceptanceFixConfig> = {
  kind: "run",
  name: "acceptance-fix-source",
  stage: "acceptance",
  session: { role: "source-fix", lifetime: "fresh" },
  config: acceptanceFixConfigSelector,
  timeoutMs: (_input, ctx) => ctx.config.execution.sessionTimeoutSeconds * 1000,
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildSourceFixPrompt({
      testOutput: input.testOutput,
      diagnosisReasoning: input.diagnosisReasoning,
      acceptanceTestPath: input.acceptanceTestPath,
      testFileContent: input.testFileContent,
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
  timeoutMs: (_input, ctx) => ctx.config.execution.sessionTimeoutSeconds * 1000,
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildTestFixPrompt({
      testOutput: input.testOutput,
      diagnosisReasoning: input.diagnosisReasoning,
      failedACs: input.failedACs,
      acceptanceTestPath: input.acceptanceTestPath,
      testFileContent: input.testFileContent ?? "",
      previousFailure: input.previousFailure,
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
