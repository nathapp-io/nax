/**
 * A5 workflow mode: the story's one implementer (spec §6 steps 2 and 5).
 * The same op serves the first turn, fix rounds and advisor answers; the caller builds the prompt.
 * Warm across rounds 1..min(3, max): same role + same endpoint = the same session (§5.5).
 */
import type { ConfiguredModel } from "@/config";
import { workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";
import type { UserStory } from "../prd";
import { softInterruptTurn } from "./_interrupt";
import { storyRoutingModel } from "./story-routing-model";
import type { RunOperationWithHooks } from "./types";
import { parseImplementerReply } from "./workflow-replies";
import type { ImplementerReply } from "./workflow-types";

export interface WorkflowImplementInput {
  readonly story: UserStory;
  readonly prompt: string;
  /** Undefined: the story's routed model (storyRoutingModel). */
  readonly model?: ConfiguredModel;
  /** Step limit: the soft interrupt fires at this point. */
  readonly timeoutMs: number;
  /** The story's report.md: the one nax-owned file this session may write (nax#2479). */
  readonly reportPath?: string;
}

export const WORKFLOW_WRITE_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Delete",
  "Git",
  "RunCommand",
  "GitCommit",
  "Exec",
  "Bash",
  "RequestCapability",
] as const;

export const workflowImplementOp: RunOperationWithHooks<
  WorkflowImplementInput,
  ImplementerReply,
  WorkflowOpConfig,
  "hopBody" | "recover"
> = {
  kind: "run",
  name: "workflow-implement",
  stage: "run",
  session: { role: "wf-implementer", lifetime: "warm" },
  config: workflowConfigSelector,
  tools: [...WORKFLOW_WRITE_TOOLS],
  model: (input) => input.model ?? storyRoutingModel(input.story),
  keepOpen: () => true,
  writableOutput: (input) => input.reportPath,
  // The agent's own timeout trails the step limit, so the soft interrupt always fires first.
  timeoutMs: (input) => input.timeoutMs + STEP_TIMEOUT_MARGIN_MS,
  build(input) {
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: input.prompt, overridable: false },
    };
  },
  /**
   * One turn under a soft interrupt at the step limit. An interrupted turn leaves the
   * session warm and its edits in the tree (spec §6 failure table); it comes back as
   * the marker, never rethrown, so the stale-retry never re-runs a stopped turn.
   */
  hopBody: (initialPrompt, ctx) => softInterruptTurn(initialPrompt, ctx),
  parse: (output) => parseImplementerReply(output),
  /** An empty reply is not a failure: the implementer's real output is the working tree. */
  async recover() {
    return parseImplementerReply("");
  },
};
