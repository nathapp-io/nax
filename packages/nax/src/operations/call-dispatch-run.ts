/**
 * callOpDispatch's run-kind phase (extracted from call.ts for the A6
 * cognitive-complexity drain, docs/plans/STATUS-complexity-drain.md).
 *
 * Behaviour-preserving move of the `kind:"run"` branch (ADR-019 §5): run
 * options + hop-context assembly, the parse-retry senders, the hop dispatch,
 * and the two exhausted-output ladders (empty output; parse failure).
 *
 * MUTATION RULE (the A2 lesson, docs/plans/STATUS-complexity-drain.md §9.3):
 * `RunRetryState` is created once per dispatch and MUTATED IN PLACE by
 * `sendWithParseRetry`, which runs deep inside the hop — the values must
 * still be there when the outcome handlers read them after runWithFallback
 * returns, so the state object is never swapped for a fresh one. This
 * mirrors the original three closure `let`s exactly.
 *
 * The injectable `_callOpDeps` seam arrives by reference as `params.deps` —
 * it stays defined in `call.ts` because the operations barrel re-exports it
 * for tests to mutate; importing it here would cycle back to call.ts.
 */

import type { RetryStrategy } from "../agents/retry";
import { ParseValidationError } from "../agents/retry";
import type { TurnResult } from "../agents/types";
import type { AdapterFailure } from "../context/engine";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import type { UserStory } from "../prd";
import { storyExecRoot } from "../runtime/packages";
import type { BuildHopCallbackContext } from "./build-hop-callback";
import type { CallOpDeps, DispatchPrologue } from "./call-dispatch-prologue";
import { throwAborted, throwNoDispatch } from "./call-dispatch-prologue";
import { normalizeHopOutput } from "./call-hop-output";
import {
  MAX_COMPLETE_RETRY_ATTEMPTS,
  normalizeRunOutcome,
  recordAdapterFailure,
  recordDispatchOutcome,
  resolveOpRetry,
  synthesizeStory,
} from "./call-resolvers";
import { buildRunDispatchOptions } from "./call-run-options";
import { makeVerifyCtx, runPostParse } from "./post-parse";
import type { BuildContext, CallContext, RunOperation } from "./types";
import { resolveDeclaredTools } from "./types";

export interface RunDispatchParams<I, O, C> {
  readonly ctx: CallContext;
  readonly op: RunOperation<I, O, C>;
  readonly input: I;
  readonly prologue: DispatchPrologue<C>;
  readonly deps: CallOpDeps;
}

/**
 * Shared mutable retry state for one run-kind dispatch. Written by
 * `sendWithParseRetry` (inside the hop) and read by the outcome handlers
 * (after runWithFallback returns) — mutate in place, never replace.
 */
export interface RunRetryState {
  /** Captured when the strategy returns { retry: false, fallback }; final O candidate when op.parse also fails. */
  retryFallback: unknown;
  /** Set when sendWithParseRetry exhausts MAX_COMPLETE_RETRY_ATTEMPTS without the strategy self-terminating. */
  maxRetriesExceeded: boolean;
  /** The final TurnResult from the most recent sendWithParseRetry call (only set when a retryStrategy engaged). */
  lastRetryTurn: TurnResult | undefined;
}

interface RunSenderParams<I, O, C> {
  readonly ctx: CallContext;
  readonly op: RunOperation<I, O, C>;
  readonly retryStrategy: RetryStrategy | null;
  readonly dispatchAgent: string;
  readonly abortSignal: AbortSignal;
  readonly fileOutputPath: string | undefined;
  readonly retryState: RunRetryState;
  readonly deps: CallOpDeps;
}

interface RunOutcomeArgs<I, O, C> {
  readonly ctx: CallContext;
  readonly op: RunOperation<I, O, C>;
  readonly input: I;
  readonly buildCtx: BuildContext<C>;
  readonly dispatchAgent: string;
  readonly retryState: RunRetryState;
}

/** Dispatch a `kind:"run"` op through runWithFallback + buildHopCallback. */
export async function dispatchRunOp<I, O, C>(params: RunDispatchParams<I, O, C>): Promise<O> {
  const { ctx, op, input, prologue, deps } = params;
  const { buildCtx, config, prompt, callId, timeoutMs, abortSignal, effectiveTier, resolved, sessionRole } = prologue;
  const { agent: dispatchAgent, modelDef: dispatchModelDef, startDepth } = prologue.target;

  // ADR-019 §5: route through runWithFallback + buildHopCallback. This restores
  // cross-agent fallback (Finding 1), wires the hop through AgentManager.runAsSession
  // so middleware fires (Finding 5), and lets op.noFallback short-circuit the swap
  // branch (Finding 6).
  const story = ctx.story ?? synthesizeStory(ctx.storyId);

  // Resolve run-kind retry strategy once before the first send.
  // op.retry and op.hopBody compose: when both are set, the user body receives
  // ctx.sendWithParseRetry which applies this strategy per call.
  const retryStrategy = resolveOpRetry(op, input, buildCtx);

  // op.fileOutput: when set, callOp reads this file after each agent send and
  // replaces the turn's text output with the file content before the probe fires.
  // This makes the retry probe check the actual written file, not the text
  // confirmation — so retries only fire when the file is missing or invalid.
  const fileOutputPath = op.fileOutput?.(input);
  const keepOpen = op.keepOpen?.(input, buildCtx) ?? op.session.lifetime === "warm";

  const runOptions = buildRunDispatchOptions(ctx, {
    prompt,
    effectiveTier,
    dispatchModelDef,
    timeoutMs,
    config,
    sessionRole,
    callId,
    pipelineStage: op.stage,
    declaredTools: resolveDeclaredTools(op),
    toolPatterns: op.toolPatterns,
    fileOutputPath,
    keepOpen,
  });

  // Shared hop-callback context — everything except runOptions and hopBody.
  const hopCtx = buildHopContext(params, story);

  const retryState: RunRetryState = {
    retryFallback: undefined,
    maxRetriesExceeded: false,
    lastRetryTurn: undefined,
  };
  const { effectiveHopBody } = createRunSenders({
    ctx,
    op,
    retryStrategy,
    dispatchAgent,
    abortSignal,
    fileOutputPath,
    retryState,
    deps,
  });

  // buildHopCallback sees only { send, input } — retry wiring stays inside callOp.
  const executeHop = deps.buildHopCallback(
    {
      ...hopCtx,
      hopBody: effectiveHopBody as NonNullable<BuildHopCallbackContext["hopBody"]>,
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
      noFallback: op.noFallback,
      bundle: ctx.contextBundle,
      startDepth,
    },
    dispatchAgent,
  );
  const outcome = normalizeRunOutcome(rawOutcome);

  // nax#1707: this is the only point where agent-swap hops are both available and
  // attributable to a story. `outcome.result` is not that carrier — post-run.ts
  // rebuilds ctx.agentResult from the implementer's phase output, so anything left
  // on the AgentResult here is dropped before metrics run. Record on the run-scoped
  // store instead, so hops from every op in the story reach StoryMetrics.fallback on the
  // sequential success path. Parallel and failed stories build metrics elsewhere and do
  // not read this yet — see #1709.
  recordDispatchOutcome(ctx, outcome, resolved.modelTier, sessionRole);
  recordAdapterFailure(ctx, outcome.result.adapterFailure);

  // US-001: zero-dispatch guard. Fires AFTER recording (AC9) and BEFORE parse,
  // recover, exhaustedFallback, and the empty-output check, so each of those
  // escape hatches stays reserved for the completed-dispatch case.
  if (outcome.dispatchesCompleted === 0) {
    throwNoDispatch(op, ctx.storyId, dispatchAgent);
  }

  // Abort check: if the signal was aborted during the hop (e.g. in sendWithParseRetry),
  // buildHopCallback's catch swallowed it. Surface it here before parse runs.
  if (abortSignal?.aborted) {
    throwAborted(op, ctx.storyId, "aborted");
  }

  const rawOutput = outcome.result.output;
  const totalCost = outcome.result.estimatedCostUsd ?? 0;

  if (!rawOutput) {
    return handleRunEmptyOutput({ ctx, op, input, buildCtx, dispatchAgent, retryState, totalCost });
  }
  return parseRunOutcome({ ctx, op, input, buildCtx, dispatchAgent, retryState, totalCost, outcome, rawOutput });
}

/** The BuildHopCallbackContext literal forwarded to `_callOpDeps.buildHopCallback`. */
function buildHopContext<I, O, C>(params: RunDispatchParams<I, O, C>, story: UserStory): BuildHopCallbackContext {
  const { ctx, op, prologue } = params;
  const { config, effectiveTier, defaultAgent } = prologue;
  const { agent: dispatchAgent } = prologue.target;
  return {
    sessionManager: ctx.runtime.sessionManager,
    agentManager: ctx.runtime.agentManager,
    story,
    config,
    projectDir: ctx.runtime.projectDir,
    featureName: ctx.featureName ?? "",
    workdir: storyExecRoot(ctx.packageView),
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
    pinnedModelAgent: dispatchAgent,
    pipelineStage: op.stage,
    ...(ctx.interactionBridge ? { interactionBridge: ctx.interactionBridge } : {}),
    ...(ctx.maxInteractionTurns !== undefined ? { maxInteractionTurns: ctx.maxInteractionTurns } : {}),
  };
}

/**
 * Builds the send closures for one run-kind dispatch. `sendWithFileOutput`
 * substitutes file output for the turn text; `sendWithParseRetry` applies the
 * strategy inside one session turn; `effectiveHopBody` wraps the user's body
 * with both injected. All three read `deps` at call time and mutate
 * `retryState` in place — never returning replacement state.
 */
function createRunSenders<I, O, C>(
  params: RunSenderParams<I, O, C>,
): {
  effectiveHopBody: (
    initialPrompt: string,
    bodyCtx: { send: (p: string) => Promise<TurnResult>; input: unknown },
  ) => Promise<TurnResult>;
} {
  const { ctx, op, retryStrategy, dispatchAgent, abortSignal, fileOutputPath, retryState, deps } = params;

  // Synthesizes an AdapterFailure for empty output / provider refusal so the
  // manager-tier retry/swap logic handles transient agent stalls uniformly
  // (spec §B1) — see call-hop-output.ts for the full rationale.
  const sendWithFileOutput = (
    promptText: string,
    bodyCtx: { send: (p: string) => Promise<TurnResult> },
  ): Promise<TurnResult> =>
    normalizeHopOutput(bodyCtx.send, promptText, {
      storyId: ctx.storyId,
      opName: op.name,
      dispatchAgent,
      fileOutputPath,
      readFileOutput: deps.readFileOutput,
    });

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
    retryState.retryFallback = undefined;
    retryState.maxRetriesExceeded = false;
    retryState.lastRetryTurn = undefined;
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
          retryState.retryFallback = decision.fallback;
        }
        const result = { ...lastTurn, estimatedCostUsd: cumCost };
        retryState.lastRetryTurn = result;
        return result;
      }
      if (abortSignal?.aborted) {
        throwAborted(op, ctx.storyId, "aborted during retry");
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
      await deps.sleep(decision.delayMs, abortSignal);
      if (abortSignal?.aborted) {
        throwAborted(op, ctx.storyId, "aborted during retry sleep");
      }
      currentPrompt = decision.nextPrompt ?? initialPrompt;
      attempt++;
    }
    // Hard ceiling hit — strategy didn't self-terminate.
    retryState.maxRetriesExceeded = true;
    const exhaustedResult = { ...lastTurn, estimatedCostUsd: cumCost };
    retryState.lastRetryTurn = exhaustedResult;
    return exhaustedResult;
  };

  // effectiveHopBody: wraps the user's body with sendWithParseRetry injected as
  // ctx.sendWithParseRetry. When no user body, sendWithParseRetry is the body.
  const effectiveHopBody = (
    initialPrompt: string,
    bodyCtx: { send: (p: string) => Promise<TurnResult>; input: unknown },
  ): Promise<TurnResult> => {
    if (op.hopBody) {
      return op.hopBody(initialPrompt, {
        send: (p) => sendWithFileOutput(p, bodyCtx),
        sendWithParseRetry: (p) => sendWithParseRetry(p, bodyCtx),
        input: bodyCtx.input as I,
      });
    }
    return sendWithParseRetry(initialPrompt, bodyCtx);
  };

  return { effectiveHopBody };
}

/**
 * US-001: attach `outcome.adapterFailure` to `parsed` when:
 *   - the outcome carries one
 *   - `parsed` is a non-null object
 *   - `parsed` does not already carry its own `adapterFailure`
 *
 * Primitive `parsed` values (strings, numbers, null) are returned unchanged —
 * the spec pins "the same string" for AC8. A producer's own `adapterFailure`
 * (e.g. synthesised inside `op.verify` or `op.parse`) wins per AC7 — we never
 * overwrite producer metadata.
 */
export function attachOutcomeAdapterFailure<O>(parsed: O, outcomeFailure: AdapterFailure | undefined): O {
  if (!outcomeFailure) return parsed;
  if (parsed === null || typeof parsed !== "object") return parsed;
  const asRecord = parsed as Record<string, unknown>;
  if (asRecord.adapterFailure !== undefined) return parsed;
  return { ...asRecord, adapterFailure: outcomeFailure } as O;
}

/** The parse ladder's first rung: retry budget exhausted with no output to show. */
function throwRunRetryBudget(
  op: { name: string; stage: import("../config/permissions").PipelineStage },
  storyId: string | undefined,
): never {
  throw new NaxError(
    `callOp[${op.name}]: CALL_OP_MAX_RETRIES — exceeded MAX_COMPLETE_RETRY_ATTEMPTS (${MAX_COMPLETE_RETRY_ATTEMPTS})`,
    "CALL_OP_MAX_RETRIES",
    { stage: op.stage, storyId },
  );
}

/** Both exhaustedFallback ladders share the "fallback must be a plain object" rule. */
function validatedFallbackRecord(
  op: { name: string; stage: import("../config/permissions").PipelineStage },
  storyId: string | undefined,
  fallback: unknown,
): object {
  if (typeof fallback !== "object" || fallback === null) {
    throw new NaxError(
      `callOp[${op.name}]: exhaustedFallback returned a non-object (${typeof fallback}); fallback must be a plain object`,
      "CALL_OP_INVALID_FALLBACK",
      { stage: op.stage, storyId },
    );
  }
  return fallback;
}

/** The empty-output ladder: budget → fallback → recover → CALL_OP_NO_OUTPUT. */
async function handleRunEmptyOutput<I, O, C>(
  args: RunOutcomeArgs<I, O, C> & { readonly totalCost: number },
): Promise<O> {
  const { ctx, op, input, buildCtx, dispatchAgent, retryState, totalCost } = args;
  if (retryState.maxRetriesExceeded) {
    getSafeLogger()?.error("callop", "Op retry budget exhausted (empty output)", {
      storyId: ctx.storyId,
      opName: op.name,
      site: "run" as const,
      totalAttempts: MAX_COMPLETE_RETRY_ATTEMPTS + 1,
    });
    throwRunRetryBudget(op, ctx.storyId);
  }
  if (retryState.retryFallback !== undefined) {
    const fallback = validatedFallbackRecord(op, ctx.storyId, retryState.retryFallback);
    getSafeLogger()?.warn("callop", "Returning exhaustedFallback on empty output", {
      storyId: ctx.storyId,
      opName: op.name,
      agentName: dispatchAgent,
    });
    return { ...fallback, estimatedCostUsd: totalCost } as O;
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

/**
 * The authoritative post-hop parse. runPostParse sits outside the try-catch in
 * spirit so verify/recover errors propagate normally rather than being
 * misidentified as parse failures; the catch owns only op.parse itself.
 *
 * Note: when op.retry is set, the strategy has already validated internally.
 * This second parse via op.parse() produces the typed O. Strategy `validate`
 * and `op.parse` MUST agree on validity — disagreement causes drift between
 * retry decisions and final output.
 */
async function parseRunOutcome<I, O, C>(
  args: RunOutcomeArgs<I, O, C> & {
    readonly totalCost: number;
    readonly outcome: import("../agents").AgentRunOutcome;
    readonly rawOutput: string;
  },
): Promise<O> {
  const { op, input, buildCtx, outcome, rawOutput } = args;
  try {
    const parsedRun = op.parse(rawOutput, input, buildCtx);
    // US-001: attach the run outcome's adapterFailure to a non-null object
    // parsed value that does not already carry its own. A producer's own
    // adapterFailure (e.g. synthesised by op.verify) wins; a string or
    // primitive parse result is returned unchanged. The acceptance generator
    // is the consumer; other ops that surface adapterFailure on their own
    // are not affected because their parsed value already carries one.
    const parsedRunWithFailure = attachOutcomeAdapterFailure(parsedRun, outcome.result.adapterFailure);
    return await runPostParse(op, parsedRunWithFailure, input, buildCtx);
  } catch (_parseErr) {
    return handleRunParseFailure(args, _parseErr);
  }
}

/** The parse-failure ladder: budget → fallback → recover → TurnResult → rethrow. */
async function handleRunParseFailure<I, O, C>(
  args: RunOutcomeArgs<I, O, C> & {
    readonly totalCost: number;
    readonly outcome: import("../agents").AgentRunOutcome;
    readonly rawOutput: string;
  },
  parseErr: unknown,
): Promise<O> {
  const { ctx, op, input, buildCtx, retryState, totalCost } = args;
  if (retryState.maxRetriesExceeded) {
    getSafeLogger()?.error("callop", "Op retry budget exhausted", {
      storyId: ctx.storyId,
      opName: op.name,
      site: "run" as const,
      totalAttempts: MAX_COMPLETE_RETRY_ATTEMPTS + 1,
    });
    throwRunRetryBudget(op, ctx.storyId);
  }
  if (retryState.retryFallback !== undefined) {
    const fallback = validatedFallbackRecord(op, ctx.storyId, retryState.retryFallback);
    return { ...fallback, estimatedCostUsd: totalCost } as O;
  }
  // When retryStrategy engaged but provided no fallback, prefer op.recover before
  // falling back to envelope passthrough. recover is the disk-recovery escape hatch
  // (#993: silently returning a TurnResult typed-as-O corrupted prd.json).
  let recoverOutcome: "not-declared" | "returned-null" = "not-declared";
  if (op.recover) {
    const verifyCtx = makeVerifyCtx(buildCtx);
    const recovered = await op.recover(input, verifyCtx);
    if (recovered !== null) return recovered;
    recoverOutcome = "returned-null";
  }

  if (retryState.lastRetryTurn !== undefined) {
    // Last-resort envelope passthrough. Logged so silent corruption stops being
    // silent — and `recover` distinguishes "none declared" from "ran and found
    // nothing usable on disk", which the old wording conflated (#2124).
    getSafeLogger()?.warn("callop", "Op exhausted retries with no fallback — returning raw TurnResult", {
      storyId: ctx.storyId,
      opName: op.name,
      site: "run" as const,
      recover: recoverOutcome,
    });
    return retryState.lastRetryTurn as unknown as O;
  }
  throw parseErr;
}
