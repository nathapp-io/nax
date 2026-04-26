/**
 * debateRankOp — CompleteOperation for resolver synthesis/judge turn in debate.
 *
 * This operation encapsulates the resolver's synthesis/judgment phase. It wraps
 * DebatePromptBuilder.rankSlot() to construct a ranking/synthesis prompt that includes
 * all proposals and critiques, then returns the raw agent output.
 *
 * Used by DebateRunner in one-shot and stateful modes to orchestrate the final
 * ranking/synthesis phase after all debater rounds complete.
 */

import { debateConfigSelector } from "../config";
import type { Debater, Proposal, Rebuttal } from "../debate/types";
import { DebatePromptBuilder } from "../prompts";
import type { CompleteOperation } from "./types";

export interface DebateRankInput {
  /** Task description — spec, codebase context, constraints. */
  readonly taskContext: string;
  /** Output format instructions — JSON schema, format directives, etc. */
  readonly outputFormat: string;
  /** Stage name — used in prompt framing text. */
  readonly stage: string;
  /** All proposals from the initial round (resolver will see all of them). */
  readonly proposals: Proposal[];
  /** All rebuttals/critiques from previous rounds (resolver will see all of them). */
  readonly critiques: Rebuttal[];
  /** Debaters participating in this debate (with personas already resolved). */
  readonly debaters: Debater[];
  /** Optional prompt suffix — appended to the synthesis prompt for additional instructions. */
  readonly promptSuffix?: string;
}

type DebateConfig = ReturnType<typeof debateConfigSelector.select>;

/**
 * CompleteOperation for one-shot synthesis/ranking by the resolver.
 *
 * build() constructs the synthesis prompt via DebatePromptBuilder.rankSlot(),
 * which calls buildSynthesisPrompt() — this includes all proposals and critiques
 * so the resolver/judge can synthesize a final outcome.
 *
 * parse() returns the raw output unchanged (the resolver's synthesis/judgment text).
 */
export const debateRankOp: CompleteOperation<DebateRankInput, string, DebateConfig> = {
  kind: "complete",
  name: "debate-rank",
  stage: "review",
  jsonMode: false,
  config: debateConfigSelector,
  build(input, _ctx) {
    const builder = new DebatePromptBuilder(
      { taskContext: input.taskContext, outputFormat: input.outputFormat, stage: input.stage },
      { debaters: input.debaters, sessionMode: "one-shot" },
    );
    return builder.rankSlot(input.proposals, input.critiques, input.promptSuffix);
  },
  parse(output, _input, _ctx) {
    return output;
  },
};
