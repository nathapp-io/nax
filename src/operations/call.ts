import { pickSelector, resolveModelForAgent } from "../config";
import type { ConfigSelector, NaxConfig } from "../config";
import { NaxError } from "../errors";
import { composeSections, join } from "../prompts/compose";
import type { CallContext, CompleteOperation, Operation } from "./types";

function normalizeSelector<C>(s: ConfigSelector<C> | readonly (keyof NaxConfig)[], opName: string): ConfigSelector<C> {
  if (Array.isArray(s)) {
    return pickSelector(`anonymous:${opName}`, ...(s as readonly (keyof NaxConfig)[])) as unknown as ConfigSelector<C>;
  }
  return s as ConfigSelector<C>;
}

export async function callOp<I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I): Promise<O> {
  const selector = normalizeSelector(op.config, op.name);
  const slicedConfig = ctx.packageView.select(selector);
  const buildCtx = { packageView: ctx.packageView, config: slicedConfig };
  const sections = composeSections(op.build(input, buildCtx));
  const prompt = join(sections);

  if (op.kind === "complete") {
    const completeOp = op as CompleteOperation<I, O, C>;
    const config = ctx.runtime.configLoader.current();
    const defaultAgent = ctx.runtime.agentManager.getDefault();
    const tier = completeOp.modelTier ?? "balanced";
    const modelDef = resolveModelForAgent(config.models, ctx.agentName, tier, defaultAgent);
    const raw = await ctx.runtime.agentManager.completeAs(ctx.agentName, prompt, {
      model: modelDef.model,
      config,
      jsonMode: completeOp.jsonMode ?? false,
      pipelineStage: op.stage,
      storyId: ctx.storyId,
      workdir: ctx.packageDir,
    });
    return op.parse(raw.output, input, buildCtx);
  }

  const config = ctx.runtime.configLoader.current();
  const defaultAgent = ctx.runtime.agentManager.getDefault();
  const sessionName = ctx.runtime.sessionManager.nameFor({
    workdir: ctx.packageDir,
    storyId: ctx.storyId,
    featureName: ctx.featureName,
    pipelineStage: op.stage,
  });

  const turnResult = await ctx.runtime.sessionManager.runInSession(sessionName, prompt, {
    agentName: ctx.agentName,
    workdir: ctx.packageDir,
    pipelineStage: op.stage,
    signal: ctx.runtime.signal,
    modelDef: resolveModelForAgent(config.models, ctx.agentName, "balanced", defaultAgent),
    timeoutSeconds: config.execution.sessionTimeoutSeconds,
    storyId: ctx.storyId,
    featureName: ctx.featureName,
  });

  const rawOutput = turnResult.output;
  if (!rawOutput) {
    throw new NaxError(`callOp[${op.name}]: agent returned no output`, "CALL_OP_NO_OUTPUT", {
      stage: op.stage,
      storyId: ctx.storyId,
      agentName: ctx.agentName,
    });
  }
  return op.parse(rawOutput, input, buildCtx);
}
