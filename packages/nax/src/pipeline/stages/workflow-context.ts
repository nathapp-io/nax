/**
 * Workflow context stage (US-004)
 *
 * The workflow pipeline builds its own prompts and carries feature context in
 * the brief, so it has no use for the v2 context engine's push bundle and none
 * at all for its pull tools — `query_neighbor`, `query_scratch` and
 * `query_feature_context` were called 0 times in 6,394 audited sessions. This
 * stage therefore keeps the one piece of the context stage workflow mode still
 * needs (the feature context markdown) and drops the orchestrator.
 *
 * Behaviour, in order:
 * 1. `context.v2.enabled` false, or `context.rules.delivery: "push"` — delegate
 *    to `contextStage` unchanged, v1 path included. Push mode is the
 *    pre-feature behaviour: the orchestrator carries every rule body.
 * 2. Otherwise allocate the story session through the shared
 *    `allocateStorySession` — workflow gates read `ctx.sessionScratchDir` and
 *    the metrics tracker reads `ctx.contextToolRunCounter`, and neither may
 *    regress because the orchestrator is gone.
 * 3. Fetch the feature chunks from `FeatureContextProviderV2` (the adapter
 *    around the v1 reader) and set `ctx.featureContextMarkdown` to their
 *    contents joined by a blank line, in returned order. No chunk ⇒ the field
 *    stays undefined. A throw is non-fatal: warn and continue with no feature
 *    context, exactly as `runV2Path` does.
 *
 * Deliberately NOT set here, and why:
 * - `ctx.contextBundle` — nothing in workflow mode reads it. Its absence also
 *   means the workflow's `CallContext`s carry no bundle, so an agent swap has
 *   nothing to rebuild (`swap-decision.ts` already tolerates that).
 * - `ctx.contextMarkdown` — story context, set only by `runV1Path`; workflow
 *   v2 runs have never had it.
 * - `ctx.scopeFiles` / `ctx.resolvedTestPatterns` — read only by pipeline-mode
 *   stages (`prompt.ts`, `execution.ts`, `stage-assembler.ts`); the workflow
 *   stage resolves its own test patterns from config.
 * - any manifest or digest — both exist to thread the orchestrator's own
 *   assemblies together.
 *
 * The `IContextProvider` contract says `fetch` must not throw, and
 * `FeatureContextProviderV2` already swallows its own provider failures — but
 * the catch below still guards the seam: the provider is replaceable through
 * `_workflowContextStageDeps`, and no context failure may fail a story.
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ContextToolRuntimeConfig } from "@/config/selectors";
import { type ContextRequest, FeatureContextProviderV2, type IContextProvider } from "@/context/engine";
import { getLogger } from "@/logger";
import type { UserStory } from "@/prd";
import { storyWorkdir } from "@/utils/path-frame";
import type { PipelineContext, PipelineStage, StageResult } from "../types";
import { contextStage } from "./context";
import { allocateStorySession } from "./context-session";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps (for testing)
// ─────────────────────────────────────────────────────────────────────────────

export const _workflowContextStageDeps = {
  /**
   * The feature-context provider for this story. Type is the `IContextProvider`
   * contract, not the v2 class, so a test can stub `fetch` without building one.
   */
  featureContextProvider: (story: UserStory, config: ContextToolRuntimeConfig): IContextProvider =>
    new FeatureContextProviderV2(story, config),
};

/**
 * Fallback for `context.featureEngine.budgetTokens`, matching the inline
 * default `runV2Path` uses when building the same request (context.ts). Named
 * here rather than repeated inline so the two derivations are greppable
 * together; the two stages must not silently budget the feature context
 * differently.
 */
const DEFAULT_FEATURE_CONTEXT_BUDGET_TOKENS = 8_000;

/**
 * Build the feature-context request. The field list matches `runV2Path`'s
 * request for the same `stage`/`role`, minus everything the feature-context
 * provider does not read (scoping, pull config, digests, touched files).
 */
function buildFeatureContextRequest(ctx: PipelineContext): ContextRequest {
  const stageOverrides = ctx.config.context?.v2?.stages?.context;
  return {
    storyId: ctx.story.id,
    featureId: ctx.featureDir?.replace(/\/$/, "").split("/").pop(),
    repoRoot: ctx.projectDir,
    packageDir: ctx.workdir,
    storyWorkdir: storyWorkdir(ctx.story),
    stage: "context",
    role: "implementer",
    budgetTokens:
      stageOverrides?.budgetTokens ??
      ctx.config.context?.featureEngine?.budgetTokens ??
      DEFAULT_FEATURE_CONTEXT_BUDGET_TOKENS,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────────

export const workflowContextStage: PipelineStage = {
  name: "context",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    // Same defensive reads the rest of the config uses (`context?.v2?.…`), so a
    // sparse test or plugin config does not throw here.
    const delivery = ctx.config.context?.rules?.delivery ?? "index";
    if (ctx.config.context?.v2?.enabled !== true || delivery === "push") {
      return contextStage.execute(ctx);
    }

    allocateStorySession(ctx);

    try {
      const provider = _workflowContextStageDeps.featureContextProvider(ctx.story, ctx.config);
      const { chunks = [] } = await provider.fetch(buildFeatureContextRequest(ctx));
      if (chunks.length > 0) {
        ctx.featureContextMarkdown = chunks.map((chunk) => chunk.content).join("\n\n");
      }
    } catch (err) {
      getLogger().warn("context", "Failed to fetch feature context — continuing without it", {
        storyId: ctx.story.id,
        error: errorMessage(err),
      });
    }

    return { action: "continue" };
  },
};
