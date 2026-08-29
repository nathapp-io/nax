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
import { featureDir } from "@/config";
import { FeatureContextProvider } from "@/context";
import {
  type ContextRequest,
  createDefaultOrchestrator,
  createRunCallCounter,
  deriveProviderWeights,
  estimateAvailableBudgetTokens,
  getStageContextConfig,
  type IContextProvider,
  loadFeatureManifests,
  loadPluginProviders,
  NeutralityLintError,
  writeContextManifest,
} from "@/context/engine";
import type { ContextElement } from "@/context/types";
import { NaxError } from "@/errors";
// Sub-barrel import (not the `@/execution` barrel): routing through it closes
// a 12-hop pipeline -> execution loop. `helpers` is its own nested barrel, so
// this reaches it without loading `src/execution/index.ts`.
import { buildStoryContextFullFromCtx } from "@/execution/helpers";
import { getLogger } from "@/logger";
import { getContextFiles } from "@/prd";
import { readDigestFile, writeDigestFile } from "@/session";
import { resolveTestFilePatterns } from "@/test-runners";
import { errorMessage } from "@/utils/errors";
import { packageDirRelative } from "@/utils/paths";
import { resolveScopeFiles } from "../scope-files";
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
  // US-004: V2 stage derives per-provider weights from the current feature's
  // stored manifests before calling the orchestrator. Injectable so tests can
  // stub both functions without touching the disk or the real implementation.
  loadFeatureManifests,
  deriveProviderWeights,
};

// ─────────────────────────────────────────────────────────────────────────────
// v2 path
// ─────────────────────────────────────────────────────────────────────────────

async function runV2Path(ctx: PipelineContext): Promise<void> {
  const logger = getLogger();
  const agentName = ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? "claude";

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
      ctx.sessionScratchDir = join(featureDir(ctx.projectDir, featureId), "sessions", sessionId);
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

  // Resolve the complete evidence set of files a story touches for SCOPING
  // decisions — never throws (fails open to declared sources). Cached on ctx
  // so the prompt stage reuses this result instead of re-resolving.
  const scopeFiles = await resolveScopeFiles(ctx);
  ctx.scopeFiles = scopeFiles;

  // ADR-009 SSOT: resolve test-file patterns once per request and thread them
  // through so providers never classify test files via inline regex.
  // Failure is non-fatal — providers degrade by skipping sibling-test hinting.
  let resolvedTestPatterns: import("@/test-runners").ResolvedTestPatterns | undefined;
  try {
    // Anchors must match routing.ts:113-115 — resolveTestFilePatterns takes the
    // absolute project ROOT plus a package path RELATIVE to it. In monorepo mode
    // ctx.workdir is already join(projectDir, story.workdir), so passing it as the
    // root together with story.workdir doubles the package segment: the per-package
    // .nax/mono/<pkg>/config.json lookup misses and detection scans a path that does
    // not exist, silently falling through to DEFAULT_TEST_FILE_PATTERNS.
    const root = ctx.projectDir ?? ctx.workdir;
    resolvedTestPatterns = await resolveTestFilePatterns(ctx.config, root, packageDirRelative(root, ctx.workdir), {
      storyId: ctx.story.id,
    });
  } catch (err) {
    logger.warn("context", "Failed to resolve test-file patterns — providers will skip sibling-test hints", {
      storyId: ctx.story.id,
      error: errorMessage(err),
    });
  }
  // Publish onto the pipeline context so later assemblies via assembleForStage
  // (today the batch / no-test / single-session execution bundles built by
  // promptStage) reuse this resolution instead of skipping sibling-test hinting
  // or repeating the I/O.
  if (resolvedTestPatterns) ctx.resolvedTestPatterns = resolvedTestPatterns;

  // Honour the per-stage v2 config for this stage exactly as assembleForStage
  // does. Without this, `v2.stages.context.budgetTokens` and `extraProviderIds`
  // were inert on the first — and largest — assembly of every story.
  const stageOverrides = ctx.config.context?.v2?.stages?.context;

  const request: ContextRequest = {
    storyId: ctx.story.id,
    // Trim trailing slash before taking the last path segment so
    // "/features/my-feature/" resolves to "my-feature" not "".
    featureId: ctx.featureDir?.replace(/\/$/, "").split("/").pop(),
    repoRoot: ctx.projectDir,
    packageDir: ctx.workdir,
    stage: "context", // initial assembly; promptStage overrides to the strategy stage (single-session / tdd-simple / no-test / batch)
    role: "implementer",
    budgetTokens: stageOverrides?.budgetTokens ?? ctx.config.context.featureEngine?.budgetTokens ?? 8_000,
    extraProviderIds: stageOverrides?.extraProviderIds ?? [],
    minScore: ctx.config.context.v2.minScore,
    // Per-stage override wins, then the engine-wide key; absent leaves the
    // orchestrator's own default in place.
    ...((stageOverrides?.providerTimeoutMs ?? ctx.config.context.v2.providerTimeoutMs) !== undefined && {
      providerTimeoutMs: stageOverrides?.providerTimeoutMs ?? ctx.config.context.v2.providerTimeoutMs,
    }),
    storyScratchDirs,
    priorStageDigest,
    ...(touchedFiles.length > 0 && { touchedFiles }),
    ...(scopeFiles.length > 0 && { scopeFiles }),
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
    // Same .naxignore index the verify/review paths already honour — without it
    // the neighbour scan walks user-ignored files and session-scratch re-reads
    // patterns from disk on every fetch.
    ...(ctx.naxIgnoreIndex && { naxIgnoreIndex: ctx.naxIgnoreIndex }),
  };

  // US-004: derive per-provider effectiveness weights from the current feature's
  // stored manifests. loadFeatureManifests reads `.nax/features/<featureId>/stories/*`
  // off disk; deriveProviderWeights aggregates ignored-verdict ratios per provider.
  // Best-effort: a throw or empty result keeps the request as-is and the scorer
  // behaves as if no weights were supplied (identity = 1.0 for every provider).
  // Runs unconditionally on V2 — same "_unattached" sentinel used for
  // sessionScratchDir above when ctx.featureDir is absent, so unattached runs
  // still derive weights instead of silently skipping this step.
  // When ctx.providerWeightsCache is present (full runner path), reuse the
  // per-run cache instead of re-reading and re-parsing every manifest in the
  // feature on every story's context stage.
  const providerWeightsFeatureId = request.featureId ?? "_unattached";
  try {
    request.providerWeights = ctx.providerWeightsCache
      ? await ctx.providerWeightsCache.loadOrGet(providerWeightsFeatureId, ctx.projectDir ?? ctx.workdir)
      : _contextStageDeps.deriveProviderWeights(
          (
            await _contextStageDeps.loadFeatureManifests({
              featureId: providerWeightsFeatureId,
              projectDir: ctx.projectDir ?? ctx.workdir,
            })
          ).map((s) => s.manifest),
        );
  } catch (err) {
    logger.warn("context", "Failed to derive provider weights — continuing without them", {
      storyId: ctx.story.id,
      error: errorMessage(err),
    });
  }

  // Phase 7: load any plugin providers (RAG, graph, KB) configured for this project.
  // Non-fatal: failures are logged inside loadPluginProviders and skipped.
  // Defensive fallback: test fixtures may bypass Zod and omit `pluginProviders`.
  // In production configs this is always present (required by schema, defaults to []).
  // When ctx.pluginProviderCache is present (full runner path), reuse cached instances
  // across assemble() calls instead of re-importing on every stage invocation.
  const pluginConfigs = ctx.config.context.v2.pluginProviders ?? [];
  const pluginProviders: IContextProvider[] =
    pluginConfigs.length > 0
      ? ctx.pluginProviderCache
        ? await ctx.pluginProviderCache.loadOrGet(pluginConfigs, ctx.projectDir ?? ctx.workdir)
        : await _contextStageDeps.loadPlugins(pluginConfigs, ctx.projectDir ?? ctx.workdir)
      : [];

  try {
    const orchestrator = _contextStageDeps.createOrchestrator(ctx.story, ctx.config, storyScratchDirs, pluginProviders);
    const bundle = await orchestrator.assemble(request);

    ctx.contextBundle = bundle;
    if (ctx.prd.feature) {
      await writeContextManifest(ctx.projectDir, ctx.prd.feature, ctx.story.id, "context", bundle.manifest);
      ctx.providerWeightsCache?.invalidate(ctx.prd.feature);
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
    if (err instanceof NeutralityLintError) {
      // The canonical rules store failed neutrality lint. Proceeding with v2
      // enabled but zero rules chunks is a silent fail-open — fall back to
      // the v1 path (reads CLAUDE.md / .nax/context.md directly, unaffected
      // by this specific failure) so the story still gets SOME grounding
      // content instead of none. See IContextProvider.fetch (types.ts).
      logger.error("context", "Canonical rules failed neutrality lint — falling back to v1 context", {
        storyId: ctx.story.id,
        error: errorMessage(err),
      });
      await runV1Path(ctx);
      return;
    }

    // A typo in v2.stages.context.extraProviderIds is a config error, not a
    // runtime hiccup — fail closed exactly as assembleForStage does
    // (stage-assembler.ts). Swallowing it here would silently drop v2 context
    // for the whole story on strategies where promptStage never re-assembles,
    // contradicting the documented "typos surface immediately" contract.
    if (err instanceof NaxError && err.code === "CONTEXT_UNKNOWN_PROVIDER_IDS") {
      throw err;
    }

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
