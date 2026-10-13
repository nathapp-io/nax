/**
 * A5 workflow mode: the one branch fix (spec §7 step 3). Fresh session, write tools,
 * soft interrupt at the fix limit. Same reply contract and parser as the implementer (P4-R20).
 */
import type { ConfiguredModel } from "@/config";
import { workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";
import { softInterruptTurn } from "./_interrupt";
import type { RunOperationWithHooks } from "./types";
import { WORKFLOW_WRITE_TOOLS } from "./workflow-implement";
import { parseImplementerReply } from "./workflow-replies";
import type { ImplementerReply } from "./workflow-types";

export interface WorkflowBranchFixInput {
  readonly prompt: string;
  /** Undefined: workflow.models.branchFix, then finish.reviewers.fix. */
  readonly model?: ConfiguredModel;
  /** Step limit: the soft interrupt fires here. */
  readonly timeoutMs: number;
  /** The feature report: the one nax-owned file this session may write (nax#2479). */
  readonly reportPath: string;
}

export const workflowBranchFixOp: RunOperationWithHooks<
  WorkflowBranchFixInput,
  ImplementerReply,
  WorkflowOpConfig,
  "hopBody" | "recover"
> = {
  kind: "run",
  name: "workflow-branch-fix",
  stage: "run",
  session: { role: "wf-branch-fix", lifetime: "fresh" },
  config: workflowConfigSelector,
  tools: [...WORKFLOW_WRITE_TOOLS],
  model: (input, ctx) =>
    input.model ?? ctx.config.workflow?.models?.branchFix ?? ctx.config.finish?.reviewers?.fix ?? undefined,
  timeoutMs: (input) => input.timeoutMs + STEP_TIMEOUT_MARGIN_MS,
  writableOutput: (input) => input.reportPath,
  build(input) {
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: input.prompt, overridable: false },
    };
  },
  hopBody: (initialPrompt, ctx) => softInterruptTurn(initialPrompt, ctx),
  parse: (output) => parseImplementerReply(output),
  /** An empty reply is not a failure: the fix's real output is the working tree. */
  async recover() {
    return parseImplementerReply("");
  },
};
