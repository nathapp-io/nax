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
import { NaxError } from "../../errors";
import { getLogger } from "../../logger";
import type { PipelineContext } from "../../pipeline/types";
import { getContextFiles } from "../../prd/types";
import { errorMessage } from "../../utils/errors";
import { estimateAvailableBudgetTokens } from "./available-budget";
import { writeContextManifest } from "./manifest-store";
import { createDefaultOrchestrator } from "./orchestrator-factory";
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
};

export interface StageAssembleOptions {
  priorStageDigest?: string;
  storyScratchDirs?: string[];
  touchedFiles?: string[];
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
  const sessionsRoot = join(projectDir, ".nax", "features", featureName, "sessions");

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
      storyScratchDirs,
      priorStageDigest: options.priorStageDigest ?? ctx.contextBundle?.digest,
      minScore: ctx.config.context.v2.minScore,
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
    };

    const bundle = await orchestrator.assemble(request);
    if (ctx.projectDir && ctx.prd.feature) {
      await writeContextManifest(ctx.projectDir, ctx.prd.feature, ctx.story.id, stage, bundle.manifest);
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
