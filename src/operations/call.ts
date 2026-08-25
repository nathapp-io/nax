import { computeAcpHandle } from "../agents";
import type { AgentRunOutcome } from "../agents";
import { ParseValidationError, resolveRetryPreset } from "../agents/retry";
import type { RetryPreset, RetryStrategy } from "../agents/retry";
import type { TurnResult } from "../agents/types";
import { DEFAULT_CONFIG, pickSelector, resolveConfiguredModel } from "../config";
import type { ConfigSelector, ConfiguredModel, NaxConfig } from "../config";
import type { AdapterFailure } from "../context/engine";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import type { UserStory } from "../prd";
import { composeSections, join } from "../prompts/compose";
import { cancellableDelay } from "../utils/bun-deps";
import { errorMessage } from "../utils/errors";
import { buildHopCallback } from "./build-hop-callback";
import {
  MAX_COMPLETE_RETRY_ATTEMPTS,
  newCorrelationId,
  normalizeRunOutcome,
  normalizeSelector,
  recordAgentFallbacks,
  resolveOpModel,
  resolveOpRetry,
  resolveTimeoutMs,
  synthesizeStory,
} from "./call-resolvers";
import { classifyEmptyOutputFailure, classifyProviderRefusalFailure } from "./turn-failure-classification";
import type {
  BuildContext,
  CallContext,
  CompleteOperation,
  DeterministicOperation,
  Operation,
  RunOperation,
  VerifyContext,
} from "./types";

/** Injectable deps for testability — mirrors _agentManagerDeps pattern. */
export const _callOpDeps = {
  sleep: (ms: number, signal?: AbortSignal) => cancellableDelay(ms, signal),
  /**
   * Seam over buildHopCallback so tests can observe the hopCtx literal this
   * function assembles. Without it nothing pins what callOp forwards — the
   * contextToolRunCounter threading was silently absent for exactly that reason.
   */
  buildHopCallback,
  readFileOutput: async (path: string) =>
    Bun.file(path)
      .text()
      .catch(() => null),
};

export async function callOp<I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I): Promise<O> {
  // Deterministic ops bypass all LLM dispatch, cost tracking, and session management.
  if (op.kind === "deterministic") {
    return (op as DeterministicOperation<I, O, C>).execute(input, ctx);
  }

  const selector = normalizeSelector(op.config, op.name);
  const slicedConfig = ctx.packageView.select(selector);
  const buildCtx = { packageView: ctx.packageView, config: slicedConfig };
  const sections = composeSections(op.build(input, buildCtx));
  const prompt = join(sections);
  const timeoutMs = resolveTimeoutMs(op, input, buildCtx);
  // Stamp a fresh callId per invocation; preserve caller-supplied one (AC7).
  const callId = ctx.callId ?? newCorrelationId();
  // The caller's deadline wins over the run's; see CallContext.signal.
  const abortSignal = ctx.signal ?? ctx.runtime.signal;

  const config = ctx.runtime.configLoader.current();
  const defaultAgent = ctx.runtime.agentManager.getDefault();
  const opModel: ConfiguredModel = resolveOpModel(op, input, buildCtx) ?? "balanced";
  // resolved.agent honors `{ agent, model }` pin (cross-agent overrides);
  // resolved.modelTier is undefined when an explicit non-tier model is pinned.
  // Fallback to DEFAULT_CONFIG.models when config.models is absent (e.g. partial test configs).
  const effectiveModels = config.models ?? DEFAULT_CONFIG.models;
  const resolved = resolveConfiguredModel(effectiveModels, ctx.agentName, opModel, defaultAgent);
  const dispatchAgent = resolved.agent;
  const effectiveTier = resolved.modelTier ?? "balanced";

  if (op.kind === "complete") {
    const completeOp = op as CompleteOperation<I, O, C>;
    const sessionRole = ctx.sessionOverride?.role;
    // Explicitly compute sessionName so callers (e.g. mocks) see it without relying
    // on ACP adapter's internal derivation. Only set when both sessionRole and a
    // non-empty packageDir are available (mirrors the adapter-lifecycle logic).
    const sessionName =
      sessionRole && ctx.packageDir
        ? computeAcpHandle(ctx.packageDir, ctx.featureName, ctx.storyId, sessionRole)
        : undefined;
    const completeOptions = {
      modelDef: resolved.modelDef,
      ...(resolved.modelTier !== undefined ? { modelTier: resolved.modelTier } : {}),
      jsonMode: completeOp.jsonMode ?? false,
      pipelineStage: op.stage,
      storyId: ctx.storyId,
      workdir: ctx.packageDir,
      featureName: ctx.featureName,
      callId,
      ...(ctx.scopeId !== undefined ? { scopeId: ctx.scopeId } : {}),
      ...(sessionRole !== undefined ? { sessionRole } : {}),
      ...(sessionName !== undefined ? { sessionName } : {}),
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
        const failure = err as Error;
        const decision = retryStrategy.shouldRetry(failure, attempt, {
          site: "complete",
          agentName: dispatchAgent,
          stage: op.stage,
          storyId: ctx.storyId,
        });
        if (!decision.retry) throw err;
        if (abortSignal?.aborted) {
          throw new NaxError(`callOp[${op.name}]: aborted before retry`, "CALL_OP_ABORTED", {
            stage: op.stage,
            storyId: ctx.storyId,
          });
        }
        getSafeLogger()?.warn("callop", "Op retrying", {
          storyId: ctx.storyId,
          opName: op.name,
          site: "complete" as const,
          agentName: ctx.agentName,
          stage: op.stage,
          attempt,
          delayMs: decision.delayMs,
          promptTransformed: decision.nextPrompt !== undefined,
          failureKind: failure instanceof Error ? "error" : (failure as AdapterFailure).outcome,
          failureMessage: errorMessage(failure),
        });
        await _callOpDeps.sleep(decision.delayMs, abortSignal);
        if (abortSignal?.aborted) {
          throw new NaxError(`callOp[${op.name}]: aborted during retry sleep`, "CALL_OP_ABORTED", {
            stage: op.stage,
            storyId: ctx.storyId,
          });
        }
        attempt++;
      }
    }
    getSafeLogger()?.error("callop", "Op retry budget exhausted", {
      storyId: ctx.storyId,
      opName: op.name,
      site: "complete" as const,
      attempt,
      totalAttempts: attempt + 1,
    });
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

  // Resolve run-kind retry strategy once before the first send.
  // op.retry and op.hopBody compose: when both are set, the user body receives
  // ctx.sendWithParseRetry which applies this strategy per call.
  const retryStrategy = resolveOpRetry(runOp, input, buildCtx);

  // op.fileOutput: when set, callOp reads this file after each agent send and
  // replaces the turn's text output with the file content before the probe fires.
  // This makes the retry probe check the actual written file, not the text
  // confirmation — so retries only fire when the file is missing or invalid.
  const fileOutputPath = runOp.fileOutput?.(input);
  const keepOpen = runOp.keepOpen?.(input, buildCtx) ?? runOp.session.lifetime === "warm";

  const runOptions = {
    prompt,
    workdir: ctx.packageDir,
    modelTier: effectiveTier,
    modelDef: resolved.modelDef,
    timeoutSeconds:
      timeoutMs !== undefined
        ? Math.ceil(timeoutMs / 1000)
        : (config.execution?.sessionTimeoutSeconds ?? DEFAULT_CONFIG.execution.sessionTimeoutSeconds),
    pipelineStage: op.stage,
    config,
    sessionRole,
    featureName: ctx.featureName,
    storyId: ctx.storyId,
    callId,
    // Session reuse defaults from the op lifetime, but ops may override with a
    // resolver when reuse depends on config or invocation context.
    ...(keepOpen ? { keepOpen: true } : {}),
    ...(ctx.scopeId !== undefined ? { scopeId: ctx.scopeId } : {}),
    ...(ctx.interactionBridge ? { interactionBridge: ctx.interactionBridge } : {}),
    ...(ctx.maxInteractionTurns !== undefined ? { maxInteractionTurns: ctx.maxInteractionTurns } : {}),
  };

  // Shared hop-callback context — everything except runOptions and hopBody.
  const hopCtx = {
    sessionManager: ctx.runtime.sessionManager,
    agentManager: ctx.runtime.agentManager,
    story,
    config,
    projectDir: ctx.runtime.projectDir,
    featureName: ctx.featureName ?? "",
    workdir: ctx.packageDir,
    // Pull counter for this story attempt. Forwarding it stops
    // pull.maxCallsPerRun resetting on every hop, and carries AC-18's
    // invocation records through to metrics. NOTE: despite the config key's
    // name the ceiling is per story ATTEMPT, not per run — PipelineContext is
    // constructed fresh per iteration (iteration-runner.ts) and per parallel
    // story (parallel-worker.ts), so each gets its own counter.
    ...(ctx.contextToolRunCounter ? { contextToolRunCounter: ctx.contextToolRunCounter } : {}),
    // US-005: thread the story scratch dirs the stage-assembly path resolved
    // so the pull-tool runtime's query_scratch handler can read the same JSONL
    // the push providers (SessionScratchProvider / ToolDiagnosticsProvider) read.
    ...(ctx.storyScratchDirs?.length ? { storyScratchDirs: ctx.storyScratchDirs } : {}),
    effectiveTier,
    defaultAgent,
    pipelineStage: op.stage,
    ...(ctx.interactionBridge ? { interactionBridge: ctx.interactionBridge } : {}),
    ...(ctx.maxInteractionTurns !== undefined ? { maxInteractionTurns: ctx.maxInteractionTurns } : {}),
  };

  // retryFallback: captured when strategy returns { retry: false, fallback }.
  // Used as final O when op.parse() also fails.
  // maxRetriesExceeded: set when sendWithParseRetry exhausts MAX_COMPLETE_RETRY_ATTEMPTS
  // without the strategy self-terminating; triggers CALL_OP_MAX_RETRIES at outer layer.
  // lastRetryTurn: the final TurnResult from the most recent sendWithParseRetry call
  // (only set when retryStrategy is engaged). When strategy provided no fallback and
  // op.parse() fails, this is returned as O — per spec "ops must provide exhaustedFallback
  // if they cannot tolerate a raw TurnResult as output."
  let retryFallback: unknown;
  let maxRetriesExceeded = false;
  let lastRetryTurn: TurnResult | undefined;

  const sendWithFileOutput = async (
    promptText: string,
    bodyCtx: { send: (p: string) => Promise<TurnResult> },
  ): Promise<TurnResult> => {
    const turn = await bodyCtx.send(promptText);
    let effective = turn;
    if (fileOutputPath) {
      const fileContent = await _callOpDeps.readFileOutput(fileOutputPath);
      if (fileContent !== null) {
        effective = { ...turn, output: fileContent };
      }
    }
    // Synthesize an AdapterFailure for empty output so the manager-tier
    // retry/swap logic handles transient agent stalls uniformly (spec §B1).
    // The outer `if (!rawOutput)` guard in callOp uses a falsy check, so
    // whitespace-only output ("  ") reaches op.parse at exhaustion rather
    // than throwing CALL_OP_NO_OUTPUT — op.parse is expected to handle or
    // reject it. Classification is delegated to turn-failure-classification
    // (US-001), which preserves the legacy empty/whitespace handling and
    // adds the wall-clock timeout branch (fail-timeout quality outcome).
    if (!effective.output?.trim()) {
      const failure = classifyEmptyOutputFailure(effective);
      if (failure) return { ...effective, adapterFailure: failure };
    } else if (!effective.adapterFailure) {
      // A provider refusal (e.g. "model is at capacity") comes back as ordinary,
      // non-empty turn output — not a thrown transport error — so it reaches
      // op.parse's own fail-open logic unless classified here first. Attaching
      // an AdapterFailure routes it through the same manager-tier backoff/swap
      // logic as any other infra failure instead of being parsed as a verdict.
      const refusal = classifyProviderRefusalFailure(effective.output);
      if (refusal) {
        getSafeLogger()?.warn("callop", "Provider refusal classified as infra failure", {
          storyId: ctx.storyId,
          opName: op.name,
          agentName: dispatchAgent,
          outcome: refusal.outcome,
        });
        return { ...effective, adapterFailure: refusal };
      }
    }
    return effective;
  };

  // sendWithParseRetry: runs the retry loop inside one session turn.
  // The strategy's shouldRetry decides whether to retry on each turn's output
  // (using its own internal parse + validate, not op.parse()). This means the
  // strategy is the oracle for per-turn validity — op.parse() is only called
  // once by callOp after the hop body returns, as the authoritative final parse.
  //
  // When op.retry is absent, this reduces to bodyCtx.send(initialPrompt).
  const sendWithParseRetry = async (
    initialPrompt: string,
    bodyCtx: { send: (p: string) => Promise<TurnResult>; input: unknown },
  ): Promise<TurnResult> => {
    // Reset shared state so each call is independent.
    retryFallback = undefined;
    maxRetriesExceeded = false;
    lastRetryTurn = undefined;
    if (!retryStrategy) return sendWithFileOutput(initialPrompt, bodyCtx);
    let currentPrompt = initialPrompt;
    let attempt = 0;
    let cumCost = 0;
    let lastTurn!: TurnResult;
    while (attempt <= MAX_COMPLETE_RETRY_ATTEMPTS) {
      lastTurn = await sendWithFileOutput(currentPrompt, bodyCtx);
      cumCost += lastTurn.estimatedCostUsd ?? 0;
      const decision = retryStrategy.shouldRetry(
        new ParseValidationError(`[${op.name}] sendWithParseRetry: probe attempt ${attempt}`),
        attempt,
        {
          site: "run" as const,
          agentName: dispatchAgent,
          stage: op.stage,
          storyId: ctx.storyId,
          lastOutput: lastTurn.output,
          lastTurnResult: { ...lastTurn, estimatedCostUsd: cumCost },
        },
      );
      if (!decision.retry) {
        if ("fallback" in decision && decision.fallback !== undefined) {
          retryFallback = decision.fallback;
        }
        const result = { ...lastTurn, estimatedCostUsd: cumCost };
        lastRetryTurn = result;
        return result;
      }
      if (abortSignal?.aborted) {
        throw new NaxError(`callOp[${op.name}]: aborted during retry`, "CALL_OP_ABORTED", {
          stage: op.stage,
          storyId: ctx.storyId,
        });
      }
      getSafeLogger()?.warn("callop", "Op retrying", {
        storyId: ctx.storyId,
        opName: op.name,
        site: "run" as const,
        agentName: ctx.agentName,
        stage: op.stage,
        attempt,
        delayMs: decision.delayMs,
        promptTransformed: decision.nextPrompt !== undefined,
        failureKind: "error",
        failureMessage: `sendWithParseRetry: parse probe failed at attempt ${attempt}`,
      });
      await _callOpDeps.sleep(decision.delayMs, abortSignal);
      if (abortSignal?.aborted) {
        throw new NaxError(`callOp[${op.name}]: aborted during retry sleep`, "CALL_OP_ABORTED", {
          stage: op.stage,
          storyId: ctx.storyId,
        });
      }
      currentPrompt = decision.nextPrompt ?? initialPrompt;
      attempt++;
    }
    // Hard ceiling hit — strategy didn't self-terminate.
    maxRetriesExceeded = true;
    const exhaustedResult = { ...lastTurn, estimatedCostUsd: cumCost };
    lastRetryTurn = exhaustedResult;
    return exhaustedResult;
  };

  // effectiveHopBody: wraps the user's body with sendWithParseRetry injected as
  // ctx.sendWithParseRetry. When no user body, sendWithParseRetry is the body.
  // buildHopCallback sees only { send, input } — retry wiring stays inside callOp.
  const effectiveHopBody = (
    initialPrompt: string,
    bodyCtx: { send: (p: string) => Promise<TurnResult>; input: unknown },
  ): Promise<TurnResult> => {
    if (runOp.hopBody) {
      return runOp.hopBody(initialPrompt, {
        send: (p) => sendWithFileOutput(p, bodyCtx),
        sendWithParseRetry: (p) => sendWithParseRetry(p, bodyCtx),
        input: bodyCtx.input as I,
      });
    }
    return sendWithParseRetry(initialPrompt, bodyCtx);
  };

  // Always dispatch through the real AgentManager so middleware (audit, cost,
  // cancellation, logging) fires uniformly. `noFallback: true` short-circuits
  // the swap branch in runWithFallback (manager.ts) — single-agent semantics
  // without losing the middleware envelope. dispatchAgent roots the chain at
  // the resolved agent, which may differ from ctx.agentName when op.model
  // pins a specific `{ agent, model }`.
  const executeHop = _callOpDeps.buildHopCallback(
    {
      ...hopCtx,
      hopBody: effectiveHopBody as NonNullable<import("./build-hop-callback").BuildHopCallbackContext["hopBody"]>,
      hopBodyInput: input,
    },
    undefined, // sessionId — callOp doesn't carry pipeline-level session descriptors
    runOptions,
  );

  // Single runWithFallback call. Retries (when op.retry is set) happen inside the
  // hop body via sendWithParseRetry — one session, multiple turns.
  const rawOutcome = await ctx.runtime.agentManager.runWithFallback(
    {
      runOptions,
      signal: abortSignal,
      executeHop,
      noFallback: runOp.noFallback,
      bundle: ctx.contextBundle,
    },
    dispatchAgent,
  );
  const outcome = normalizeRunOutcome(rawOutcome);

  // nax#1707: this is the only point where agent-swap hops are both available and
  // attributable to a story. `outcome.result` is not that carrier — post-run.ts
  // rebuilds ctx.agentResult from the implementer's phase output, so anything left
  // on the AgentResult here is dropped before metrics run. Record on the run-scoped
  // store instead, so hops from every op in the story reach StoryMetrics.fallback.
  recordAgentFallbacks(ctx, outcome.fallbacks);

  // Abort check: if the signal was aborted during the hop (e.g. in sendWithParseRetry),
  // buildHopCallback's catch swallowed it. Surface it here before parse runs.
  if (abortSignal?.aborted) {
    throw new NaxError(`callOp[${op.name}]: aborted`, "CALL_OP_ABORTED", { stage: op.stage, storyId: ctx.storyId });
  }

  const rawOutput = outcome.result.output;
  const totalCost = outcome.result.estimatedCostUsd ?? 0;

  if (!rawOutput) {
    if (maxRetriesExceeded) {
      getSafeLogger()?.error("callop", "Op retry budget exhausted (empty output)", {
        storyId: ctx.storyId,
        opName: op.name,
        site: "run" as const,
        totalAttempts: MAX_COMPLETE_RETRY_ATTEMPTS + 1,
      });
      throw new NaxError(
        `callOp[${op.name}]: CALL_OP_MAX_RETRIES — exceeded MAX_COMPLETE_RETRY_ATTEMPTS (${MAX_COMPLETE_RETRY_ATTEMPTS})`,
        "CALL_OP_MAX_RETRIES",
        { stage: op.stage, storyId: ctx.storyId },
      );
    }
    if (retryFallback !== undefined) {
      if (typeof retryFallback !== "object" || retryFallback === null) {
        throw new NaxError(
          `callOp[${op.name}]: exhaustedFallback returned a non-object (${typeof retryFallback}); fallback must be a plain object`,
          "CALL_OP_INVALID_FALLBACK",
          { stage: op.stage, storyId: ctx.storyId },
        );
      }
      getSafeLogger()?.warn("callop", "Returning exhaustedFallback on empty output", {
        storyId: ctx.storyId,
        opName: op.name,
        agentName: dispatchAgent,
      });
      return { ...retryFallback, estimatedCostUsd: totalCost } as O;
    }
    if (op.recover) {
      const verifyCtx = makeVerifyCtx(buildCtx);
      const recovered = await op.recover(input, verifyCtx);
      if (recovered !== null) {
        getSafeLogger()?.warn("callop", "Recovered from empty output via op.recover", {
          storyId: ctx.storyId,
          opName: op.name,
          agentName: dispatchAgent,
        });
        return recovered;
      }
    }
    throw new NaxError(`callOp[${op.name}]: agent returned no output`, "CALL_OP_NO_OUTPUT", {
      stage: op.stage,
      storyId: ctx.storyId,
      agentName: dispatchAgent,
    });
  }

  // runPostParse sits outside the try-catch so verify/recover errors propagate
  // normally rather than being misidentified as parse failures.
  //
  // Note: when op.retry is set, the strategy has already validated internally.
  // This second parse via op.parse() produces the typed O. Strategy `validate`
  // and `op.parse` MUST agree on validity — disagreement causes drift between
  // retry decisions and final output.
  try {
    const parsedRun = op.parse(rawOutput, input, buildCtx);
    return await runPostParse(op, parsedRun, input, buildCtx);
  } catch (_parseErr) {
    if (maxRetriesExceeded) {
      getSafeLogger()?.error("callop", "Op retry budget exhausted", {
        storyId: ctx.storyId,
        opName: op.name,
        site: "run" as const,
        totalAttempts: MAX_COMPLETE_RETRY_ATTEMPTS + 1,
      });
      throw new NaxError(
        `callOp[${op.name}]: CALL_OP_MAX_RETRIES — exceeded MAX_COMPLETE_RETRY_ATTEMPTS (${MAX_COMPLETE_RETRY_ATTEMPTS})`,
        "CALL_OP_MAX_RETRIES",
        { stage: op.stage, storyId: ctx.storyId },
      );
    }
    if (retryFallback !== undefined) {
      if (typeof retryFallback !== "object" || retryFallback === null) {
        throw new NaxError(
          `callOp[${op.name}]: exhaustedFallback returned a non-object (${typeof retryFallback}); fallback must be a plain object`,
          "CALL_OP_INVALID_FALLBACK",
          { stage: op.stage, storyId: ctx.storyId },
        );
      }
      return { ...retryFallback, estimatedCostUsd: totalCost } as O;
    }
    // When retryStrategy engaged but provided no fallback, prefer op.recover before
    // falling back to envelope passthrough. recover is the disk-recovery escape hatch
    // (#993: silently returning a TurnResult typed-as-O corrupted prd.json).
    if (op.recover) {
      const verifyCtx = makeVerifyCtx(buildCtx);
      const recovered = await op.recover(input, verifyCtx);
      if (recovered !== null) return recovered;
    }

    if (lastRetryTurn !== undefined) {
      // Last-resort envelope passthrough. Logged so silent corruption stops being silent.
      getSafeLogger()?.warn(
        "callop",
        "Op exhausted retries with no fallback and no recover — returning raw TurnResult",
        {
          storyId: ctx.storyId,
          opName: op.name,
          site: "run" as const,
        },
      );
      return lastRetryTurn as unknown as O;
    }
    throw _parseErr;
  }
}

function makeVerifyCtx<C>(buildCtx: BuildContext<C>): VerifyContext<C> {
  return {
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
}

async function runPostParse<I, O, C>(
  op: RunOperation<I, O, C> | CompleteOperation<I, O, C>,
  parsed: O,
  input: I,
  buildCtx: BuildContext<C>,
): Promise<O> {
  if (!op.verify && !op.recover) return parsed;

  const verifyCtx = makeVerifyCtx(buildCtx);

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
  return runPostParse(op as unknown as RunOperation<I, O, C> | CompleteOperation<I, O, C>, parsed, input, buildCtx);
}
