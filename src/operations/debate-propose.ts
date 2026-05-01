/**
 * debateProposeOp — CompleteOperation for one debater's proposal turn in debate.
 *
 * This operation encapsulates a single debater's response to the initial task
 * in a debate (Round 0). It wraps DebatePromptBuilder.proposeSlot() to construct
 * a proposal prompt and returns the raw agent output.
 *
 * Used by DebateRunner in one-shot and stateful modes to orchestrate parallel
 * proposal generation from multiple debaters.
 */

import { debateConfigSelector } from "../config";
import type { DebateConfig } from "../config/selectors";
import type { Debater } from "../debate/types";
import { DebatePromptBuilder } from "../prompts";
import type { CompleteOperation } from "./types";

export interface DebateProposeInput {
  /** Task description — spec, codebase context, constraints. */
  readonly taskContext: string;
  /** Output format instructions — JSON schema, format directives, etc. */
  readonly outputFormat: string;
  /** Stage name — used in prompt framing text. */
  readonly stage: string;
  /** Index of the debater in the debaters array (determines persona and role). */
  readonly debaterIndex: number;
  /** Debaters participating in this debate (with personas already resolved). */
  readonly debaters: Debater[];
}

/**
 * completeOperation for one-shot proposal generation.
 *
 * build() constructs the initial proposal prompt via DebatePromptBuilder.proposeSlot().
 * parse() returns the raw output unchanged (the debater's proposal text).
 */
export const debateProposeOp: CompleteOperation<DebateProposeInput, string, DebateConfig> = {
  kind: "complete",
  name: "debate-propose",
  stage: "review",
  jsonMode: false,
  config: debateConfigSelector,
  build(input, _ctx) {
    const builder = new DebatePromptBuilder(
      { taskContext: input.taskContext, outputFormat: input.outputFormat, stage: input.stage },
      { debaters: input.debaters, sessionMode: "one-shot" },
    );
    return builder.proposeSlot(input.debaterIndex);
  },
  parse(output, _input, _ctx) {
    return output;
  },
};
