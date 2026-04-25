import { wrapAdapterAsManager } from "../agents";
import type { IAgentManager } from "../agents";
import type { AgentRunRequest } from "../agents/manager-types";
import { pickSelector, resolveModelForAgent } from "../config";
import type { ConfigSelector, NaxConfig } from "../config";
import { NaxError } from "../errors";
import { composeSections, join } from "../prompts/compose";
import type {
  CallContext,
  CompleteOperation,
  Operation,
  RunOperation,
  SessionRunnerContext,
  SessionRunnerOutcome,
} from "./types";

function normalizeSelector<C>(s: ConfigSelector<C> | readonly (keyof NaxConfig)[], opName: string): ConfigSelector<C> {
  if (Array.isArray(s)) {
    return pickSelector(`anonymous:${opName}`, ...(s as readonly (keyof NaxConfig)[])) as unknown as ConfigSelector<C>;
  }
  return s as ConfigSelector<C>;
}

async function runOpSession(ctx: SessionRunnerContext): Promise<SessionRunnerOutcome> {
  const { runtime, agentName, packageDir, storyId, prompt, op, sessionOverride, noFallback } = ctx;
  const config = runtime.configLoader.current();
  const sessionRole = sessionOverride?.role ?? op.session.role;
  const defaultAgent = runtime.agentManager.getDefault();
  const manager = createRunOpManager(runtime.agentManager, agentName, noFallback);

  const sessionDesc = runtime.sessionManager.create({
    role: sessionRole,
    agent: agentName,
    workdir: packageDir,
    storyId,
  });

  const result = await runtime.sessionManager.runInSession(sessionDesc.id, manager, {
    runOptions: {
      prompt,
      workdir: packageDir,
      modelTier: "balanced",
      modelDef: resolveModelForAgent(config.models, agentName, "balanced", defaultAgent),
      timeoutSeconds: config.execution.sessionTimeoutSeconds,
      config,
      storyId,
      sessionRole,
      pipelineStage: op.stage,
      keepOpen: op.session.lifetime === "warm",
      abortSignal: runtime.signal,
    },
    signal: runtime.signal,
  });

  return { primaryResult: result, fallbacks: [] };
}

function createRunOpManager(base: IAgentManager, agentName: string, noFallback?: boolean): IAgentManager {
  if (noFallback) {
    const adapter = base.getAgent(agentName);
    if (!adapter) {
      throw new NaxError(`callOp: agent "${agentName}" not found`, "CALL_OP_AGENT_NOT_FOUND", {
        stage: "run",
        agentName,
      });
    }
    return wrapAdapterAsManager(adapter);
  }

  return {
    getDefault: () => agentName,
    run: (request: AgentRunRequest) => base.runAs(agentName, request),
  } as IAgentManager;
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

  const runOp = op as RunOperation<I, O, C>;
  const runnerCtx: SessionRunnerContext = {
    runtime: ctx.runtime,
    agentName: ctx.agentName,
    packageDir: ctx.packageDir,
    storyId: ctx.storyId,
    prompt,
    op: runOp as unknown as RunOperation<unknown, unknown, unknown>,
    sessionOverride: ctx.sessionOverride,
    noFallback: runOp.noFallback,
  };
  const outcome = await runOpSession(runnerCtx);
  const rawOutput = outcome.primaryResult.output;
  if (!rawOutput) {
    throw new NaxError(`callOp[${op.name}]: agent returned no output`, "CALL_OP_NO_OUTPUT", {
      stage: op.stage,
      storyId: ctx.storyId,
      agentName: ctx.agentName,
    });
  }
  return op.parse(rawOutput, input, buildCtx);
}
