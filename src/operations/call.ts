import type { TurnResult } from "../agents/types";
import { pickSelector, resolveConfiguredModel } from "../config";
import type { ConfigSelector, ConfiguredModel, NaxConfig } from "../config";
import { NaxError } from "../errors";
import type { UserStory } from "../prd";
import { composeSections, join } from "../prompts/compose";
import { buildHopCallback } from "./build-hop-callback";
import type { CallContext, CompleteOperation, Operation, RunOperation } from "./types";

function normalizeSelector<C>(s: ConfigSelector<C> | readonly (keyof NaxConfig)[], opName: string): ConfigSelector<C> {
  if (Array.isArray(s)) {
    return pickSelector(`anonymous:${opName}`, ...(s as readonly (keyof NaxConfig)[])) as unknown as ConfigSelector<C>;
  }
  return s as ConfigSelector<C>;
}

/**
 * Synthesize a minimal UserStory for callOp use cases that don't carry a real
 * one (CLI ad-hoc calls, debate runners, simple op invocations). Only the `id`
 * field is read by buildHopCallback's active code paths when no context bundle
 * is provided — the other fields are zero-value placeholders.
 *
 * Uses `satisfies` (not `as`) so any future required field on UserStory breaks
 * compile here, forcing an explicit decision rather than silently producing an
 * empty default. If a downstream provider starts reading e.g. `acceptanceCriteria`
 * for these stub stories, that's a bug — the synthesis path shouldn't run for
 * any op that consumes story data beyond `id`.
 */
function synthesizeStory(storyId: string | undefined): UserStory {
  return {
    id: storyId ?? "",
    title: "",
    description: "",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  } satisfies UserStory;
}

export async function callOp<I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I): Promise<O> {
  const selector = normalizeSelector(op.config, op.name);
  const slicedConfig = ctx.packageView.select(selector);
  const buildCtx = { packageView: ctx.packageView, config: slicedConfig };
  const sections = composeSections(op.build(input, buildCtx));
  const prompt = join(sections);

  const config = ctx.runtime.configLoader.current();
  const defaultAgent = ctx.runtime.agentManager.getDefault();
  const opModel: ConfiguredModel = (op as { model?: ConfiguredModel }).model ?? "balanced";
  // resolved.agent honors `{ agent, model }` pin (cross-agent overrides);
  // resolved.modelTier is undefined when an explicit non-tier model is pinned.
  const resolved = resolveConfiguredModel(config.models, ctx.agentName, opModel, defaultAgent);
  const dispatchAgent = resolved.agent;
  const effectiveTier = resolved.modelTier ?? "balanced";

  const stageTimeoutMs = op.stage === "acceptance" ? (config.acceptance?.timeoutMs ?? 1_800_000) : undefined;

  if (op.kind === "complete") {
    const completeOp = op as CompleteOperation<I, O, C>;
    const raw = await ctx.runtime.agentManager.completeAs(dispatchAgent, prompt, {
      model: resolved.modelDef.model,
      config,
      jsonMode: completeOp.jsonMode ?? false,
      pipelineStage: op.stage,
      storyId: ctx.storyId,
      workdir: ctx.packageDir,
      featureName: ctx.featureName,
      ...(stageTimeoutMs !== undefined ? { timeoutMs: stageTimeoutMs } : {}),
    });
    return op.parse(raw.output, input, buildCtx);
  }

  // kind:"run" — ADR-019 §5: route through runWithFallback + buildHopCallback.
  // This restores cross-agent fallback (Finding 1), wires the hop through
  // AgentManager.runAsSession so middleware fires (Finding 5), and lets
  // op.noFallback short-circuit the swap branch (Finding 6).
  const runOp = op as RunOperation<I, O, C>;
  const story = ctx.story ?? synthesizeStory(ctx.storyId);
  const sessionRole = ctx.sessionOverride?.role ?? runOp.session.role;
  const runOptions = {
    prompt,
    workdir: ctx.packageDir,
    modelTier: effectiveTier,
    modelDef: resolved.modelDef,
    timeoutSeconds:
      stageTimeoutMs !== undefined ? Math.ceil(stageTimeoutMs / 1000) : config.execution.sessionTimeoutSeconds,
    pipelineStage: op.stage,
    config,
    sessionRole,
    featureName: ctx.featureName,
    storyId: ctx.storyId,
  };

  // Always dispatch through the real AgentManager so middleware (audit, cost,
  // cancellation, logging) fires uniformly. `noFallback: true` short-circuits
  // the swap branch in runWithFallback (manager.ts) — single-agent semantics
  // without losing the middleware envelope. dispatchAgent roots the chain at
  // the resolved agent, which may differ from ctx.agentName when op.model
  // pins a specific `{ agent, model }`.
  //
  // The hopBody / hopBodyInput cast bridges the per-op generic `HopBody<I>`
  // to BuildHopCallbackContext's `hopBody` (parameterized over `unknown`).
  // Safe because the same `input` value flows into both `hopBodyInput` and
  // the body's `ctx.input` — the cast only re-types the parameter.
  const executeHop = buildHopCallback(
    {
      sessionManager: ctx.runtime.sessionManager,
      agentManager: ctx.runtime.agentManager,
      story,
      config,
      projectDir: ctx.runtime.projectDir,
      featureName: ctx.featureName ?? "",
      workdir: ctx.packageDir,
      effectiveTier,
      defaultAgent,
      pipelineStage: op.stage,
      ...(runOp.hopBody && {
        hopBody: ((initialPrompt: string, bodyCtx: { send: (p: string) => Promise<TurnResult>; input: unknown }) =>
          runOp.hopBody?.(initialPrompt, { send: bodyCtx.send, input: bodyCtx.input as I })) as NonNullable<
          import("./build-hop-callback").BuildHopCallbackContext["hopBody"]
        >,
        hopBodyInput: input,
      }),
    },
    undefined, // sessionId — callOp doesn't carry pipeline-level session descriptors
    runOptions,
  );

  const outcome = await ctx.runtime.agentManager.runWithFallback(
    {
      runOptions,
      signal: ctx.runtime.signal,
      executeHop,
      noFallback: runOp.noFallback,
      bundle: ctx.contextBundle,
    },
    dispatchAgent,
  );

  const rawOutput = outcome.result.output;
  if (!rawOutput) {
    throw new NaxError(`callOp[${op.name}]: agent returned no output`, "CALL_OP_NO_OUTPUT", {
      stage: op.stage,
      storyId: ctx.storyId,
      agentName: dispatchAgent,
    });
  }
  return op.parse(rawOutput, input, buildCtx);
}
