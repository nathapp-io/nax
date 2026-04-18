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

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDefaultOrchestrator, createRunCallCounter } from "../../context/engine";
import type { ContextRequest, IContextProvider } from "../../context/engine";
import { estimateAvailableBudgetTokens } from "../../context/engine/available-budget";
import { writeContextManifest } from "../../context/engine/manifest-store";
import { loadPluginProviders } from "../../context/engine/providers/plugin-loader";
import { getStageContextConfig } from "../../context/engine/stage-config";
import { FeatureContextProvider } from "../../context/providers/feature-context";
import type { ContextElement } from "../../context/types";
import { buildStoryContextFullFromCtx } from "../../execution/helpers";
import { getLogger } from "../../logger";
import { getContextFiles } from "../../prd";
import { readDigestFile, writeDigestFile } from "../../session/scratch-writer";
import { resolveTestFilePatterns } from "../../test-runners/resolver";
import { errorMessage } from "../../utils/errors";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps (for testing)
// ─────────────────────────────────────────────────────────────────────────────

export const _contextStageDeps = {
  createOrchestrator: createDefaultOrchestrator,
  loadPlugins: loadPluginProviders,
  v1FeatureProvider: () => new FeatureContextProvider(),
  uuid: () => randomUUID(),
  readDigest: readDigestFile,
  writeDigest: writeDigestFile,
};

// ─────────────────────────────────────────────────────────────────────────────
// v2 path
// ─────────────────────────────────────────────────────────────────────────────

async function runV2Path(ctx: PipelineContext): Promise<void> {
  const logger = getLogger();
  const agentName =
    ctx.routing.agent ?? ctx.rootConfig?.autoMode?.defaultAgent ?? ctx.config.autoMode?.defaultAgent ?? "claude";

  // Derive the session scratch directory for this pipeline run.
  // ctx.sessionId is owned by this (context) stage — it pre-allocates a UUID
  // here so the scratch dir path is stable before the execution stage runs.
  // Phase 5.5 will migrate ownership to the SessionManager.
  if (!ctx.sessionScratchDir) {
    if (ctx.sessionManager && ctx.prd.feature) {
      const session = ctx.sessionManager.create({
        role: "implementer",
        agent: agentName,
        workdir: ctx.workdir,
        projectDir: ctx.projectDir,
        featureName: ctx.prd.feature,
        storyId: ctx.story.id,
      });
      ctx.sessionId = session.id;
      ctx.sessionScratchDir = session.scratchDir;
    } else {
      const sessionId = ctx.sessionId ?? _contextStageDeps.uuid();
      if (!ctx.sessionId) ctx.sessionId = sessionId;
      const featureId = ctx.featureDir?.replace(/\/$/, "").split("/").pop() ?? "_unattached";
      ctx.sessionScratchDir = `${ctx.projectDir}/.nax/features/${featureId}/sessions/${sessionId}`;
    }
  }
  if (!ctx.contextToolRunCounter) {
    ctx.contextToolRunCounter = createRunCallCounter();
  }

  // ctx.sessionScratchDir is guaranteed set by the block above.
  const storyScratchDirs = ctx.sessionScratchDir ? [ctx.sessionScratchDir] : [];

  // Phase 2: read prior digest for progressive context threading.
  // On first run the file is absent → "". On retry (after rectify) or crash
  // resume, the file contains the previous assembly's digest and is threaded
  // into the new request so the agent sees what context was previously built.
  let priorStageDigest: string | undefined;
  if (ctx.sessionScratchDir) {
    try {
      const raw = await _contextStageDeps.readDigest(ctx.sessionScratchDir, "context");
      priorStageDigest = raw || undefined;
    } catch (err) {
      logger.warn("context", "Failed to read prior digest — continuing without it", {
        storyId: ctx.story.id,
        error: errorMessage(err),
      });
    }
  }

  // Phase 3: derive files touched by this story for git history + neighbor providers.
  const touchedFiles = getContextFiles(ctx.story);

  // ADR-009 SSOT: resolve test-file patterns once per request and thread them
  // through so providers never classify test files via inline regex.
  // Failure is non-fatal — providers degrade by skipping sibling-test hinting.
  let resolvedTestPatterns: import("../../test-runners/resolver").ResolvedTestPatterns | undefined;
  try {
    resolvedTestPatterns = await resolveTestFilePatterns(ctx.config, ctx.workdir, ctx.story.workdir || undefined, {
      storyId: ctx.story.id,
    });
  } catch (err) {
    logger.warn("context", "Failed to resolve test-file patterns — providers will skip sibling-test hints", {
      storyId: ctx.story.id,
      error: errorMessage(err),
    });
  }

  const request: ContextRequest = {
    storyId: ctx.story.id,
    // Trim trailing slash before taking the last path segment so
    // "/features/my-feature/" resolves to "my-feature" not "".
    featureId: ctx.featureDir?.replace(/\/$/, "").split("/").pop(),
    repoRoot: ctx.workdir,
    packageDir: ctx.story.workdir ? join(ctx.workdir, ctx.story.workdir) : ctx.workdir,
    stage: "context", // initial assembly; execution stage overrides to "execution"
    role: "implementer",
    budgetTokens: ctx.config.context.featureEngine?.budgetTokens ?? 8_000,
    minScore: ctx.config.context.v2.minScore,
    storyScratchDirs,
    priorStageDigest,
    ...(touchedFiles.length > 0 && { touchedFiles }),
    // Defensive check: test fixtures may bypass Zod and omit `pull`.
    // In production configs this is always present (required by schema).
    pullConfig: ctx.config.context.v2.pull
      ? {
          enabled: ctx.config.context.v2.pull.enabled,
          allowedTools: ctx.config.context.v2.pull.allowedTools,
          maxCallsPerSession: ctx.config.context.v2.pull.maxCallsPerSession,
        }
      : undefined,
    sessionId: ctx.sessionId,
    agentId: agentName,
    availableBudgetTokens: estimateAvailableBudgetTokens(agentName, ctx.prompt),
    deterministic: ctx.config.context.v2.deterministic,
    // Amendment B AC-51: pass planDigestBoost from the routing strategy's stage config.
    // single-session, tdd-simple, no-test, and batch strategies declare planDigestBoost >= 1.5.
    planDigestBoost: getStageContextConfig(ctx.routing?.testStrategy ?? "").planDigestBoost,
    ...(resolvedTestPatterns && { resolvedTestPatterns }),
  };

  // Phase 7: load any plugin providers (RAG, graph, KB) configured for this project.
  // Non-fatal: failures are logged inside loadPluginProviders and skipped.
  // Defensive fallback: test fixtures may bypass Zod and omit `pluginProviders`.
  // In production configs this is always present (required by schema, defaults to []).
  const pluginConfigs = ctx.config.context.v2.pluginProviders ?? [];
  const pluginProviders: IContextProvider[] =
    pluginConfigs.length > 0 ? await _contextStageDeps.loadPlugins(pluginConfigs, ctx.projectDir ?? ctx.workdir) : [];

  try {
    const orchestrator = _contextStageDeps.createOrchestrator(ctx.story, ctx.config, storyScratchDirs, pluginProviders);
    const bundle = await orchestrator.assemble(request);

    ctx.contextBundle = bundle;
    if (ctx.prd.feature) {
      await writeContextManifest(ctx.projectDir, ctx.prd.feature, ctx.story.id, "context", bundle.manifest);
    }

    // Phase 2: persist digest for next pipeline pass or crash resume.
    // Best-effort: a failed write must not block stage execution.
    if (ctx.sessionScratchDir && bundle.digest) {
      try {
        await _contextStageDeps.writeDigest(ctx.sessionScratchDir, "context", bundle.digest);
      } catch (digestErr) {
        logger.warn("context", "Failed to persist context digest — non-fatal", {
          storyId: ctx.story.id,
          error: errorMessage(digestErr),
        });
      }
    }

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
    if (ctx.config.context.v2.enabled) {
      await runV2Path(ctx);
    } else {
      await runV1Path(ctx);
    }

    return { action: "continue" };
  },
};
