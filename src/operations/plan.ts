import { planConfigSelector } from "../config";
import type { ProjectProfile } from "../config/runtime-types";
import type { PlanConfig } from "../config/selectors";
import { validatePlanOutput } from "../prd/schema";
import type { PRD } from "../prd/types";
import { PlanPromptBuilder } from "../prompts";
import type { PackageSummary } from "../prompts";
import type { CompleteOperation } from "./types";

export interface PlanOpInput {
  specContent: string;
  codebaseContext: string;
  featureName: string;
  branchName: string;
  packages?: string[];
  packageDetails?: PackageSummary[];
  projectProfile?: ProjectProfile;
}

export const planOp: CompleteOperation<PlanOpInput, PRD, PlanConfig> = {
  kind: "complete",
  name: "plan",
  stage: "plan",
  jsonMode: false,
  config: planConfigSelector,
  timeoutMs: (_input, ctx) => (ctx.config.plan.timeoutSeconds ?? 600) * 1000,
  build(input, _ctx) {
    const { taskContext, outputFormat } = new PlanPromptBuilder().build(
      input.specContent,
      input.codebaseContext,
      undefined,
      input.packages,
      input.packageDetails,
      input.projectProfile,
    );
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: `${taskContext}\n\n${outputFormat}`, overridable: false },
    };
  },
  parse(output, input, _ctx) {
    return validatePlanOutput(output, input.featureName, input.branchName);
  },
};
