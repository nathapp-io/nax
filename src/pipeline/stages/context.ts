/**
 * Context Stage
 *
 * Builds contextual information for the agent from the PRD and related stories.
 * After building core context, calls plugin context providers to inject external data.
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

import { join } from "node:path";
import type { ContextElement } from "../../context/types";
import { buildStoryContextFull } from "../../execution/helpers";
import { getLogger } from "../../logger";
import { errorMessage } from "../../utils/errors";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const contextStage: PipelineStage = {
  name: "context",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // MW-003: resolve package workdir for per-package context.md loading
    const packageWorkdir = ctx.story.workdir ? join(ctx.workdir, ctx.story.workdir) : undefined;

    // Build context from PRD with element-level tracking
    const result = await buildStoryContextFull(ctx.prd, ctx.story, ctx.config, packageWorkdir);

    // SOFT FAILURE: Empty context is acceptable — agent can work without PRD context
    // This happens when no relevant stories/context is found, which is normal
    if (result) {
      ctx.contextMarkdown = result.markdown;
      ctx.builtContext = result.builtContext;
    } else {
      // Initialize contextMarkdown to empty string if no PRD context was built
      ctx.contextMarkdown = ctx.contextMarkdown || "";
    }

    // Add plugin context if any providers are registered
    if (ctx.plugins) {
      const providers = ctx.plugins.getContextProviders();
      if (providers.length > 0) {
        logger.info("context", `Running ${providers.length} plugin context provider(s)`);

        const pluginElements: ContextElement[] = [];
        let pluginTokensUsed = 0;
        const tokenBudget = ctx.config.execution.contextProviderTokenBudget;

        for (const provider of providers) {
          // Check if we have budget remaining
          if (pluginTokensUsed >= tokenBudget) {
            logger.info("context", "Plugin context budget exhausted, skipping remaining providers");
            break;
          }

          try {
            logger.info("context", `Fetching context from plugin: ${provider.name}`);
            const providerResult = await provider.getContext(ctx.story);

            // Check if adding this provider's content would exceed budget
            if (pluginTokensUsed + providerResult.estimatedTokens > tokenBudget) {
              logger.info("context", `Skipping plugin ${provider.name}: would exceed budget`);
              break;
            }

            // Add plugin context as a new element
            pluginElements.push({
              type: "file", // Reuse file type for external context
              content: `## ${providerResult.label}\n\n${providerResult.content}`,
              priority: 50, // Medium priority (between dependencies and errors)
              tokens: providerResult.estimatedTokens,
            });

            pluginTokensUsed += providerResult.estimatedTokens;
            logger.info(
              "context",
              `Added context from plugin ${provider.name} (${providerResult.estimatedTokens} tokens)`,
            );
          } catch (error) {
            logger.error("context", `Plugin context provider error: ${provider.name}`, {
              error: errorMessage(error),
            });
            // Continue with other providers on error (soft failure)
          }
        }

        // Append plugin context to existing markdown
        if (pluginElements.length > 0) {
          const pluginMarkdown = pluginElements.map((el) => el.content).join("\n\n");
          ctx.contextMarkdown = ctx.contextMarkdown ? `${ctx.contextMarkdown}\n\n${pluginMarkdown}` : pluginMarkdown;

          // Update built context with plugin elements
          if (ctx.builtContext) {
            ctx.builtContext.elements.push(...pluginElements);
            ctx.builtContext.totalTokens += pluginTokensUsed;
          }

          logger.info(
            "context",
            `Added ${pluginElements.length} plugin context element(s) (${pluginTokensUsed} tokens total)`,
          );
        }
      }
    }

    return { action: "continue" };
  },
};
