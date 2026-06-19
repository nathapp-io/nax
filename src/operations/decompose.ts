import { buildDecomposePromptSync } from "@/prompts";
import { parseDecomposeOutput } from "../agents/shared/decompose";
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
    // ADR-025: decompose inherits the parent's agent assignment; capability cards are not injected.
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
  parse(output, _input, _ctx) {
    // ADR-025: agent assignment is not re-selected here — the decompose command
    // passes parentRouting directly to mapDecomposedStoriesToUserStories for inheritance.
    return parseDecomposeOutput(output);
  },
};
