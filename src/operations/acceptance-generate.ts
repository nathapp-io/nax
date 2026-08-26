import { extractTestCode } from "../acceptance/generator";
import { hasLikelyTestContent, isStubTestContent } from "../acceptance/heuristics";
import { acceptanceGenConfigSelector } from "../config";
import type { AcceptanceGenConfig } from "../config/selectors";
import { AcceptancePromptBuilder } from "../prompts";
import { makeSelfHealStep, runSelfHealChain, type SelfHealStep } from "./self-heal";
import type { RunOperation, RunOperationWithHooks } from "./types";

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

/** Injectable I/O for the hopBody path-correction step (testable without disk). */
export const _acceptanceGenerateDeps = {
  fileExists: async (path: string): Promise<boolean> => {
    try {
      return await Bun.file(path).exists();
    } catch {
      return false;
    }
  },
};

/**
 * Path-correction self-heal: if the generation turn did not leave a file at
 * `targetTestFilePath` (agents often rename the dotfile/dashed name), issue one
 * corrective turn telling the agent the exact path. `verify` then reads the file
 * and only falls back to a skeleton if this still misses.
 */
function pathCorrectionStep(): SelfHealStep<AcceptanceGenerateInput> {
  return makeSelfHealStep<AcceptanceGenerateInput, string>({
    detect: async (input) =>
      (await _acceptanceGenerateDeps.fileExists(input.targetTestFilePath)) ? [] : [input.targetTestFilePath],
    buildRepair: (_deviations, input) => new AcceptancePromptBuilder().buildPathCorrection(input.targetTestFilePath),
    log: {
      kind: "acceptance",
      message: "Acceptance test not found at target path — issuing one corrective turn",
      meta: (input) => ({ targetTestFilePath: input.targetTestFilePath }),
    },
  });
}

export const acceptanceGenerateOp: RunOperationWithHooks<
  AcceptanceGenerateInput,
  AcceptanceGenerateOutput,
  AcceptanceGenConfig,
  "hopBody" | "verify"
> = {
  kind: "run",
  name: "acceptance-generate",
  stage: "acceptance",
  session: { role: "acceptance-gen", lifetime: "fresh" },
  config: acceptanceGenConfigSelector,
  model: (_input, ctx) => ctx.config.acceptance.generateModel ?? ctx.config.acceptance.model,
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
  async hopBody(initialPrompt, ctx) {
    const turn1 = await ctx.sendWithParseRetry(initialPrompt);
    return runSelfHealChain(ctx, turn1, [pathCorrectionStep()]);
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
