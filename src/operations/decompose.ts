import { parseDecomposeOutput } from "../agents/shared/decompose";
import { buildDecomposePromptSync } from "../agents/shared/decompose-prompt";
import type { DecomposedStory } from "../agents/shared/types-extended";
import { decomposeConfigSelector } from "../config";
import type { DecomposeConfig } from "../config/selectors";
import { getSafeLogger } from "../logger";
import type { UserStory } from "../prd";
import type { CompleteOperation } from "./types";

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _decomposeOpDeps = {
  getSafeLogger,
};

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
    const agentRouting = ctx.config.routing?.agents;
    const profiles = agentRouting?.enabled === true ? (agentRouting.profiles ?? []) : [];
    const prompt = buildDecomposePromptSync({
      specContent: input.specContent,
      codebaseContext: input.codebaseContext,
      targetStory: input.targetStory,
      siblings: input.siblings,
      maxAcCount: input.maxAcCount,
      profiles,
    });

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

    const defaultProfile = agentRouting.default ? profiles.find((p) => p.id === agentRouting.default) : undefined;

    return stories.map((story) => {
      if (story.agentProfileId) {
        const profile = profiles.find((p) => p.id === story.agentProfileId);
        if (profile) {
          return {
            ...story,
            routing: {
              ...story.routing,
              agent: profile.target.agent,
              agentProfileId: profile.id,
              profileModelTier: profile.target.model,
            },
          };
        }
        // Delta C3: never invent an agent — warn and fall through to the default profile.
        _decomposeOpDeps
          .getSafeLogger()
          ?.warn(
            "decompose",
            `Story ${story.id} selected unknown agent profile "${story.agentProfileId}" — falling back to ${defaultProfile ? `default profile "${defaultProfile.id}"` : "no profile"}`,
            { storyId: story.id, agentProfileId: story.agentProfileId },
          );
      }

      // No valid per-story selection — apply default profile if configured
      if (defaultProfile) {
        return {
          ...story,
          routing: {
            ...story.routing,
            agent: defaultProfile.target.agent,
            agentProfileId: defaultProfile.id,
            profileModelTier: defaultProfile.target.model,
          },
        };
      }

      return story;
    });
  },
};
