import { parseDecomposeOutput } from "../agents/shared/decompose";
import { buildDecomposePromptSync } from "../agents/shared/decompose-prompt";
import type { DecomposedStory } from "../agents/shared/types-extended";
import { decomposeConfigSelector } from "../config";
import type { DecomposeConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import { OneShotPromptBuilder } from "../prompts";
import type { CompleteOperation } from "./types";

export interface DecomposeOpInput {
  specContent: string;
  codebaseContext: string;
  targetStory?: UserStory;
  siblings?: UserStory[];
  maxAcCount?: number | null;
}

export type DecomposeOpOutput = DecomposedStory[];

export const decomposeOp: CompleteOperation<DecomposeOpInput, DecomposeOpOutput, DecomposeConfig> = {
  kind: "complete",
  name: "decompose",
  stage: "plan",
  jsonMode: false,
  config: decomposeConfigSelector,
  model: (_input, ctx) => ctx.config.plan.model,
  timeoutMs: (_input, ctx) => (ctx.config.plan.decomposeTimeoutSeconds ?? ctx.config.plan.timeoutSeconds ?? 600) * 1000,
  build(input, ctx) {
    let prompt = buildDecomposePromptSync({
      specContent: input.specContent,
      codebaseContext: input.codebaseContext,
      targetStory: input.targetStory,
      siblings: input.siblings,
      maxAcCount: input.maxAcCount,
    });

    const agentRouting = ctx.config.routing?.agents;
    if (agentRouting?.enabled === true) {
      const profiles = agentRouting.profiles ?? [];
      const cards = OneShotPromptBuilder.agentCapabilityCards(profiles);
      if (cards.length > 0) {
        prompt = `${prompt}\n\n${cards}`;
      }
    }

    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, _input, ctx) {
    const stories = parseDecomposeOutput(output);

    const agentRouting = ctx.config.routing?.agents;
    if (agentRouting?.enabled !== true) {
      return stories;
    }

    const profiles = agentRouting.profiles ?? [];
    if (profiles.length === 0) {
      return stories;
    }

    return stories.map((story) => {
      if (!story.agentProfileId) {
        return story;
      }
      const profile = profiles.find((p) => p.id === story.agentProfileId);
      if (!profile) {
        // LLM hallucinated an unknown profile id — leave routing unchanged
        return story;
      }
      return {
        ...story,
        routing: {
          ...story.routing,
          agent: profile.target.agent,
          agentProfileId: profile.id,
        },
      };
    });
  },
};
