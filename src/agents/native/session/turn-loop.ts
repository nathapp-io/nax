/**
 * The native turn loop.
 *
 * nax owns the conversation, so a turn is: append the prompt, call the model,
 * and while it asks for tools, execute them and call again. Tools are executed
 * through the InteractionHandler the ACP adapter already uses — this file never
 * touches the context engine.
 *
 * The public types this loop consumes (`TurnDeps`, `NativeTurnResponse`,
 * `NativeSummaryResponse`) and the failure-usage ledger
 * (`readNativeTurnFailureUsage` / `recordNativeTurnFailureUsage`) live in
 * `./turn-types.ts`. Splitting them out keeps this file focused on the
 * algorithm and below the 600-line hard limit (project-conventions.md).
 *
 * The round-trip loop and the `before_turn_end` continuation decision live in
 * `./turn-loop-round-trip.ts` (complexity drain A2,
 * docs/plans/STATUS-complexity-drain.md) — this file does setup (transcript
 * load, event registry, `before_turn`), sequences the outer while(true) over
 * those two phases, and handles the error/completion tail.
 */

import type { InteractionExchange, SendTurnOpts, SessionHandle, TurnResult } from "@/agents/session-types";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { askHumanToolDefinition } from "./ask-human";
import type { TranscriptMessage as NativeTranscriptMessage } from "./compaction";
import { createInvalidCallBudget } from "./handle-invalid-tool-call";
import { createLoopEventRegistry } from "./loop-events";
import { applyHistoryPatch } from "./loop-events/cache-boundary";
import { registerBuiltinLoopHandlers } from "./loop-handlers";
import { nativeSessionTranscriptOwners, nativeTranscriptDirs, sessionAnchorFor } from "./session";
import { codingToolsToDefinitions, toToolDefinitions } from "./tool-mapping";
import { loadTranscript, saveTranscript, type TranscriptIdentity, transcriptModelIdentity } from "./transcript-store";
import { createTurnAccumulator } from "./turn-accumulator";
import { dispatchTurnEndOnError } from "./turn-end-event";
import type { SpinFlags, TurnLoopState, TurnRoundParams } from "./turn-loop-round-trip";
import { runRoundTripLoop, runTurnEndPhase } from "./turn-loop-round-trip";
import { buildTurnResult, logTurnTailWarnings } from "./turn-result";
import { recordNativeTurnFailureUsage, type TurnDeps } from "./turn-types";

/**
 * The messages `before_turn` appends as the turn's seed: the handler's patch
 * when it is a non-empty user-role array (spec 6.1's stop rule), otherwise the
 * prompt the caller handed the turn. A bad patch is rejected the way a bad
 * history patch is — warn, original kept (spec 3.7) — because a seed that is
 * empty or speaks with another role hands the model a conversation it cannot
 * answer as itself.
 */
function beforeTurnSeed(
  patch: readonly NativeTranscriptMessage[] | undefined,
  prompt: string,
): NativeTranscriptMessage[] {
  if (patch === undefined) return [{ role: "user", content: prompt }];
  if (patch.length > 0 && patch.every((m) => m.role === "user")) return [...patch];
  getSafeLogger()?.warn(
    "native-loop-events",
    "before_turn seed patch rejected: seed must be a non-empty user-role array",
    { seedLength: patch.length },
  );
  return [{ role: "user", content: prompt }];
}

export async function runNativeTurn(
  handle: SessionHandle,
  prompt: string,
  opts: SendTurnOpts,
  deps: TurnDeps,
): Promise<TurnResult> {
  const dir = nativeTranscriptDirs.get(handle.id);
  if (dir === undefined) {
    throw new NaxError(`no transcript directory for session "${handle.id}"`, "NATIVE_TRANSCRIPT_DIR_MISSING", {
      stage: "native-session",
    });
  }

  // nax#1877: an owner mismatch reads as a new conversation, so an abandoned
  // invocation's history cannot ride along on the first request of this one.
  // nax#2150 (P3 spec 8.3): so does a recorded different model — the store
  // owns that guarantee, whatever the session layer above decided.
  const transcriptIdentity: TranscriptIdentity = {
    owner: nativeSessionTranscriptOwners.get(handle.id),
    model: transcriptModelIdentity(handle.modelDef?.model),
  };
  let messages: NativeTranscriptMessage[] = [...(await loadTranscript(dir, handle.id, transcriptIdentity))];

  // nax#2151: the invalid-call repair and the spin breaker are `before_tool`
  // registrations rather than inline branches. Absent a caller-supplied
  // registry the loop owns one, so both built-ins run exactly as they did
  // before the seam. The block sits above `before_turn` now: the dispatch
  // needs the registry, and the built-ins must be installed before ANY event
  // fires, exactly as they were installed before any round trip ran.
  const spinFlags: SpinFlags = { stopped: false, warned: false };
  const invalidCallBudget = createInvalidCallBudget();
  const loopEvents = deps.loopEvents ?? createLoopEventRegistry();
  registerBuiltinLoopHandlers(loopEvents, {
    sessionName: handle.id,
    budget: invalidCallBudget,
    ...(deps.spinBreaker !== undefined ? { spinBreaker: deps.spinBreaker } : {}),
    onSpinStop: () => {
      spinFlags.warned = true;
    },
  });

  const anchor = sessionAnchorFor(handle.id, transcriptIdentity.model);
  const lastUsage = anchor?.promptTokens !== undefined ? { promptTokens: anchor.promptTokens } : undefined;
  const anchorIndex = anchor?.anchorIndex;

  // P3 `before_turn` (spec 6.1): fires ONCE, after the transcript loads and
  // before the seed push. `boundary` is dispatcher-computed (spec 3.4) and
  // always false: the model-change boundary never arises, because the
  // transcript store refuses another model's history (spec 8.3), so the
  // history channel is honoured only at an undefined anchor (spec 3.5) — an
  // off-boundary patch is rejected + warned by applyHistoryPatch and the turn
  // proceeds on the loaded history.
  const turnStart = await loopEvents.dispatch("before_turn", {
    prompt,
    history: messages,
    sessionName: handle.id,
    boundary: false,
  });
  // An honoured history patch (reachable only at an undefined anchor today)
  // rewrites the IN-MEMORY array, and the saveTranscript at the turn's end
  // persists it — before_turn is the conversation-rewriting event, unlike
  // transform_context's wire-copy-only ruling (spec 6.6).
  messages = [
    ...applyHistoryPatch({
      before: messages,
      patched: turnStart.history,
      anchorIndex,
      boundary: false,
      event: "before_turn",
    }).messages,
  ];
  messages.push(...beforeTurnSeed(turnStart.seed, prompt));

  const codingTools = opts.codingTools ?? [];
  const codingToolNames = new Set(codingTools.map((t) => t.name));
  // Native spends the budget ONLY on ask_human exchanges. Unlike ACP it is
  // not this loop's bound — the loop is `while (true)`, bounded by the
  // whole-turn deadline and the idle watchdog (issue #1820).
  //
  // Advertised only while the Q&A budget can still be spent; a tool the model
  // cannot successfully call is worse than no tool.
  const maxInteractions = opts.maxInteractions ?? 0;
  const tools = [
    ...toToolDefinitions(opts.contextPullTools ?? []),
    ...codingToolsToDefinitions(codingTools),
    ...(maxInteractions > 0 ? [askHumanToolDefinition] : []),
  ];

  const usage = createTurnAccumulator();
  // Reported on the result so the review guards can corroborate a reviewer's
  // self-declared inspection trail against calls it actually made.
  const codingToolsCalled: string[] = [];
  const interactions: InteractionExchange[] = [];

  const params: TurnRoundParams = {
    handle,
    opts,
    deps,
    transcriptModel: transcriptIdentity.model,
    tools,
    codingToolNames,
    loopEvents,
    invalidCallBudget,
    spinBreaker: deps.spinBreaker,
    spinFlags,
    maxInteractions,
    interactions,
    codingToolsCalled,
    usage,
  };

  let state: TurnLoopState = {
    messages,
    lastUsage,
    anchorIndex,
    roundTrips: 0,
    output: "",
    // Set ONLY on the clean exit — the model returned no further tool calls.
    // Every other way out of the loop (the deadline, or an abort) leaves work
    // the model asked for unexecuted.
    completedNormally: false,
    timedOut: false,
    // `before_turn_end`'s followUp injections so far this turn (spec 6.4) —
    // reset every turn, capped at MAX_FOLLOW_UPS_PER_TURN.
    followUpsSoFar: 0,
  };

  // nax#1838: the save below the loop is the clean exit's alone. A turn that
  // throws must persist too — the retry reopens the same deterministic session
  // name, so an unsaved conversation is one the model silently resumes without.
  try {
    // The OUTER loop is `before_turn_end`'s followUp continuation (spec 6.4):
    // an honoured followUp re-enters the round-trip loop via runRoundTripLoop
    // instead of building the turn's result — the result is built when the
    // turn ENDS.
    while (true) {
      // Mutates `state` in place, including up to the point of a throw — see
      // runRoundTripLoop's own header for why this is not `state = await ...`.
      await runRoundTripLoop(state, params);
      const turnEnd = await runTurnEndPhase(state, params);
      if (turnEnd.action === "break") break;
      state = turnEnd.state;
    }
  } catch (err) {
    // Review #20: the event fires on EVERY ending, so a throwing turn
    // dispatches it before the transcript save — a handler sees the failure
    // ending with `ended: "aborted"` (signal fired) or `"errored"`, and its
    // result is ignored: there is no turn left to continue. A rejecting
    // dispatch must not replace the original error or skip the save below —
    // it is logged and skipped, the same skip-not-fail contract the registry
    // applies to a single throwing handler.
    await dispatchTurnEndOnError(
      loopEvents,
      {
        messages: state.messages,
        roundTrips: state.roundTrips,
        stopped: spinFlags.stopped || invalidCallBudget.exceeded || state.timedOut,
        followUpsSoFar: state.followUpsSoFar,
      },
      deps.signal,
    ).catch((dispatchErr: unknown) => {
      getSafeLogger()?.warn("native-loop-events", "before_turn_end dispatch failed on the error path; skipping it", {
        sessionName: handle.id,
        error: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
      });
    });
    // Best-effort, and deliberately unlike the clean-exit save: there a write
    // failure fails the turn, because continuing on unstored history is silent
    // degradation. Here a failure is already in flight, and masking it with a
    // write error would lose the cause.
    await saveTranscript(dir, handle.id, state.messages, transcriptIdentity).catch((saveErr: unknown) => {
      getSafeLogger()?.warn("native-adapter", "could not persist the transcript of a failed turn", {
        sessionName: handle.id,
        error: saveErr instanceof Error ? saveErr.message : String(saveErr),
      });
    });
    // nax#1840: attach what was already spent, keyed on the error's own
    // identity so the error itself is rethrown byte-for-byte unmodified.
    if (typeof err === "object" && err !== null) {
      recordNativeTurnFailureUsage(err, {
        tokenUsage: usage.tokens(),
        costUsd: usage.costUsd(),
      });
    }
    throw err;
  }

  logTurnTailWarnings({
    sessionName: handle.id,
    completedNormally: state.completedNormally,
    spinStopped: spinFlags.stopped,
    roundTrips: state.roundTrips,
    timedOut: state.timedOut,
    spinBreaker: deps.spinBreaker,
    invalidCallHalt: invalidCallBudget.halt,
  });

  // Persisted before returning, and a write failure fails the turn: continuing
  // on a history that could not be stored is the silent degradation #1794
  // removed from the pipeline (ADR-028 s4).
  await saveTranscript(dir, handle.id, state.messages, transcriptIdentity);

  return buildTurnResult({
    output: state.output,
    usage,
    roundTrips: state.roundTrips,
    codingTools,
    codingToolsCalled,
    completedNormally: state.completedNormally,
    timedOut: state.timedOut,
    spinStopped: spinFlags.stopped,
    invalidCallHalt: invalidCallBudget.halt,
    interactions,
    pricingSource: deps.pricingSource,
  });
}
