/**
 * debateRebutOp — CompleteOperation for one debater's rebuttal turn in debate.
 *
 * This operation encapsulates a single debater's critique/rebuttal response
 * in a debate round (Round 1+). It wraps DebatePromptBuilder.rebutSlot() to construct
 * a rebuttal prompt (which excludes the calling debater's own proposal) and returns
 * the raw agent output.
 *
 * Used by DebateRunner in one-shot and stateful modes to orchestrate parallel
 * rebuttal generation from multiple debaters after an initial proposal round.
 */

import { debateConfigSelector } from "../config";
import type { Debater, Proposal } from "../debate/types";
import { DebatePromptBuilder } from "../prompts";
import type { CompleteOperation } from "./types";

export interface DebateRebutInput {
  /** Task description — spec, codebase context, constraints. */
  readonly taskContext: string;
  /** Stage name — used in prompt framing text. */
  readonly stage: string;
  /** Index of the debater in the debaters array (determines persona and role). */
  readonly debaterIndex: number;
  /** All proposals from the initial round (debater will see all except their own). */
  readonly proposals: Proposal[];
  /** Debaters participating in this debate (with personas already resolved). */
  readonly debaters: Debater[];
}

type DebateConfig = ReturnType<typeof debateConfigSelector.select>;

/**
 * CompleteOperation for one-shot rebuttal generation.
 *
 * build() constructs the rebuttal prompt via DebatePromptBuilder.rebutSlot(),
 * which calls buildCritiquePrompt() — this excludes the calling debater's own proposal
 * so they see and critique all other debaters' proposals.
 *
 * parse() returns the raw output unchanged (the debater's rebuttal text).
 */
export const debateRebutOp: CompleteOperation<DebateRebutInput, string, DebateConfig> = {
  kind: "complete",
  name: "debate-rebut",
  stage: "review",
  jsonMode: false,
  config: debateConfigSelector,
  build(input, _ctx) {
    const builder = new DebatePromptBuilder(
      { taskContext: input.taskContext, outputFormat: "", stage: input.stage },
      { debaters: input.debaters, sessionMode: "one-shot" },
    );
    return builder.rebutSlot(input.debaterIndex, input.proposals);
  },
  parse(output, _input, _ctx) {
    return output;
  },
};
