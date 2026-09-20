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
import { ASK_HUMAN_TOOL_NAME, askHumanToolDefinition } from "./ask-human";
import {
  applyCompaction,
  estimateContextTokens,
  keepBudget,
  type TranscriptMessage as NativeTranscriptMessage,
  prepareCompaction,
  shouldCompact,
} from "./compaction";
import { createInvalidCallBudget, rewriteToolCallInput } from "./handle-invalid-tool-call";
import { createLoopEventRegistry } from "./loop-events";
import { registerBuiltinLoopHandlers } from "./loop-handlers";
import { nudgeOverheadBytes, withNudge } from "./nudge";
import { addRateTotals, aggregateRates, createRateTotals } from "./rate-provenance";
import { nativeSessionLastUsage, nativeSessionTranscriptOwners, nativeTranscriptDirs } from "./session";
import { codingToolsToDefinitions, toToolDefinitions } from "./tool-mapping";
import { buildToolResult } from "./tool-result";
import { loadTranscript, saveTranscript } from "./transcript-store";
import { truncateNativeToolResult } from "./truncation-handler";
import { realSleep, retryTransportFault } from "./turn-retry";
import { cacheUsageFields, type NativeTurnResponse, recordNativeTurnFailureUsage, type TurnDeps } from "./turn-types";

/**
 * Structural, matching adapter.ts's guard: nax-ai's error class is not importable
 * here and the kind is what matters.
 */
function isContextOverflow(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("protocolError" in err)) return false;
  const { protocolError } = err as { protocolError?: { kind?: unknown } };
  return protocolError?.kind === "context-overflow";
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
  let inputTokens = 0;
  let outputTokens = 0;
  // Undefined until the first round trip reports cache data, then a running
  // sum from there. Staying undefined when nothing ever reports it preserves
  // the absent/zero distinction toNaxTokenUsage establishes: "no cache data"
  // and "zero cache tokens" must stay distinguishable downstream.
  let cacheReadInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  let costUsd = 0;
  const rateTotals = createRateTotals();
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
        const preCompactionTokens = estimateContextTokens(messages, lastUsage, anchorIndex);
        const plan = prepareCompaction(messages, keepBudget(deps.contextWindow, deps.compaction));
        if (plan !== undefined) {
          try {
            const summary = await deps.summarize(plan.toSummarize, plan.previousSummary);
            // Rebound, not spliced in place: `messages` is a local accumulator and
            // rebinding it keeps the compacted array a fresh value.
            messages = applyCompaction(messages, plan, summary.text);
            // Finding 2 (whole-branch review, 2026-09-04): a previous-summary merge
            // can produce a same-size (or larger) array — a paid model call that
            // shrank nothing. Not fatal (the reactive backstop is the real safety
            // net if this repeats into an overflow) but worth surfacing, since it
            // would otherwise burn a model call every round trip with no signal.
            const postCompactionTokens = estimateContextTokens(messages, undefined, undefined);
            if (postCompactionTokens >= preCompactionTokens) {
              getSafeLogger()?.warn("native-adapter", "compaction made no size progress", {
                sessionName: handle.id,
                preCompactionTokens,
                postCompactionTokens,
              });
            }
            getSafeLogger()?.info("native-adapter", "compaction completed", {
              sessionName: handle.id,
              // Keep token counts under the plural `tokens` metric key so the
              // logger's credential redactor does not mistake them for secrets.
              tokens: { before: preCompactionTokens, after: postCompactionTokens },
              messagesDropped: plan.toSummarize.length,
              summaryLength: summary.text.length,
            });
            inputTokens += summary.usage.inputTokens;
            outputTokens += summary.usage.outputTokens;
            if (summary.usage.cacheReadInputTokens !== undefined) {
              cacheReadInputTokens = (cacheReadInputTokens ?? 0) + summary.usage.cacheReadInputTokens;
            }
            if (summary.usage.cacheCreationInputTokens !== undefined) {
              cacheCreationInputTokens = (cacheCreationInputTokens ?? 0) + summary.usage.cacheCreationInputTokens;
            }
            costUsd += summary.costUsd;
            addRateTotals(rateTotals, summary.usage, summary.rates);
            // Resets the watchdog's lastActivityAt between the summary and the
            // round trip, so the two silent spans do not add up against one budget.
            deps.onActivity?.({
              kind: "usage",
              inputTokens: summary.usage.inputTokens,
              outputTokens: summary.usage.outputTokens,
              costUsd: summary.costUsd,
              ...cacheUsageFields(summary.usage),
            });
            // The anchor described the pre-compaction array; it is meaningless now.
            lastUsage = undefined;
            anchorIndex = undefined;
          } catch (err) {
            if (deps.deadline?.expired() === true || opts.signal?.aborted === true) throw err;
            // Not fatal: the request may still fit, and if it does not it fails
            // through the path #1837 and #1839 made correct. Killing a story
            // because a summarizer hiccuped would be worse than the problem.
            summarizeFailed = true;
            getSafeLogger()?.warn("native-adapter", "compaction summary failed; sending uncompacted", {
              sessionName: handle.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      let res: NativeTurnResponse;
      try {
        res = await deps.complete(messages, tools);
      } catch (err) {
        // Written as one guarded `if` (not a separate `canRetry` boolean) so
        // TypeScript's narrowing carries deps.summarize/contextWindow/compaction
        // as defined below — a boolean flag loses that narrowing.
        if (
          !isContextOverflow(err) ||
          summarizeFailed ||
          deps.summarize === undefined ||
          deps.contextWindow === undefined ||
          deps.compaction === undefined ||
          !deps.compaction.enabled
        ) {
          // nax#1870: not an overflow this branch can handle. One more
          // guarded branch beside the overflow backstop above, not a second
          // loop or a second try/catch here — the retry's own looping and
          // backoff live in retryTransportFault (./turn-retry), called once.
          if (deps.transportRetry === undefined) throw err;
          res = await retryTransportFault(err, {
            attempt: () => deps.complete(messages, tools),
            config: deps.transportRetry,
            deadline: deps.deadline,
            signal: opts.signal,
            sleep: deps.sleep ?? realSleep,
            onRetry: (retryNumber, delayMs, fault) => {
              getSafeLogger()?.warn("native-adapter", `retrying after a ${fault.protocolError.kind} fault`, {
                sessionName: handle.id,
                retryNumber,
                delayMs,
                kind: fault.protocolError.kind,
                message: fault.protocolError.message,
                ...(fault.protocolError.status !== undefined ? { status: fault.protocolError.status } : {}),
                ...(fault.protocolError.retryAfter !== undefined ? { retryAfter: fault.protocolError.retryAfter } : {}),
              });
              // Resets the watchdog's lastActivityAt so a call being retried
              // is not mistaken for an idle one — same mechanism the
              // compaction summary above uses. All-zero is honest, not
              // fabricated: a pre-first-event transport throw bills nothing
              // (see nax-ai's retry.ts), so this beat truly carries zero
              // tokens, not a guessed non-zero number.
              deps.onActivity?.({ kind: "usage", inputTokens: 0, outputTokens: 0, costUsd: 0 });
            },
          });
          // Falls through to the shared round-trip bookkeeping and tool
          // execution below, exactly like the overflow-retry branch's own
          // `res = await deps.complete(...)` two lines down — one success
          // path, reached from either recovery, not a second copy of it.
        } else {
          // Same code path, half the keep budget. Not a second algorithm.
          const plan = prepareCompaction(messages, keepBudget(deps.contextWindow, deps.compaction, true));
          if (plan === undefined) throw err;
          const summary = await deps.summarize(plan.toSummarize, plan.previousSummary);
          messages = applyCompaction(messages, plan, summary.text);
          inputTokens += summary.usage.inputTokens;
          outputTokens += summary.usage.outputTokens;
          if (summary.usage.cacheReadInputTokens !== undefined) {
            cacheReadInputTokens = (cacheReadInputTokens ?? 0) + summary.usage.cacheReadInputTokens;
          }
          if (summary.usage.cacheCreationInputTokens !== undefined) {
            cacheCreationInputTokens = (cacheCreationInputTokens ?? 0) + summary.usage.cacheCreationInputTokens;
          }
          costUsd += summary.costUsd;
          addRateTotals(rateTotals, summary.usage, summary.rates);
          deps.onActivity?.({
            kind: "usage",
            inputTokens: summary.usage.inputTokens,
            outputTokens: summary.usage.outputTokens,
            costUsd: summary.costUsd,
            ...cacheUsageFields(summary.usage),
          });
          lastUsage = undefined;
          anchorIndex = undefined;
          // Retried once. A second overflow propagates: compacting further would be
          // guessing, and the failure now carries a correct diagnosis.
          res = await deps.complete(messages, tools);
        }
      }
      roundTrips += 1;
      inputTokens += res.usage.inputTokens;
      outputTokens += res.usage.outputTokens;
      if (res.usage.cacheReadInputTokens !== undefined) {
        cacheReadInputTokens = (cacheReadInputTokens ?? 0) + res.usage.cacheReadInputTokens;
      }
      if (res.usage.cacheCreationInputTokens !== undefined) {
        cacheCreationInputTokens = (cacheCreationInputTokens ?? 0) + res.usage.cacheCreationInputTokens;
      }
      costUsd += res.costUsd;
      addRateTotals(rateTotals, res.usage, res.rates);
      output = res.text;

      // nax#1852: the anchor is the whole prompt the provider charged for, not
      // just its uncached portion. Under prompt caching (which the round trip
      // above always requests) the cached prefix arrives in the cache fields,
      // and counting inputTokens alone reads a 71k-token context as ~16.
      const promptTokens = inputClassTokens(res.usage);
      lastUsage = { promptTokens };
      anchorIndex = messages.length - 1;
      nativeSessionLastUsage.set(handle.id, { promptTokens, anchorIndex });

      deps.onActivity?.({
        kind: "usage",
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        costUsd: res.costUsd,
        // Absent stays absent (never 0): `cacheReadInputTokens` stays
        // `number | undefined` so "no cache data" and "zero cache tokens"
        // remain distinguishable downstream (nax#2045).
        ...cacheUsageFields(res.usage),
        // 1-based; `roundTrips` is incremented above, before this beat fires.
        roundTrip: roundTrips,
      });
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

      for (const [callIndex, call] of res.toolCalls.entries()) {
        if (spinWarned) {
          spinStopped = true;
          // The terminal round trip is answer-only. Any subsequent tool call
          // is neither executed nor answered; the fail-spin retry starts from
          // a fresh session and deliberately drops this unanswered request.
          break;
        }
        deps.onActivity?.({ kind: "tool", toolName: call.name });
        try {
          if (call.name === ASK_HUMAN_TOOL_NAME) {
            const question = String((call.input as { text?: unknown } | undefined)?.text ?? "");
            // An unset budget (maxInteractions undefined -> 0) keeps the tool unadvertised
            // above AND refuses a call made anyway. "No budget configured" must not
            // read as "unlimited" — that inverts the property this budget provides.
            //
            // These three push sites — and the spin notice below — are answers to
            // a call no tool produced. They use the chokepoint and deliberately
            // fire no `after_tool` event: a policy that shapes tool output has
            // nothing to shape here.
            if (interactions.length >= maxInteractions) {
              messages.push(
                buildToolResult({
                  toolCallId: call.id,
                  content: "The human Q&A budget for this turn is spent. Proceed on your best judgement.",
                  isError: true,
                }),
              );
              continue;
            }
            const answer = await opts.interactionHandler.onInteraction({ kind: "question", text: question });
            // A null answer means no operator is reachable — run-interaction-handler
            // returns null for kind:"question" when no interactionBridge is
            // configured. That is not an exchange: it must not consume budget and
            // must not be recorded as a question the operator answered with "".
            if (answer === null) {
              messages.push(
                buildToolResult({
                  toolCallId: call.id,
                  content: "No human operator is available for this run. Proceed on your best judgement.",
                  isError: true,
                }),
              );
              continue;
            }
            interactions.push({ turnIndex: roundTrips, question, reply: answer.answer });
            messages.push(buildToolResult({ toolCallId: call.id, content: answer.answer }));
            continue;
          }
          const outcome = loopEvents.beforeTool(call, tools);
          // nax#2047 Task 4: a tripped invalid-call budget ends the batch with
          // NO result — "a result nobody reads only grows the transcript". None
          // of the four seam outcomes can express that (each answers the call),
          // so the halt is read from the budget the repair handler counts into,
          // and checked before the outcome is applied.
          if (invalidCallBudget.exceeded) break;
          // The spin breaker's stop is a batch-level outcome (nax#2120): every
          // OUTSTANDING call in this batch is answered, not just the triggering
          // one, or the next `complete()` is sent a tool_call with no matching
          // result, which strict providers reject. Answer-only — the loop
          // continues so the model can close the turn out — and synthetic, so
          // no `after_tool` handler sees it.
          if (outcome.kind === "terminate") {
            for (const outstanding of res.toolCalls.slice(callIndex)) {
              messages.push(
                buildToolResult({
                  toolCallId: outstanding.id,
                  content: outcome.content,
                  isError: outcome.isError,
                }),
              );
            }
            break;
          }
          if (outcome.kind === "block") {
            // Answered on the tool's behalf: the call never runs. A blocked
            // call may still carry a corrected input, which is recorded before
            // the answer — the point of the repair being visible to the model.
            if (outcome.input !== undefined) messages = rewriteToolCallInput(messages, call.id, outcome.input);
            messages.push(buildToolResult({ toolCallId: call.id, content: outcome.content, isError: outcome.isError }));
            continue;
          }
          // `allow` may rewrite the call's input; the rewritten value is what
          // the transcript records and what the tool is invoked with, so the
          // model's own history stays a truthful account of what ran.
          const rewritten = outcome.kind === "allow" ? outcome.input : undefined;
          const input = rewritten ?? call.input;
          if (rewritten !== undefined) messages = rewriteToolCallInput(messages, call.id, rewritten);
          const nudgeText = outcome.kind === "nudge" ? outcome.text : undefined;
          const kind = codingToolNames.has(call.name) ? "coding-tool" : "context-tool";
          if (kind === "coding-tool") codingToolsCalled.push(call.name);
          const answer = await opts.interactionHandler.onInteraction(
            kind === "coding-tool"
              ? {
                  kind,
                  name: call.name,
                  // MUST be `input`, NOT `call.input`. #2162's US-002 added a
                  // `before_tool` `allow` outcome that may REWRITE the input;
                  // the merged line is `input: (input ?? {}) as Record<...>`
                  // where `input = rewritten ?? call.input` (turn-loop.ts:448).
                  // Using `call.input` here runs the tool on the model's
                  // original arguments while `rewriteToolCallInput` has already
                  // recorded the corrected ones — execution and transcript
                  // diverge, silently, with no test in this plan covering it.
                  input: (input ?? {}) as Record<string, unknown>,
                  ...(opts.turnId !== undefined ? { turnId: opts.turnId } : {}),
                  roundTrips,
                  toolCallId: call.id,
                }
              : { kind, name: call.name, input },
          );
          const answerText = answer?.answer ?? "";
          // Genuine execution: the result is shaped by `after_tool` BEFORE it
          // enters the array, which is what makes the event safe by
          // construction (no handler can rewrite history). `denied` is threaded
          // through untouched — a refused Write is not a crashed Write
          // (ADR-029 s5) — and `nudge` prefixes the surviving content.
          const patch = loopEvents.afterTool(call, { content: answerText, denied: answer?.denied });
          // US-003: the model-facing truncation runs at the same chokepoint —
          // after the handlers have had their say, before the message is built
          // — so nothing this policy produces can be rewritten into history
          // either. See ./truncation-handler for why it is not itself a
          // registered handler.
          const shaped = await truncateNativeToolResult(handle.id, patch.content ?? answerText, {
            toolName: call.name,
            callId: call.id,
            // The nudge is prepended below, so its bytes are spent out of this
            // result's budget -- not added after the ceiling was enforced.
            ...(nudgeText !== undefined ? { reserveBytes: nudgeOverheadBytes(nudgeText) } : {}),
          });
          messages.push(
            buildToolResult({
              toolCallId: call.id,
              content: withNudge(nudgeText, shaped),
              isError: patch.isError,
              denied: answer?.denied,
            }),
          );
          // The breaker observed the call through the seam, i.e. with whatever
          // input a handler rewrote in place — so the result has to be noted
          // against that same input, or the key misses and result-based
          // repetition detection silently stops for rewritten calls.
          spinBreaker?.noteResult(call.name, input, answerText);
        } catch (err) {
          // A tool failure is data, not a turn failure: the existing pull-tool
          // contract already surfaces a handler throw as status "error". The
          // event still fires — a policy that bounds result size has to see the
          // results that arrive as errors too.
          const errorText = err instanceof Error ? err.message : String(err);
          const patch = loopEvents.afterTool(call, { content: errorText, isError: true });
          const shaped = await truncateNativeToolResult(handle.id, patch.content ?? errorText, {
            toolName: call.name,
            callId: call.id,
          });
          messages.push(
            buildToolResult({
              toolCallId: call.id,
              content: shaped,
              isError: patch.isError ?? true,
            }),
          );
        }
      }
      if (spinStopped) break;
      if (invalidCallBudget.exceeded) break;
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
        tokenUsage: {
          inputTokens,
          outputTokens,
          ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
          ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
        },
        costUsd,
      });
    }
    throw err;
  }

  // Parity with acp/adapter.ts:555, which warns in exactly this situation. A
  // native turn that stops here is indistinguishable from a finished one
  // without this line plus the `turnIncomplete` fact below.
  if (!completedNormally) {
    getSafeLogger()?.warn("native-adapter", "turn ended with tool calls outstanding", {
      sessionName: handle.id,
      roundTrips,
      timedOut,
    });
  }

  if (spinStopped) {
    getSafeLogger()?.error("native-adapter", "turn ended by the spin breaker", {
      sessionName: handle.id,
      roundTrips,
      ...spinBreaker?.summary(),
    });
  }

  // Persisted before returning, and a write failure fails the turn: continuing
  // on a history that could not be stored is the silent degradation #1794
  // removed from the pipeline (ADR-028 s4).
  await saveTranscript(dir, handle.id, messages, transcriptOwner);

  const rates = aggregateRates(rateTotals);
  return {
    output,
    tokenUsage: {
      inputTokens,
      outputTokens,
      ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
      ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    },
    estimatedCostUsd: costUsd,
    internalRoundTrips: roundTrips,
    ...(codingTools.length > 0 ? { codingToolUse: { advertised: codingTools.length, called: codingToolsCalled } } : {}),
    ...(completedNormally ? {} : { turnIncomplete: true }),
    ...(timedOut ? { timedOut: true } : {}),
    ...(spinStopped ? { spinStopped: true as const } : {}),
    ...(invalidCallBudget.exceeded ? { invalidCallBudgetExceeded: true as const } : {}),
    ...(interactions.length > 0 ? { interactions } : {}),
    ...(deps.pricingSource !== undefined ? { pricingSource: deps.pricingSource } : {}),
    ...(rates !== undefined ? { rates } : {}),
  };
}
