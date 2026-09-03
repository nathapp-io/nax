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
import type { SendTurnOpts, SessionHandle, TurnResult } from "@/agents/session-types";
import { NaxError } from "@/errors";
import { nativeTranscriptDirs } from "./session";
import { codingToolsToDefinitions, toToolDefinitions } from "./tool-mapping";
import { loadTranscript, saveTranscript } from "./transcript-store";

/** Matches SendTurnOpts.maxTurns' documented default. */
const DEFAULT_MAX_TURNS = 10;

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
  const tools = [...toToolDefinitions(opts.contextPullTools ?? []), ...codingToolsToDefinitions(codingTools)];
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;

  let roundTrips = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let output = "";
  // Reported on the result so the review guards can corroborate a reviewer's
  // self-declared inspection trail against calls it actually made.
  const codingToolsCalled: string[] = [];

  while (roundTrips < maxTurns) {
    const res = await deps.complete(messages, tools);
    roundTrips += 1;
    inputTokens += res.usage.inputTokens;
    outputTokens += res.usage.outputTokens;
    costUsd += res.costUsd;
    output = res.text;

    // Thinking blocks are appended, not merely representable: Anthropic needs
    // the exact block back to continue a thinking conversation (ADR-028 s8).
    messages.push({
      role: "assistant",
      content: res.text,
      ...(res.toolCalls !== undefined ? { toolCalls: res.toolCalls } : {}),
      ...(res.thinking !== undefined ? { thinking: res.thinking } : {}),
    });

    if (res.toolCalls === undefined || res.toolCalls.length === 0) break;

    for (const call of res.toolCalls) {
      try {
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

  // Persisted before returning, and a write failure fails the turn: continuing
  // on a history that could not be stored is the silent degradation #1794
  // removed from the pipeline (ADR-028 s4).
  await saveTranscript(dir, handle.id, messages);

  return {
    output,
    tokenUsage: { inputTokens, outputTokens },
    estimatedCostUsd: costUsd,
    internalRoundTrips: roundTrips,
    ...(codingTools.length > 0 ? { codingToolUse: { advertised: codingTools.length, called: codingToolsCalled } } : {}),
  };
}
