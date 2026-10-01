import { extractTestCode } from "../acceptance/generator";
import { hasLikelyTestContent, isStubTestContent } from "../acceptance/heuristics";
import { acceptanceGenConfigSelector } from "../config";
import type { AcceptanceGenConfig } from "../config/selectors";
import { AcceptancePromptBuilder } from "../prompts";
import type { RunOperationWithHooks } from "./types";

export interface AcceptanceRepairInput {
  targetTestFilePath: string;
  outputTail: string;
}

export interface AcceptanceRepairOutput {
  testCode: string | null;
}

/**
 * Scoped acceptance-file load repair: when the acceptance test file fails to
 * load, ask the generator role for the smallest edit that makes it load while
 * keeping every AC-N test and its assertions.
 */
export const acceptanceRepairOp: RunOperationWithHooks<
  AcceptanceRepairInput,
  AcceptanceRepairOutput,
  AcceptanceGenConfig,
  "verify"
> = {
  kind: "run",
  name: "acceptance-repair",
  stage: "acceptance",
  session: { role: "acceptance-gen", lifetime: "fresh" },
  tools: ["Read", "Glob", "Grep", "Write", "Edit", "RequestCapability"],
  config: acceptanceGenConfigSelector,
  model: (_input, ctx) => ctx.config.acceptance.generateModel ?? ctx.config.acceptance.model,
  timeoutMs: (_input, ctx) => ctx.config.execution.sessionTimeoutSeconds * 1000,
  build(input, _ctx) {
    return {
      role: { id: "role", content: "", overridable: false },
      task: {
        id: "task",
        content: new AcceptancePromptBuilder().buildLoadRepairPrompt(input.targetTestFilePath, input.outputTail),
        overridable: false,
      },
    };
  },
  parse(output, _input, _ctx) {
    return { testCode: extractTestCode(output) };
  },
  async verify(parsed, input, ctx) {
    // The reply carried the repaired code → accept it as-is.
    if (parsed.testCode !== null) return parsed;

    // The agent edited the file in place as a tool-call side effect and replied
    // conversationally. Fall back to the target file's content when it now
    // holds real test source rather than a placeholder stub.
    const content = await ctx.readFile(input.targetTestFilePath);
    if (content === null) return null;
    if (hasLikelyTestContent(content) && !isStubTestContent(content)) {
      return { testCode: content };
    }
    return null;
  },
};
