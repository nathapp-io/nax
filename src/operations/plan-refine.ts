import { makeParseRetryStrategy } from "../agents/retry";
import { planConfigSelector } from "../config";
import type { ProjectProfile } from "../config/runtime-types";
import type { PlanConfig } from "../config/selectors";
import { validatePlanOutput } from "../prd/schema";
import type { PRD } from "../prd/types";
import { PlanPromptBuilder } from "../prompts";
import type { PackageSummary } from "../prompts";
import type { SessionRole } from "../session/types";
import type { RunOperation } from "./types";

export interface PlanRefineInput {
  specContent: string;
  codebaseContext: string;
  featureName: string;
  branchName: string;
  outputPath: string;
  packages?: string[];
  packageDetails?: PackageSummary[];
  projectProfile?: ProjectProfile;
}

export const planRefineOp: RunOperation<PlanRefineInput, PRD, PlanConfig> = {
  kind: "run",
  name: "plan-refine",
  stage: "plan",
  session: { role: "plan-refine" as SessionRole, lifetime: "fresh" },
  config: planConfigSelector,
  model: (_input, ctx) => ctx.config.plan.model,
  timeoutMs: (_input, ctx) => (ctx.config.plan.timeoutSeconds ?? 600) * 1000,
  retry: () =>
    makeParseRetryStrategy({
      validate: (parsed) => {
        if (parsed === null || typeof parsed !== "object") return false;
        const obj = parsed as Record<string, unknown>;
        if (!("userStories" in obj)) return false;
        if (!Array.isArray(obj.userStories)) return false;
        return obj.userStories.length > 0;
      },
      reviewerKind: "plan",
      maxAttempts: 3,
      prompts: {
        invalid: () => PlanPromptBuilder.jsonRepair(0, "Invalid JSON — response was not parseable"),
        truncated: () => PlanPromptBuilder.jsonRepair(0, "JSON appears truncated — please rewrite completely"),
      },
    }),
  fileOutput: (input) => input.outputPath,
  build(input, _ctx) {
    const { taskContext, outputFormat } = new PlanPromptBuilder().build(
      input.specContent,
      input.codebaseContext,
      input.outputPath,
      input.packages,
      input.packageDetails,
      input.projectProfile,
    );
    return {
      role: { id: "role", content: "", overridable: false },
      task: {
        id: "task",
        content: `You are drafting a PRD for the feature: **${input.featureName}**.\n\n${taskContext}\n\n${outputFormat}`,
        overridable: false,
      },
    };
  },
  async hopBody(initialPrompt, ctx) {
    const turn1 = await ctx.sendWithParseRetry(initialPrompt);
    const refinePrompt = new PlanPromptBuilder().buildRefineContinuation(ctx.input.outputPath);
    const turn2 = await ctx.send(refinePrompt);

    return {
      ...turn2,
      estimatedCostUsd: (turn1.estimatedCostUsd ?? 0) + (turn2.estimatedCostUsd ?? 0),
    };
  },
  parse(output, input) {
    return validatePlanOutput(output, input.featureName, input.branchName);
  },
  verify: async (parsed, _input, _ctx) => {
    if (!parsed.userStories || parsed.userStories.length === 0) return null;
    return parsed;
  },
  recover: async (input, ctx) => {
    const content = await ctx.readFile(input.outputPath);
    if (!content) return null;
    try {
      return validatePlanOutput(content, input.featureName, input.branchName);
    } catch {
      return null;
    }
  },
};
