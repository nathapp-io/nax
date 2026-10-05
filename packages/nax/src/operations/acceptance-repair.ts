import { extractTestCode } from "../acceptance/generator";
import { hasLikelyTestContent, isStubTestContent } from "../acceptance/heuristics";
import { acceptanceGenConfigSelector } from "../config";
import type { AcceptanceGenConfig } from "../config/selectors";
import { AcceptancePromptBuilder } from "../prompts";
import type { RunOperationWithHooks } from "./types";

export interface AcceptanceRepairInput {
  targetTestFilePath: string;
  outputTail: string;
  /** Target content captured by the gate before this repair turn. */
  previousContent?: string;
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
    // Repair replies are often prose mentioning test syntax. Only fenced
    // source is eligible; the generator's raw-source fallbacks are unsafe here.
    const fenced = output.match(/```(?:\w+)?\s*[\s\S]*?```/);
    return { testCode: fenced ? extractTestCode(fenced[0]) : null };
  },
  async verify(parsed, input, ctx) {
    const content = await ctx.readFile(input.targetTestFilePath);
    const hasRealDiskTest = content !== null && hasLikelyTestContent(content) && !isStubTestContent(content);
    // An in-place edit is the canonical artifact, even when the reply also
    // contains fenced code. An unchanged file must not hide a reply-only repair.
    if (hasRealDiskTest && (content !== input.previousContent || parsed.testCode === null)) {
      return { testCode: content };
    }
    if (parsed.testCode !== null) return parsed;
    return null;
  },
};
