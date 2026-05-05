import { resolveRetryPreset } from "../agents/retry";
import type { RetryPreset, RetryStrategy } from "../agents/retry";
import type { TurnResult } from "../agents/types";
import { pickSelector, resolveConfiguredModel } from "../config";
import type { ConfigSelector, ConfiguredModel, NaxConfig } from "../config";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import type { UserStory } from "../prd";
import { composeSections, join } from "../prompts/compose";
import { buildHopCallback } from "./build-hop-callback";
import type { BuildContext, CallContext, CompleteOperation, Operation, RunOperation, VerifyContext } from "./types";

/** Injectable deps for testability — mirrors _agentManagerDeps pattern. */
export const _callOpDeps = {
  sleep: (ms: number) => Bun.sleep(ms),
};

/** Hard ceiling for injected RetryStrategy instances that may not self-terminate. */
const MAX_COMPLETE_RETRY_ATTEMPTS = 20;

function normalizeSelector<C>(s: ConfigSelector<C> | readonly (keyof NaxConfig)[], opName: string): ConfigSelector<C> {
  if (Array.isArray(s)) {
    return pickSelector(`anonymous:${opName}`, ...(s as readonly (keyof NaxConfig)[])) as unknown as ConfigSelector<C>;
  }
  return s as ConfigSelector<C>;
}

function resolveOpModel<I, O, C>(
  op: Operation<I, O, C>,
  input: I,
  buildCtx: BuildContext<C>,
): ConfiguredModel | undefined {
  const m = (op as { model?: ConfiguredModel | ((i: I, ctx: BuildContext<C>) => ConfiguredModel | undefined) }).model;
  if (typeof m === "function") return m(input, buildCtx);
  return m;
}

function resolveTimeoutMs<I, O, C>(op: Operation<I, O, C>, input: I, buildCtx: BuildContext<C>): number | undefined {
  const timeoutMs = op.timeoutMs?.(input, buildCtx);
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new NaxError(`callOp[${op.name}]: invalid timeoutMs (${String(timeoutMs)})`, "CALL_OP_INVALID_TIMEOUT", {
      stage: op.stage,
      timeoutMs,
    });
  }
  return timeoutMs;
}

function resolveOpRetry<I, O, C>(
  op: CompleteOperation<I, O, C>,
  input: I,
  buildCtx: BuildContext<C>,
): RetryStrategy | null {
  if (!op.retry) return null;
  if (typeof op.retry === "function") {
    const preset = op.retry(input, buildCtx);
    return preset ? resolveRetryPreset(preset) : null;
  }
  if ("shouldRetry" in op.retry) return op.retry as RetryStrategy;
  return resolveRetryPreset(op.retry as RetryPreset);
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
  const timeoutMs = resolveTimeoutMs(op, input, buildCtx);

  const config = ctx.runtime.configLoader.current();
  const defaultAgent = ctx.runtime.agentManager.getDefault();
  const opModel: ConfiguredModel = resolveOpModel(op, input, buildCtx) ?? "balanced";
  // resolved.agent honors `{ agent, model }` pin (cross-agent overrides);
  // resolved.modelTier is undefined when an explicit non-tier model is pinned.
  const resolved = resolveConfiguredModel(config.models, ctx.agentName, opModel, defaultAgent);
  const dispatchAgent = resolved.agent;
  const effectiveTier = resolved.modelTier ?? "balanced";

  if (op.kind === "complete") {
    const completeOp = op as CompleteOperation<I, O, C>;
    const sessionRole = ctx.sessionOverride?.role;
    const completeOptions = {
      modelDef: resolved.modelDef,
      jsonMode: completeOp.jsonMode ?? false,
      pipelineStage: op.stage,
      storyId: ctx.storyId,
      workdir: ctx.packageDir,
      featureName: ctx.featureName,
      ...(sessionRole !== undefined ? { sessionRole } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };

    const retryStrategy = resolveOpRetry(completeOp, input, buildCtx);
    let attempt = 0;
    while (attempt <= MAX_COMPLETE_RETRY_ATTEMPTS) {
      try {
        const raw = await ctx.runtime.agentManager.completeAs(dispatchAgent, prompt, completeOptions);
        const parsedComplete = op.parse(raw.output, input, buildCtx);
        return await runPostParse(op, parsedComplete, input, buildCtx);
      } catch (err) {
        if (!retryStrategy) throw err;
        const decision = retryStrategy.shouldRetry(err as Error, attempt, {
          site: "complete",
          agentName: dispatchAgent,
          stage: op.stage,
          storyId: ctx.storyId,
        });
        if (!decision.retry) throw err;
        getSafeLogger()?.warn(
          "call-op",
          `LLM call failed (attempt ${attempt + 1}), retrying in ${decision.delayMs}ms`,
          {
            storyId: ctx.storyId,
            op: op.name,
            attempt,
            delayMs: decision.delayMs,
          },
        );
        await _callOpDeps.sleep(decision.delayMs);
        attempt++;
      }
    }
    throw new NaxError(
      `callOp[${op.name}]: exceeded MAX_COMPLETE_RETRY_ATTEMPTS (${MAX_COMPLETE_RETRY_ATTEMPTS})`,
      "CALL_OP_MAX_RETRIES",
      { stage: op.stage, storyId: ctx.storyId },
    );
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
    timeoutSeconds: timeoutMs !== undefined ? Math.ceil(timeoutMs / 1000) : config.execution.sessionTimeoutSeconds,
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
  const parsedRun = op.parse(rawOutput, input, buildCtx);
  return runPostParse(op, parsedRun, input, buildCtx);
}

async function runPostParse<I, O, C>(
  op: Operation<I, O, C>,
  parsed: O,
  input: I,
  buildCtx: BuildContext<C>,
): Promise<O> {
  if (!op.verify && !op.recover) return parsed;

  const verifyCtx: VerifyContext<C> = {
    packageView: buildCtx.packageView,
    config: buildCtx.config,
    readFile: async (p) => {
      try {
        return await Bun.file(p).text();
      } catch {
        return null;
      }
    },
    fileExists: async (p) => Bun.file(p).exists(),
  };

  let final: O | null = parsed;

  if (op.verify) {
    final = await op.verify(parsed, input, verifyCtx);
  }

  if (final === null && op.recover) {
    final = await op.recover(input, verifyCtx);
  }

  return (final ?? parsed) as O;
}

/**
 * Exported for unit testing only — exercises runPostParse without a full callOp setup.
 * Accepts a structural subtype of Operation (only verify/recover needed) and casts
 * internally. Safe because runPostParse only reads verify and recover from op.
 */
export async function _runPostParseForTest<I, O, C>(
  op: {
    readonly verify?: (parsed: O, input: I, ctx: VerifyContext<C>) => Promise<O | null>;
    readonly recover?: (input: I, ctx: VerifyContext<C>) => Promise<O | null>;
  },
  parsed: O,
  input: I,
  buildCtx: BuildContext<C>,
): Promise<O> {
  return runPostParse(op as unknown as Operation<I, O, C>, parsed, input, buildCtx);
}
