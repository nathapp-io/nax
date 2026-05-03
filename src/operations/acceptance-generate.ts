import { extractTestCode } from "../acceptance/generator";
import { hasLikelyTestContent, isStubTestContent } from "../acceptance/heuristics";
import { acceptanceGenConfigSelector } from "../config";
import type { AcceptanceGenConfig } from "../config/selectors";
import { AcceptancePromptBuilder } from "../prompts";
import type { CompleteOperation } from "./types";

export interface AcceptanceGenerateInput {
  featureName: string;
  criteriaList: string;
  frameworkOverrideLine: string;
  targetTestFilePath: string;
  implementationContext?: Array<{ path: string; content: string }>;
}

export interface AcceptanceGenerateOutput {
  testCode: string | null;
}

export const acceptanceGenerateOp: CompleteOperation<
  AcceptanceGenerateInput,
  AcceptanceGenerateOutput,
  AcceptanceGenConfig
> = {
  kind: "complete",
  name: "acceptance-generate",
  stage: "acceptance",
  jsonMode: false,
  config: acceptanceGenConfigSelector,
  timeoutMs: (_input, ctx) => ctx.config.execution.sessionTimeoutSeconds * 1000,
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildGeneratorFromPRDPrompt({
      featureName: input.featureName,
      criteriaList: input.criteriaList,
      frameworkOverrideLine: input.frameworkOverrideLine,
      targetTestFilePath: input.targetTestFilePath,
      implementationContext: input.implementationContext,
    });
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    return { testCode: extractTestCode(output) };
  },
  async verify(parsed, input, ctx) {
    // Stdout had real test code → accept as-is.
    if (parsed.testCode !== null) return parsed;

    // ACP agents write the test file as a tool-call side effect and return a
    // conversational summary. Check whether the agent wrote a valid file.
    const diskContent = await ctx.readFile(input.targetTestFilePath);
    if (diskContent === null) return null;

    // Tier 1: agent embedded a fenced code block inside the file.
    const extracted = extractTestCode(diskContent);
    if (extracted && !isStubTestContent(extracted)) return { testCode: extracted };

    // Tier 2: disk content looks like real test source.
    if (hasLikelyTestContent(diskContent) && !isStubTestContent(diskContent)) {
      return { testCode: diskContent };
    }

    // Tier 3 (skeleton fallback) is a stage-level policy decision — not op concern.
    return null;
  },
};
