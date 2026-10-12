/** CallContext for workflow ops: the executionStage wiring that still applies (spec §5.2 "Approvals"). */
import { buildDispatchAskWiring, buildInteractionBridge, collectEffectiveRunStageModes } from "@/interaction";
import type { CallContext } from "@/operations/types";
import type { PipelineContext } from "@/pipeline/types";
import { storyPackageDir, storyWorkdir } from "@/utils/path-frame";
import { _workflowCallContextDeps } from "./call-context-deps";

export async function buildWorkflowCallContext(
  ctx: PipelineContext,
): Promise<{ callCtx: CallContext; dispose: () => Promise<void> }> {
  const packageView = ctx.packageView ?? ctx.runtime.packages.resolve(ctx.workdir);
  const interactionBridge = buildInteractionBridge(ctx.interaction, {
    featureName: ctx.prd.feature,
    storyId: ctx.story.id,
    stage: "execution",
  });
  const dispatchAsk = await buildDispatchAskWiring(
    {
      config: ctx.config,
      interaction: ctx.interaction,
      outputDir: ctx.runtime.outputDir,
      runId: ctx.runtime.runId,
      repoRoot: ctx.workdir,
      projectRoot: ctx.projectDir,
      featureName: ctx.prd.feature,
      storyId: ctx.story.id,
      abortSignal: ctx.abortSignal,
      stageModes: await collectEffectiveRunStageModes(
        {
          projectDir: ctx.projectDir,
          rootConfig: ctx.rootConfig,
          extraConfigs: [ctx.config],
          packageDirs: ctx.runStoryWorkdirs ?? ctx.stories.map(storyPackageDir),
        },
        _workflowCallContextDeps,
      ),
    },
    _workflowCallContextDeps,
  );
  const callCtx: CallContext = {
    runtime: ctx.runtime,
    packageView,
    packageDir: ctx.workdir,
    instructionDirectories: [...new Set(ctx.stories.map(storyWorkdir))],
    config: ctx.config,
    ...(ctx.contextBundle ? { contextBundle: ctx.contextBundle } : {}),
    ...(ctx.sessionScratchDir ? { storyScratchDirs: [ctx.sessionScratchDir] } : {}),
    agentName: ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? "claude",
    storyId: ctx.story.id,
    featureName: ctx.prd.feature,
    story: ctx.story,
    ...(ctx.featureDir ? { featureDir: ctx.featureDir } : {}),
    ...(interactionBridge ? { interactionBridge } : {}),
    ...(dispatchAsk.askResolver ? { askResolver: dispatchAsk.askResolver } : {}),
    ...(dispatchAsk.commandShadow ? { commandShadow: dispatchAsk.commandShadow } : {}),
  };
  return { callCtx, dispose: () => dispatchAsk.dispose() };
}
