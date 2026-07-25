import { makeParseRetryStrategy } from "../agents/retry";
import { planConfigSelector } from "../config";
import type { ProjectProfile } from "../config/runtime-types";
import type { PlanConfig } from "../config/selectors";
import { validatePlanOutput } from "../prd/schema";
import type { PRD } from "../prd/types";
import { PlanPromptBuilder } from "../prompts";
import type { PackageSummary } from "../prompts";
import type { RunOperation } from "./types";
import { backfillOutOfScope, warnOnDroppedVerbatimAcs } from "./verbatim-warn";

export interface PlanInteractiveInput {
  specContent: string;
  codebaseContext: string;
  featureName: string;
  branchName: string;
  outputPath: string;
  packages?: string[];
  packageDetails?: PackageSummary[];
  projectProfile?: ProjectProfile;
}

export const planInteractiveOp: RunOperation<PlanInteractiveInput, PRD, PlanConfig> = {
  kind: "run",
  name: "plan-interactive",
  stage: "plan",
  session: { role: "plan", lifetime: "fresh" },
  config: planConfigSelector,
  model: (_input, ctx) => ctx.config.plan.model,
  timeoutMs: (_input, ctx) => (ctx.config.plan.timeoutSeconds ?? 600) * 1000,
  // fileOutput: the plan prompt instructs the agent to write JSON to disk and reply
  // with a brief text confirmation. callOp reads this file after each send and
  // substitutes its content as the probe output — so retries only fire when the
  // file is missing or contains invalid JSON, not on every text-confirmation turn.
  fileOutput: (input) => input.outputPath,
  retry: makeParseRetryStrategy({
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
    // Intentionally no exhaustedFallback: synchronous and only receives lastOutput.
    // Disk recovery is handled by op.recover. See issue #993 and retry-strategy.md
    // "Strict-parser interaction".
  }),
  build(input, ctx) {
    const agentRouting = ctx.config.routing?.agents;
    const profiles = agentRouting?.enabled === true ? (agentRouting.profiles ?? []) : [];
    const { taskContext, outputFormat } = new PlanPromptBuilder().build(
      input.specContent,
      input.codebaseContext,
      input.outputPath,
      input.packages,
      input.packageDetails,
      input.projectProfile,
      undefined,
      profiles,
    );
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: `${taskContext}\n\n${outputFormat}`, overridable: false },
    };
  },
  parse(output, input, _ctx) {
    return validatePlanOutput(output, input.featureName, input.branchName);
  },
  verify: async (parsed, input, _ctx) => {
    if (!parsed.userStories || parsed.userStories.length === 0) return null;
    // Single mode is one-shot (no self-heal turn) — warn on residual [verbatim]
    // drift and continue. Shared with refine via warnOnDroppedVerbatimAcs.
    warnOnDroppedVerbatimAcs(parsed, input.specContent, input.featureName);
    // Feature-level exclusions have one home, so a drop is repairable rather
    // than merely reportable — backfill instead of warning-and-continuing.
    return backfillOutOfScope(parsed, input.specContent, input.featureName);
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
