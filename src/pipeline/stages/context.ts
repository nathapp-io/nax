/**
 * Context Stage
 *
 * Builds contextual information for the agent from the PRD and related stories.
 * After building core context, calls plugin context providers to inject external data.
 * Formats as markdown for inclusion in the prompt.
 *
 * Phase 0 — v2 path:
 *   When config.context.v2.enabled is true, delegates to ContextOrchestrator.assemble()
 *   and stores the result in ctx.contextBundle.  Prompt builders read
 *   bundle.pushMarkdown instead of ctx.featureContextMarkdown.
 *   v1 code path runs unchanged when v2 is disabled (default).
 *
 * @returns
 * - `continue`: Always continues (soft failure if context empty)
 */

import { FeatureContextProvider } from "../../context/providers/feature-context";
import type { ContextElement } from "../../context/types";
import { createDefaultOrchestrator } from "../../context/v2";
import type { ContextRequest } from "../../context/v2";
import { buildStoryContextFullFromCtx } from "../../execution/helpers";
import { getLogger } from "../../logger";
import { errorMessage } from "../../utils/errors";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps (for testing)
// ─────────────────────────────────────────────────────────────────────────────

export const _contextStageDeps = {
  createOrchestrator: createDefaultOrchestrator,
  v1FeatureProvider: () => new FeatureContextProvider(),
};

// ─────────────────────────────────────────────────────────────────────────────
// v2 path
// ─────────────────────────────────────────────────────────────────────────────

async function runV2Path(ctx: PipelineContext): Promise<void> {
  const logger = getLogger();

  const request: ContextRequest = {
    storyId: ctx.story.id,
    // Trim trailing slash before taking the last path segment so
    // "/features/my-feature/" resolves to "my-feature" not "".
    featureId: ctx.featureDir?.replace(/\/$/, "").split("/").pop(),
    workdir: ctx.workdir,
    stage: "context", // initial assembly; execution stage overrides to "execution"
    role: "implementer",
    budgetTokens: ctx.config.context.featureEngine?.budgetTokens ?? 8_000,
    minScore: ctx.config.context.v2?.minScore,
    priorStageDigest: undefined,
  };

  try {
    const orchestrator = _contextStageDeps.createOrchestrator(ctx.story, ctx.config);
    const bundle = await orchestrator.assemble(request);

    ctx.contextBundle = bundle;

    // v1 compat shim: populate featureContextMarkdown from bundle so existing
    // prompt builders that read ctx.featureContextMarkdown still work.
    // Phase 0: .context(bundle.pushMarkdown) adapter in builders (AC-5).
    if (bundle.pushMarkdown) {
      ctx.featureContextMarkdown = bundle.pushMarkdown;
    }

    logger.info("context", "v2 context bundle assembled", {
      storyId: ctx.story.id,
      includedChunks: bundle.manifest.includedChunks.length,
      usedTokens: bundle.manifest.usedTokens,
      buildMs: bundle.manifest.buildMs,
    });
  } catch (err) {
    // Soft failure — v2 context is not required for agent to proceed
    logger.warn("context", "v2 orchestrator failed — proceeding without v2 context", {
      storyId: ctx.story.id,
      error: errorMessage(err),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v1 path (unchanged from before)
// ─────────────────────────────────────────────────────────────────────────────

async function runV1Path(ctx: PipelineContext): Promise<void> {
  const logger = getLogger();

  // Build context from PRD with element-level tracking
  const result = await buildStoryContextFullFromCtx(ctx);

  // SOFT FAILURE: Empty context is acceptable — agent can work without PRD context
  if (result) {
    ctx.contextMarkdown = result.markdown;
    ctx.builtContext = result.builtContext;
  } else {
    ctx.contextMarkdown = ctx.contextMarkdown || "";
  }

  // Plugin context providers
  if (ctx.plugins) {
    const providers = ctx.plugins.getContextProviders();
    if (providers.length > 0) {
      logger.info("context", `Running ${providers.length} plugin context provider(s)`, { storyId: ctx.story.id });

      const pluginElements: ContextElement[] = [];
      let pluginTokensUsed = 0;
      const tokenBudget = ctx.config.execution.contextProviderTokenBudget;

      for (const provider of providers) {
        if (pluginTokensUsed >= tokenBudget) {
          logger.info("context", "Plugin context budget exhausted, skipping remaining providers", {
            storyId: ctx.story.id,
          });
          break;
        }

        try {
          logger.info("context", `Fetching context from plugin: ${provider.name}`, { storyId: ctx.story.id });
          const providerResult = await provider.getContext(ctx.story);

          if (pluginTokensUsed + providerResult.estimatedTokens > tokenBudget) {
            logger.info("context", `Skipping plugin ${provider.name}: would exceed budget`, {
              storyId: ctx.story.id,
            });
            break;
          }

          pluginElements.push({
            type: "file",
            content: `## ${providerResult.label}\n\n${providerResult.content}`,
            priority: 50,
            tokens: providerResult.estimatedTokens,
          });

          pluginTokensUsed += providerResult.estimatedTokens;
          logger.info(
            "context",
            `Added context from plugin ${provider.name} (${providerResult.estimatedTokens} tokens)`,
            { storyId: ctx.story.id },
          );
        } catch (error) {
          logger.error("context", `Plugin context provider error: ${provider.name}`, {
            storyId: ctx.story.id,
            error: errorMessage(error),
          });
        }
      }

      if (pluginElements.length > 0) {
        const pluginMarkdown = pluginElements.map((el) => el.content).join("\n\n");
        ctx.contextMarkdown = ctx.contextMarkdown ? `${ctx.contextMarkdown}\n\n${pluginMarkdown}` : pluginMarkdown;

        if (ctx.builtContext) {
          ctx.builtContext.elements.push(...pluginElements);
          ctx.builtContext.totalTokens += pluginTokensUsed;
        }

        logger.info(
          "context",
          `Added ${pluginElements.length} plugin context element(s) (${pluginTokensUsed} tokens total)`,
          { storyId: ctx.story.id },
        );
      }
    }
  }

  // Feature context engine (v1 read path)
  const featureContextProvider = _contextStageDeps.v1FeatureProvider();
  const featureResult = await featureContextProvider.getContext(ctx.story, ctx.workdir, ctx.config);
  if (featureResult) {
    ctx.featureContextMarkdown = featureResult.content;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────────

export const contextStage: PipelineStage = {
  name: "context",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    if (ctx.config.context.v2?.enabled) {
      await runV2Path(ctx);
    } else {
      await runV1Path(ctx);
    }

    return { action: "continue" };
  },
};
