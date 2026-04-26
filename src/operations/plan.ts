import { planConfigSelector } from "../config";
import type { ProjectProfile } from "../config/runtime-types";
import { PlanPromptBuilder } from "../prompts";
import type { PackageSummary } from "../prompts";
import type { CompleteOperation } from "./types";

export interface PlanOpInput {
  specContent: string;
  codebaseContext: string;
  packages?: string[];
  packageDetails?: PackageSummary[];
  projectProfile?: ProjectProfile;
}

type PlanConfig = ReturnType<typeof planConfigSelector.select>;

export const planOp: CompleteOperation<PlanOpInput, string, PlanConfig> = {
  kind: "complete",
  name: "plan",
  stage: "plan",
  jsonMode: false,
  config: planConfigSelector,
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
  parse(output, _input, _ctx) {
    return output;
  },
};
