/**
 * Context Engine — Stage Assembler Helpers (Phase B)
 *
 * Provides per-stage bundle assembly for pipeline stages that need
 * stage-specific context (execution, TDD, review) rather than reusing
 * the context-stage bundle.
 *
 * assembleForStage() calls assemble() with stage-specific provider/budget/role
 * config from STAGE_CONTEXT_MAP, addressing branch-review Finding 1.
 *
 * getBundleMarkdown() returns the v2 bundle's pushMarkdown directly (no v1 role
 * filter applied), addressing branch-review Finding 2.
 *
 * See: docs/reviews/context-engine-v2-branch-review.md §1, §2
 */

import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { featureDir } from "@/config";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import type { PipelineContext } from "@/pipeline/types";
import { getContextFiles } from "@/prd";
import { errorMessage } from "@/utils/errors";
import { estimateAvailableBudgetTokens } from "./available-budget";
import { loadFeatureManifests, writeContextManifest } from "./manifest-store";
import { createDefaultOrchestrator } from "./orchestrator-factory";
import { deriveProviderWeights } from "./provider-weights";
import { loadPluginProviders } from "./providers/plugin-loader";
import { getStageContextConfig } from "./stage-config";
import type { ContextBundle, ContextRequest } from "./types";

/**
 * Disk-discovery TTL. Matches DEFAULT_ORPHAN_TTL_MS in SessionManager so the
 * two cleanup/aging concepts stay aligned. Descriptors older than this are
 * ignored — prevents stale scratch from long-past runs contaminating context.
 */
const DISK_DISCOVERY_TTL_MS = 4 * 60 * 60 * 1000;

export const _stageAssemblerDeps = {
  readdir: (path: string): Promise<string[]> => readdir(path),
  readDescriptor: async (path: string): Promise<unknown> => {
    const f = Bun.file(path);
    if (!(await f.exists())) return null;
    return f.json();
  },
  now: (): number => Date.now(),
  createOrchestrator: createDefaultOrchestrator,
  // Mirrors _contextStageDeps in pipeline/stages/context.ts — the context stage's
  // own ContextRequest is not the only one scored. assembleForStage() builds a
  // fresh request per stage (execution, rectify, tdd-*, review-*) and must derive
  // the same per-provider effectiveness weights or the learned multiplier never
  // reaches the bundle that actually becomes the agent's prompt.
  loadFeatureManifests,
  deriveProviderWeights,
};

export interface StageAssembleOptions {
  priorStageDigest?: string;
  storyScratchDirs?: string[];
  touchedFiles?: string[];
  /**
   * Complete evidence-set of files a story touches for SCOPING only.
   * Resolved by `resolveScopeFiles(ctx)` upstream and threaded through
   * unchanged — `assembleForStage()` does not resolve this itself.
   */
  scopeFiles?: string[];
}

function dedupeScratchDirs(dirs: Array<string | undefined>): string[] {
  return [...new Set(dirs.filter((dir): dir is string => Boolean(dir)))];
}

function toAbsolutePath(projectDir: string, pathValue: string): string {
  return isAbsolute(pathValue) ? pathValue : resolve(projectDir, pathValue);
}

/**
 * Enumerate on-disk session descriptors for the given feature and return
 * scratch-dir paths belonging to the given story, filtered by TTL.
 * Best-effort: any I/O or parse failure on one descriptor is logged and skipped,
 * never propagated. Returns [] when the sessions directory does not exist.
 */
export async function discoverSessionScratchDirsOnDisk(
  projectDir: string,
  featureName: string,
  storyId: string,
  ttlMs: number,
): Promise<string[]> {
  const logger = getLogger();
  const sessionsRoot = join(featureDir(projectDir, featureName), "sessions");

  let entries: string[];
  try {
    entries = await _stageAssemblerDeps.readdir(sessionsRoot);
  } catch {
    // Sessions directory does not exist yet — first run of this feature.
    return [];
  }

  const cutoff = _stageAssemblerDeps.now() - ttlMs;
  const found: string[] = [];

  for (const entry of entries) {
    const descriptorPath = join(sessionsRoot, entry, "descriptor.json");
    try {
      const parsed = (await _stageAssemblerDeps.readDescriptor(descriptorPath)) as {
        storyId?: string;
        scratchDir?: string;
        lastActivityAt?: string;
      } | null;

      if (!parsed || parsed.storyId !== storyId || !parsed.scratchDir) continue;

      const activity = parsed.lastActivityAt ? Date.parse(parsed.lastActivityAt) : Number.NaN;
      if (Number.isNaN(activity) || activity < cutoff) continue;

      found.push(toAbsolutePath(projectDir, parsed.scratchDir));
    } catch (err) {
      logger.debug("context-v2", "Skipped malformed session descriptor", {
        storyId,
        descriptorPath,
        error: errorMessage(err),
      });
    }
  }

  return found;
}

async function getStoryScratchDirs(ctx: PipelineContext, options: StageAssembleOptions): Promise<string[]> {
  if (options.storyScratchDirs) {
    return dedupeScratchDirs(options.storyScratchDirs);
  }

  const managerDirs =
    ctx.sessionManager
      ?.getForStory(ctx.story.id)
      .flatMap((session) => (session.scratchDir ? [session.scratchDir] : [])) ?? [];

  const diskDirs =
    ctx.projectDir && ctx.prd.feature
      ? await discoverSessionScratchDirsOnDisk(ctx.projectDir, ctx.prd.feature, ctx.story.id, DISK_DISCOVERY_TTL_MS)
      : [];

  return dedupeScratchDirs([ctx.sessionScratchDir, ...managerDirs, ...diskDirs]);
}

/**
 * Assemble a fresh ContextBundle for the given pipeline stage.
 *
 * Returns null when:
 * - config.context.v2.enabled is false (v1 path is active), or
 * - orchestrator.assemble() throws (provider error, etc.)
 *
 * Callers fall back to featureContextMarkdown when null is returned.
 */
export async function assembleForStage(
  ctx: PipelineContext,
  stage: string,
  options: StageAssembleOptions = {},
): Promise<ContextBundle | null> {
  // Defensive check: test fixtures may bypass Zod and omit `context.v2`.
  if (!ctx.config.context?.v2?.enabled) return null;

  const stageConfig = getStageContextConfig(stage);
  const logger = getLogger();

  try {
    // Defensive check: test fixtures may bypass Zod and omit `pluginProviders`.
    const pluginConfigs = ctx.config.context.v2.pluginProviders ?? [];
    // When ctx.pluginProviderCache is present (full runner path), reuse cached instances
    // across assemble() calls. Fall back to a fresh load when the cache is absent
    // (test fixtures and paths that don't wire the full runner).
    const pluginProviders =
      pluginConfigs.length > 0
        ? ctx.pluginProviderCache
          ? await ctx.pluginProviderCache.loadOrGet(pluginConfigs, ctx.projectDir)
          : await loadPluginProviders(pluginConfigs, ctx.projectDir)
        : [];
    const storyScratchDirs = await getStoryScratchDirs(ctx, options);
    // US-005: publish the resolved dirs so the pull-tool runtime (query_scratch)
    // reads the same set the push providers read, not just ctx.sessionScratchDir.
    ctx.storyScratchDirs = storyScratchDirs;

    const orchestrator = _stageAssemblerDeps.createOrchestrator(
      ctx.story,
      ctx.config,
      storyScratchDirs,
      pluginProviders,
    );

    // AC-54: resolve dual workdir fields. repoRoot is the project root (where .nax/ lives);
    // packageDir is the story's package directory (equals repoRoot for non-monorepo).
    // iteration-runner.ts already resolves ctx.workdir to the package dir (join(repoRoot, story.workdir));
    // do not re-join story.workdir here or the path will be doubled in monorepo mode.
    const targetAgentId = ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? "claude";

    const stageOverrides = ctx.config.context?.v2?.stages?.[stage];
    const request: ContextRequest = {
      storyId: ctx.story.id,
      featureId: ctx.prd.feature,
      repoRoot: ctx.projectDir,
      packageDir: ctx.workdir,
      stage,
      role: stageConfig.role,
      // AC-59: per-package stage budget — reads from ctx.config which is already the
      // merged config (root + <repoRoot>/.nax/mono/<packageDir>/config.json overlay).
      budgetTokens: stageOverrides?.budgetTokens ?? stageConfig.budgetTokens,
      extraProviderIds: stageOverrides?.extraProviderIds ?? [],
      touchedFiles: options.touchedFiles ?? getContextFiles(ctx.story),
      ...(options.scopeFiles !== undefined && { scopeFiles: options.scopeFiles }),
      storyScratchDirs,
      priorStageDigest: options.priorStageDigest ?? ctx.contextBundle?.digest,
      minScore: ctx.config.context.v2.minScore,
      ...((stageOverrides?.providerTimeoutMs ?? ctx.config.context?.v2?.providerTimeoutMs) !== undefined && {
        providerTimeoutMs: stageOverrides?.providerTimeoutMs ?? ctx.config.context?.v2?.providerTimeoutMs,
      }),
      pullConfig: ctx.config.context.v2.pull
        ? {
            enabled: ctx.config.context.v2.pull.enabled,
            allowedTools: ctx.config.context.v2.pull.allowedTools,
            maxCallsPerSession: ctx.config.context.v2.pull.maxCallsPerSession,
          }
        : undefined,
      sessionId: ctx.sessionId,
      agentId: targetAgentId,
      availableBudgetTokens: estimateAvailableBudgetTokens(targetAgentId, ctx.prompt),
      // AC-24: propagate determinism flag to every assembled stage, not just the context stage.
      deterministic: ctx.config.context.v2.deterministic,
      // AC-51: propagate planDigestBoost from the routing test strategy so the boost applies
      // in every stage that assembleForStage() serves (execution, rectify, tdd-*, review-*, etc.).
      planDigestBoost: getStageContextConfig(ctx.routing?.testStrategy ?? "").planDigestBoost,
      // ADR-009 SSOT: forward the test-file patterns the context stage resolved so
      // CodeNeighborProvider can hint sibling tests here too. Only the context
      // stage set them before, so every bundle assembled here — today the
      // batch / no-test / single-session execution bundles built by
      // prompt.ts, the sole caller — silently skipped sibling-test hinting.
      ...(ctx.resolvedTestPatterns && { resolvedTestPatterns: ctx.resolvedTestPatterns }),
      // Forward the run-scoped .naxignore index so user-ignored paths are excluded
      // from the reverse-dep scan and the session-scratch read, as they already are
      // on the verify/review paths.
      ...(ctx.naxIgnoreIndex && { naxIgnoreIndex: ctx.naxIgnoreIndex }),
    };

    // US-004 follow-up: derive per-provider effectiveness weights the same way
    // the context stage does (src/pipeline/stages/context.ts), so every stage
    // assembled here — execution, rectify, tdd, review — scores against the
    // learned multiplier instead of silently reverting to identity (1.0).
    // Best-effort: a throw or empty result leaves the request as-is. When
    // ctx.providerWeightsCache is present (full runner path), reuse the
    // per-run cache instead of re-reading and re-parsing every manifest in
    // the feature on every stage assembly.
    const providerWeightsFeatureId = request.featureId ?? "_unattached";
    try {
      request.providerWeights = ctx.providerWeightsCache
        ? await ctx.providerWeightsCache.loadOrGet(providerWeightsFeatureId, ctx.projectDir ?? ctx.workdir)
        : await _stageAssemblerDeps.deriveProviderWeights(
            (
              await _stageAssemblerDeps.loadFeatureManifests({
                featureId: providerWeightsFeatureId,
                projectDir: ctx.projectDir ?? ctx.workdir,
              })
            ).map((s) => s.manifest),
          );
    } catch (err) {
      logger.warn("context-v2", "Failed to derive provider weights — continuing without them", {
        storyId: ctx.story.id,
        error: errorMessage(err),
      });
    }

    const bundle = await orchestrator.assemble(request);
    if (ctx.projectDir && ctx.prd.feature) {
      await writeContextManifest(ctx.projectDir, ctx.prd.feature, ctx.story.id, stage, bundle.manifest);
      ctx.providerWeightsCache?.invalidate(ctx.prd.feature);
    }
    return bundle;
  } catch (err) {
    if (err instanceof NaxError && err.code === "CONTEXT_UNKNOWN_PROVIDER_IDS") {
      throw err;
    }
    logger.warn("context-v2", `assembleForStage failed for stage "${stage}"`, {
      storyId: ctx.story.id,
      error: errorMessage(err),
    });
    return null;
  }
}

/**
 * Return the push markdown for a bundle, or fall back to ctx.featureContextMarkdown.
 *
 * When a v2 bundle is present its pushMarkdown is returned directly — the orchestrator
 * already applied role filtering, dedup, and budget packing, so no additional
 * v1-style filterContextByRole() pass is needed or wanted.
 */
export function getBundleMarkdown(ctx: PipelineContext, bundle: ContextBundle | null | undefined): string {
  if (bundle) return bundle.pushMarkdown;
  return ctx.featureContextMarkdown ?? "";
}
