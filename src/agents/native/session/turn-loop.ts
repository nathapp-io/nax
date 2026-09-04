/**
 * The native turn loop.
 *
 * nax owns the conversation, so a turn is: append the prompt, call the model,
 * and while it asks for tools, execute them and call again. Tools are executed
 * through the InteractionHandler the ACP adapter already uses — this file never
 * touches the context engine.
 */

import type { ConversationMessage, ThinkingBlock, ToolCall } from "@nathapp/nax-ai";
import type { TokenUsage } from "@/agents/cost";
import type { InteractionExchange, SendTurnOpts, SessionHandle, TurnResult } from "@/agents/session-types";
import type { TurnDeadline } from "@/agents/turn-deadline";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { ASK_HUMAN_TOOL_NAME, askHumanToolDefinition } from "./ask-human";
import {
  applyCompaction,
  estimateContextTokens,
  keepBudget,
  type TranscriptMessage as NativeTranscriptMessage,
  prepareCompaction,
  type ResolvedCompaction,
  shouldCompact,
} from "./compaction";
import { nativeSessionLastUsage, nativeTranscriptDirs } from "./session";
import { codingToolsToDefinitions, toToolDefinitions } from "./tool-mapping";
import { loadTranscript, saveTranscript } from "./transcript-store";
import type { NativeTurnActivity } from "./turn-events";

export interface NativeTurnResponse {
  readonly text: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly thinking?: readonly ThinkingBlock[];
  readonly usage: TokenUsage;
  readonly costUsd: number;
}

/** What one summarization call returns. Usage and cost are surfaced, not swallowed. */
export interface NativeSummaryResponse {
  readonly text: string;
  readonly usage: TokenUsage;
  readonly costUsd: number;
}

export interface TurnDeps {
  complete(
    messages: readonly ConversationMessage[],
    tools: ReturnType<typeof toToolDefinitions>,
  ): Promise<NativeTurnResponse>;
  /**
   * One model call, no tools, used only to summarize a dropped span. Separate
   * from complete() because it must not advertise tools, must not count as a
   * round trip, and its cost must be attributable.
   */
  summarize?(messages: readonly NativeTranscriptMessage[], previousSummary?: string): Promise<NativeSummaryResponse>;
  /** ResolvedModel.contextWindow. Absent disables compaction. */
  contextWindow?: number;
  /** Resolved settings. Absent disables compaction. */
  compaction?: ResolvedCompaction;
  /**
   * Whole-turn wall-clock budget. Absent means unbounded — the adapter always
   * supplies one for a real session; tests may omit it.
   */
  deadline?: TurnDeadline;
  /**
   * Per-round-trip observability hook. Absent in unit tests; the adapter
   * supplies one that forwards onto the runtime stream bus so the idle
   * watchdog can see native sessions.
   */
  onActivity?: (activity: NativeTurnActivity) => void;
}

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

  let messages: NativeTranscriptMessage[] = [...(await loadTranscript(dir, handle.id))];
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

  const anchor = nativeSessionLastUsage.get(handle.id);
  let lastUsage = anchor?.inputTokens !== undefined ? { inputTokens: anchor.inputTokens } : undefined;
  let anchorIndex = anchor?.anchorIndex;

  // nax#1838: the save below the loop is the clean exit's alone. A turn that
  // throws must persist too — the retry reopens the same deterministic session
  // name, so an unsaved conversation is one the model silently resumes without.
  try {
    // Deliberately unbounded by count. A coding agent working a story is bounded
    // by wall clock (deps.deadline) and by the idle watchdog, never by how many
    // times it needed to call a tool. `agent.maxInteractionTurns` is NOT this
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
            costUsd += summary.costUsd;
            // Resets the watchdog's lastActivityAt between the summary and the
            // round trip, so the two silent spans do not add up against one budget.
            deps.onActivity?.({
              kind: "usage",
              inputTokens: summary.usage.inputTokens,
              outputTokens: summary.usage.outputTokens,
              costUsd: summary.costUsd,
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
          throw err;
        }

        // Same code path, half the keep budget. Not a second algorithm.
        const plan = prepareCompaction(messages, keepBudget(deps.contextWindow, deps.compaction, true));
        if (plan === undefined) throw err;
        const summary = await deps.summarize(plan.toSummarize, plan.previousSummary);
        messages = applyCompaction(messages, plan, summary.text);
        inputTokens += summary.usage.inputTokens;
        outputTokens += summary.usage.outputTokens;
        costUsd += summary.costUsd;
        deps.onActivity?.({
          kind: "usage",
          inputTokens: summary.usage.inputTokens,
          outputTokens: summary.usage.outputTokens,
          costUsd: summary.costUsd,
        });
        lastUsage = undefined;
        anchorIndex = undefined;
        // Retried once. A second overflow propagates: compacting further would be
        // guessing, and the failure now carries a correct diagnosis.
        res = await deps.complete(messages, tools);
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
      output = res.text;

      lastUsage = { inputTokens: res.usage.inputTokens };
      anchorIndex = messages.length - 1;
      nativeSessionLastUsage.set(handle.id, { inputTokens: res.usage.inputTokens, anchorIndex });

      deps.onActivity?.({
        kind: "usage",
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        costUsd: res.costUsd,
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

      for (const call of res.toolCalls) {
        deps.onActivity?.({ kind: "tool", toolName: call.name });
        try {
          if (call.name === ASK_HUMAN_TOOL_NAME) {
            const question = String((call.input as { text?: unknown } | undefined)?.text ?? "");
            // An unset budget (maxInteractions undefined -> 0) keeps the tool unadvertised
            // above AND refuses a call made anyway. "No budget configured" must not
            // read as "unlimited" — that inverts the property this budget provides.
            if (interactions.length >= maxInteractions) {
              messages.push({
                role: "tool-result",
                toolCallId: call.id,
                content: "The human Q&A budget for this turn is spent. Proceed on your best judgement.",
                isError: true,
              });
              continue;
            }
            const answer = await opts.interactionHandler.onInteraction({ kind: "question", text: question });
            // A null answer means no operator is reachable — run-interaction-handler
            // returns null for kind:"question" when no interactionBridge is
            // configured. That is not an exchange: it must not consume budget and
            // must not be recorded as a question the operator answered with "".
            if (answer === null) {
              messages.push({
                role: "tool-result",
                toolCallId: call.id,
                content: "No human operator is available for this run. Proceed on your best judgement.",
                isError: true,
              });
              continue;
            }
            interactions.push({ turnIndex: roundTrips, question, reply: answer.answer });
            messages.push({ role: "tool-result", toolCallId: call.id, content: answer.answer });
            continue;
          }
          const kind = codingToolNames.has(call.name) ? "coding-tool" : "context-tool";
          if (kind === "coding-tool") codingToolsCalled.push(call.name);
          const answer = await opts.interactionHandler.onInteraction(
            kind === "coding-tool"
              ? { kind, name: call.name, input: (call.input ?? {}) as Record<string, unknown> }
              : { kind, name: call.name, input: call.input },
          );

          // A denial is data the model can act on, and deliberately NOT isError:
          // a refused Write is not a crashed Write (ADR-029 s5).
          if (answer?.denied !== undefined) {
            messages.push({
              role: "tool-result",
              toolCallId: call.id,
              content: answer.answer,
              denied: answer.denied,
            });
            continue;
          }
          messages.push({ role: "tool-result", toolCallId: call.id, content: answer?.answer ?? "" });
        } catch (err) {
          // A tool failure is data, not a turn failure: the existing pull-tool
          // contract already surfaces a handler throw as status "error".
          messages.push({
            role: "tool-result",
            toolCallId: call.id,
            content: err instanceof Error ? err.message : String(err),
            isError: true,
          });
        }
      }
    }
  } catch (err) {
    // Best-effort, and deliberately unlike the clean-exit save: there a write
    // failure fails the turn, because continuing on unstored history is silent
    // degradation. Here a failure is already in flight, and masking it with a
    // write error would lose the cause.
    await saveTranscript(dir, handle.id, messages).catch((saveErr: unknown) => {
      getSafeLogger()?.warn("native-adapter", "could not persist the transcript of a failed turn", {
        sessionName: handle.id,
        error: saveErr instanceof Error ? saveErr.message : String(saveErr),
      });
    });
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

  // Persisted before returning, and a write failure fails the turn: continuing
  // on a history that could not be stored is the silent degradation #1794
  // removed from the pipeline (ADR-028 s4).
  await saveTranscript(dir, handle.id, messages);

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
    ...(interactions.length > 0 ? { interactions } : {}),
  };
}
