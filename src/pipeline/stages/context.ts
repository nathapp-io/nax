/**
 * Context Stage
 *
 * Builds contextual information for the agent from the PRD and related stories.
 * Formats as markdown for inclusion in the prompt.
 *
 * @returns
 * - `continue`: Always continues (soft failure if context empty)
 *
 * @example
 * ```ts
 * // PRD has related stories with context
 * await contextStage.execute(ctx);
 * // ctx.contextMarkdown: "## Related Stories\n- US-001: ..."
 *
 * // No related context found
 * await contextStage.execute(ctx);
 * // ctx.contextMarkdown: "" (empty but continues)
 * ```
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

    // SOFT FAILURE: Empty context is acceptable — agent can work without PRD context
    // This happens when no relevant stories/context is found, which is normal
    ctx.contextMarkdown = contextMarkdown;

    return { action: "continue" };
  },
};
