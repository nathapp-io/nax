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
import { nativeTranscriptDirs } from "./session";
import { codingToolsToDefinitions, toToolDefinitions } from "./tool-mapping";
import { loadTranscript, saveTranscript } from "./transcript-store";
import type { NativeTurnActivity } from "./turn-events";

/**
 * The transcript message nax stores: nax-ai's ConversationMessage widened with
 * the coding-tool denial marker (ADR-029 s5). The marker is structural data the
 * model must be able to act on — dropping it because the wire type does not
 * know it yet is exactly the defect this widening exists to prevent.
 */
type NativeTranscriptMessage =
  | ConversationMessage
  | {
      readonly role: "tool-result";
      readonly toolCallId: string;
      readonly content: string;
      readonly isError?: boolean;
      readonly denied?: import("@/agents").AdapterInteractionResponse["denied"];
    };

export interface NativeTurnResponse {
  readonly text: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly thinking?: readonly ThinkingBlock[];
  readonly usage: TokenUsage;
  readonly costUsd: number;
}

export interface TurnDeps {
  complete(
    messages: readonly ConversationMessage[],
    tools: ReturnType<typeof toToolDefinitions>,
  ): Promise<NativeTurnResponse>;
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

  const messages: NativeTranscriptMessage[] = [...(await loadTranscript(dir, handle.id))];
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
      const res = await deps.complete(messages, tools);
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
