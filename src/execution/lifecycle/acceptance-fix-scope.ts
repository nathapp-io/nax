/**
 * Acceptance fix scope — the `FixCycleContext` the acceptance fix cycle
 * dispatches `acceptanceFixSourceOp` / `acceptanceFixTestOp` through.
 *
 * Both ops declare `Bash`, so the context MUST carry the P2 ask resolver and
 * the P5 command shadow (#2201): without them `bashApproval: gated | escalate`
 * falls back to the headless resolver (always deny, no approval-audit row) and
 * no command is shadow-classified. The scope owns that wiring, so the caller
 * must `await dispose()` once the cycle settles.
 *
 * Split out of acceptance-loop.ts for file-size compliance.
 */

import type { FixCycleContext } from "@/findings";
import { buildRunDispatchAskWiring } from "@/interaction";
import type { NaxRuntime } from "@/runtime";
import { storyPackageDir } from "@/utils/path-frame";
import type { AcceptanceLoopContext } from "./acceptance-loop";

/** Injectable deps — swap in tests to avoid mock.module(). */
export const _acceptanceFixScopeDeps = {
  buildRunDispatchAskWiring,
};

export interface AcceptanceFixScope {
  readonly cycleCtx: FixCycleContext;
  /** Cancel an in-flight approval prompt, dispose the human link, drain the shadow. */
  dispose(): Promise<void>;
}

/** The slice of the loop context the scope reads. */
export type AcceptanceFixScopeSource = Pick<
  AcceptanceLoopContext,
  "config" | "prd" | "workdir" | "feature" | "interactionChain" | "abortSignal" | "agentManager"
>;

export async function openAcceptanceFixScope(
  ctx: AcceptanceFixScopeSource,
  runtime: NaxRuntime,
  storyId: string,
  packageDir: string,
): Promise<AcceptanceFixScope> {
  const packageView = runtime.packages.resolve(packageDir);
  const effectiveConfig = packageView.hasOverride ? packageView.config : ctx.config;
  const dispatchAsk = await _acceptanceFixScopeDeps.buildRunDispatchAskWiring({
    config: effectiveConfig,
    rootConfig: ctx.config,
    projectDir: ctx.workdir,
    packageDirs: ctx.prd.userStories.map(storyPackageDir),
    interaction: ctx.interactionChain,
    outputDir: runtime.outputDir,
    runId: runtime.runId,
    repoRoot: ctx.workdir,
    featureName: ctx.feature,
    storyId,
    abortSignal: ctx.abortSignal,
    // US-005: the acceptance fix cycle runs after review, so its approval
    // prompts are labelled "review" rather than the execution default.
    stage: "review",
  });
  const cycleCtx: FixCycleContext = {
    runtime,
    packageView,
    packageDir,
    config: effectiveConfig,
    storyId,
    featureName: ctx.feature,
    // agentName captured once at cycle construction time; fallback changes not reflected mid-cycle
    agentName: ctx.agentManager?.getDefault() ?? "claude",
    askResolver: dispatchAsk.askResolver,
    ...(dispatchAsk.commandShadow ? { commandShadow: dispatchAsk.commandShadow } : {}),
  };
  return { cycleCtx, dispose: dispatchAsk.dispose };
}
