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
 */

import { inputClassTokens } from "@/agents/cost";
import type { InteractionExchange, SendTurnOpts, SessionHandle, TurnResult } from "@/agents/session-types";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { askHumanToolDefinition } from "./ask-human";
import { estimateContextTokens, type TranscriptMessage as NativeTranscriptMessage, shouldCompact } from "./compaction";
import { createInvalidCallBudget } from "./handle-invalid-tool-call";
import { createLoopEventRegistry } from "./loop-events";
import { registerBuiltinLoopHandlers } from "./loop-handlers";
import { nativeSessionLastUsage, nativeSessionTranscriptOwners, nativeTranscriptDirs } from "./session";
import { codingToolsToDefinitions, toToolDefinitions } from "./tool-mapping";
import { loadTranscript, saveTranscript } from "./transcript-store";
import { createTurnAccumulator, usageBeat } from "./turn-accumulator";
import { runProactiveCompaction } from "./turn-compaction-step";
import { completeWithRecovery } from "./turn-complete-step";
import { buildTurnResult, logTurnTailWarnings } from "./turn-result";
import { runToolBatch } from "./turn-tool-batch";
import { recordNativeTurnFailureUsage, type TurnDeps } from "./turn-types";

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
  const transcriptOwner = nativeSessionTranscriptOwners.get(handle.id);
  let messages: NativeTranscriptMessage[] = [...(await loadTranscript(dir, handle.id, transcriptOwner))];
  messages.push({ role: "user", content: prompt });

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

  let roundTrips = 0;
  const usage = createTurnAccumulator();
  let output = "";
  // Reported on the result so the review guards can corroborate a reviewer's
  // self-declared inspection trail against calls it actually made.
  const codingToolsCalled: string[] = [];
  // Set ONLY on the clean exit — the model returned no further tool calls.
  // Every other way out of the loop (the deadline, or an abort) leaves work
  // the model asked for unexecuted.
  let completedNormally = false;
  let timedOut = false;
  const interactions: InteractionExchange[] = [];

  const spinBreaker = deps.spinBreaker;
  // Set ONLY when the breaker ended the turn, so the wiring layer can classify
  // it as `fail-spin` rather than a generic incomplete turn.
  let spinStopped = false;
  // nax#2120: the first stop verdict spends a terminal round trip rather than
  // tearing the turn down, so a false positive does not cost the transcript.
  let spinWarned = false;
  const invalidCallBudget = createInvalidCallBudget();
  // nax#2151: the invalid-call repair and the spin breaker are `before_tool`
  // registrations rather than inline branches. Absent a caller-supplied
  // registry the loop owns one, so both built-ins run exactly as they did
  // before the seam.
  const loopEvents = deps.loopEvents ?? createLoopEventRegistry();
  registerBuiltinLoopHandlers(loopEvents, {
    budget: invalidCallBudget,
    ...(spinBreaker !== undefined ? { spinBreaker } : {}),
    onSpinStop: () => {
      spinWarned = true;
    },
  });

  const anchor = nativeSessionLastUsage.get(handle.id);
  let lastUsage = anchor?.promptTokens !== undefined ? { promptTokens: anchor.promptTokens } : undefined;
  let anchorIndex = anchor?.anchorIndex;

  // nax#1838: the save below the loop is the clean exit's alone. A turn that
  // throws must persist too — the retry reopens the same deterministic session
  // name, so an unsaved conversation is one the model silently resumes without.
  try {
    // Deliberately unbounded by COUNT of varied calls. A coding agent working a
    // story is bounded by wall clock (deps.deadline), by the idle watchdog, and
    // — since nax#2013 — by the spin breaker, which ends a turn that keeps
    // REPEATING a call it already made. `agent.maxInteractionTurns` is NOT this
    // budget — it bounds human Q&A exchanges, which are counted separately.
    while (true) {
      // Checked before starting a round-trip rather than after finishing one:
      // starting a call we know cannot finish inside the budget spends money for
      // an answer we will discard.
      if (deps.deadline?.expired() === true) {
        timedOut = true;
        break;
      }

      // Compaction runs at most once per round trip. That bound is what stops a
      // compact-still-over-compact loop when the pinned prompt alone is too large.
      // Read below by the overflow-retry backstop (`canRetry = ... &&
      // !summarizeFailed && ...`), which suppresses a doomed retry after the
      // summarizer has already failed this round trip.
      let summarizeFailed = false;
      if (
        deps.summarize !== undefined &&
        deps.contextWindow !== undefined &&
        deps.compaction !== undefined &&
        shouldCompact(estimateContextTokens(messages, lastUsage, anchorIndex), deps.contextWindow, deps.compaction)
      ) {
        const step = await runProactiveCompaction({
          messages,
          usage,
          sessionName: handle.id,
          lastUsage,
          anchorIndex,
          // Copied, not the `deps` object itself: the guard above narrows the
          // three properties to defined, and a fresh object is what carries that
          // narrowing into the step's `CompactionStepDeps` parameter.
          deps: {
            summarize: deps.summarize,
            contextWindow: deps.contextWindow,
            compaction: deps.compaction,
            onActivity: deps.onActivity,
            deadline: deps.deadline,
          },
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        });
        messages = [...step.messages];
        summarizeFailed = step.summarizeFailed;
        if (step.compacted) {
          // The anchor described the pre-compaction array; it is meaningless now.
          lastUsage = undefined;
          anchorIndex = undefined;
        }
      }
      const step = await completeWithRecovery({
        messages,
        tools,
        usage,
        summarizeFailed,
        sessionName: handle.id,
        lastUsage,
        anchorIndex,
        // The loop's local, not deps.loopEvents — the same registry runToolBatch
        // below receives, so both dispatch seams observe the same handlers.
        loopEvents,
        roundTrip: roundTrips,
        ...(handle.modelDef?.model !== undefined ? { model: handle.modelDef.model } : {}),
        deps,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      const res = step.res;
      messages = [...step.messages];
      if (step.compacted) {
        // The anchor described the pre-compaction array; it is meaningless now.
        lastUsage = undefined;
        anchorIndex = undefined;
      }
      roundTrips += 1;
      usage.add(res.usage, res.costUsd, res.rates);
      output = res.text;

      // nax#1852: the anchor is the whole prompt the provider charged for, not
      // just its uncached portion. Under prompt caching (which the round trip
      // above always requests) the cached prefix arrives in the cache fields,
      // and counting inputTokens alone reads a 71k-token context as ~16.
      const promptTokens = inputClassTokens(res.usage);
      lastUsage = { promptTokens };
      anchorIndex = messages.length - 1;
      nativeSessionLastUsage.set(handle.id, { promptTokens, anchorIndex });

      // 1-based; `roundTrips` is incremented above, before this beat fires.
      deps.onActivity?.(usageBeat(res.usage, res.costUsd, roundTrips));
      if (res.text.length > 0) deps.onActivity?.({ kind: "message", bytes: res.text.length });
      if (res.thinking !== undefined && res.thinking.length > 0) {
        deps.onActivity?.({
          kind: "thinking",
          bytes: res.thinking.reduce((n, t) => n + t.text.length, 0),
        });
      }

      // Thinking blocks are appended, not merely representable: Anthropic needs
      // the exact block back to continue a thinking conversation (ADR-028 s8).
      messages.push({
        role: "assistant",
        content: res.text,
        ...(res.toolCalls !== undefined ? { toolCalls: res.toolCalls } : {}),
        ...(res.thinking !== undefined ? { thinking: res.thinking } : {}),
      });

      if (res.toolCalls === undefined || res.toolCalls.length === 0) {
        completedNormally = true;
        break;
      }

      const batch = await runToolBatch({
        messages,
        toolCalls: res.toolCalls,
        tools,
        codingToolNames,
        roundTrips,
        sessionName: handle.id,
        opts,
        deps,
        loopEvents,
        invalidCallBudget,
        spinBreaker,
        maxInteractions,
        spinWarned,
        interactionsSoFar: interactions.length,
      });
      messages = [...batch.messages];
      interactions.push(...batch.interactions);
      codingToolsCalled.push(...batch.codingToolsCalled);
      if (batch.spinStopped) spinStopped = true;
      if (batch.spinStopped) break;
      if (batch.budgetExceeded) break;
    }
  } catch (err) {
    // Best-effort, and deliberately unlike the clean-exit save: there a write
    // failure fails the turn, because continuing on unstored history is silent
    // degradation. Here a failure is already in flight, and masking it with a
    // write error would lose the cause.
    await saveTranscript(dir, handle.id, messages, transcriptOwner).catch((saveErr: unknown) => {
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
    completedNormally,
    spinStopped,
    roundTrips,
    timedOut,
    spinBreaker,
  });

  // Persisted before returning, and a write failure fails the turn: continuing
  // on a history that could not be stored is the silent degradation #1794
  // removed from the pipeline (ADR-028 s4).
  await saveTranscript(dir, handle.id, messages, transcriptOwner);

  return buildTurnResult({
    output,
    usage,
    roundTrips,
    codingTools,
    codingToolsCalled,
    completedNormally,
    timedOut,
    spinStopped,
    budgetExceeded: invalidCallBudget.exceeded,
    interactions,
    pricingSource: deps.pricingSource,
  });
}
