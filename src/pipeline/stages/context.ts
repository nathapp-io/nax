/**
 * Context Stage
 *
 * Builds contextual information for the agent from the PRD and related stories.
 * Formats as markdown for inclusion in the prompt.
 */

import type { PipelineStage, PipelineContext, StageResult } from "../types";
import { maybeGetContext } from "../../execution/helpers";

export const contextStage: PipelineStage = {
  name: "context",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    // Build context from PRD (if enabled in config/options)
    const contextMarkdown = await maybeGetContext(
      ctx.prd,
      ctx.story,
      ctx.config,
      true, // useContext - can be made configurable later
    );

    ctx.contextMarkdown = contextMarkdown;

    return { action: "continue" };
  },
};
