/**
 * A stored transcript as session updates for `session/load` (S5 spec §5.4).
 * Inputs and results go through nax-agent's live masking and caps (M-7), so a
 * replay never shows more than the live turn did. Write gets no diff: the file's
 * old content at that time is gone.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { displayToolInput, type TranscriptDoc, toolResultPreview } from "@nathapp/nax-agent";
import { editDiff } from "#src/server/translate/diff";
import { textContent } from "#src/server/translate/events";
import { toolKind, toolLocations, toolTitle } from "#src/server/translate/tool-kind";

export type TranscriptMessage = TranscriptDoc["messages"][number];

export const NO_RESULT_TEXT = "No result was recorded for this call.";

interface StoredResult {
  readonly content: string;
  readonly isError: boolean;
}

type AssistantMessage = Extract<TranscriptMessage, { role: "assistant" }>;
type StoredCall = NonNullable<AssistantMessage["toolCalls"]>[number];

function replayCall(
  call: StoredCall,
  result: StoredResult | undefined,
  cwd: string,
  titleFor?: (name: string) => string | undefined,
): SessionUpdate {
  const input = displayToolInput(call.input);
  const diff = call.name === "Edit" ? editDiff(input, cwd) : undefined;
  const locations = toolLocations(call.name, input, cwd);
  const shown = result === undefined ? NO_RESULT_TEXT : toolResultPreview(result.content);
  return {
    sessionUpdate: "tool_call",
    toolCallId: call.id,
    title: titleFor?.(call.name) ?? toolTitle(call.name, input),
    kind: toolKind(call.name),
    status: result === undefined || result.isError ? "failed" : "completed",
    rawInput: input,
    ...(locations !== undefined ? { locations } : {}),
    content: [textContent(shown), ...(diff !== undefined ? [diff] : [])],
  };
}

function replayMessage(
  message: TranscriptMessage,
  results: ReadonlyMap<string, StoredResult>,
  cwd: string,
  titleFor?: (name: string) => string | undefined,
): SessionUpdate[] {
  switch (message.role) {
    case "user":
      return message.content === ""
        ? []
        : [{ sessionUpdate: "user_message_chunk", content: { type: "text", text: message.content } }];
    case "tool-result":
      return [];
    case "assistant": {
      const thoughts = (message.thinking ?? [])
        .filter((block) => block.text !== "")
        .map(
          (block): SessionUpdate => ({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: block.text },
          }),
        );
      const said: SessionUpdate[] =
        message.content === ""
          ? []
          : [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: message.content } }];
      const calls = (message.toolCalls ?? []).map((call) => replayCall(call, results.get(call.id), cwd, titleFor));
      return [...thoughts, ...said, ...calls];
    }
  }
}

export function replayTranscript(
  messages: readonly TranscriptMessage[],
  cwd: string,
  titleFor?: (name: string) => string | undefined,
): readonly SessionUpdate[] {
  const results = new Map<string, StoredResult>();
  for (const message of messages) {
    if (message.role === "tool-result") {
      results.set(message.toolCallId, { content: message.content, isError: message.isError === true });
    }
  }
  return messages.flatMap((message) => replayMessage(message, results, cwd, titleFor));
}
