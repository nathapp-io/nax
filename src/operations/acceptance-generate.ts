import { extractTestCode } from "../acceptance/generator";
import { acceptanceConfigSelector } from "../config";
import { AcceptancePromptBuilder } from "../prompts";
import type { CompleteOperation } from "./types";

export interface AcceptanceGenerateInput {
  featureName: string;
  criteriaList: string;
  frameworkOverrideLine: string;
  targetTestFilePath: string;
  implementationContext?: Array<{ path: string; content: string }>;
  previousFailure?: string;
}

export interface AcceptanceGenerateOutput {
  testCode: string | null;
}

type AcceptanceConfig = ReturnType<typeof acceptanceConfigSelector.select>;

export const acceptanceGenerateOp: CompleteOperation<
  AcceptanceGenerateInput,
  AcceptanceGenerateOutput,
  AcceptanceConfig
> = {
  kind: "complete",
  name: "acceptance-generate",
  stage: "acceptance",
  jsonMode: false,
  config: acceptanceConfigSelector,
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildGeneratorFromPRDPrompt({
      featureName: input.featureName,
      criteriaList: input.criteriaList,
      frameworkOverrideLine: input.frameworkOverrideLine,
      targetTestFilePath: input.targetTestFilePath,
      implementationContext: input.implementationContext,
      previousFailure: input.previousFailure,
    });
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    return { testCode: extractTestCode(output) };
  },
};
