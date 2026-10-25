import type { SessionEvent } from "@nathapp/nax-agent";
import { Box, Text } from "ink";
import type { ReactElement } from "react";

export type TranscriptEntry =
  | { kind: "message"; text: string }
  | { kind: "text"; text: string; turnId: string }
  | { kind: "thinking"; turnId: string }
  | { kind: "tool"; turnId: string; callId: string; text: string; status?: "ok" | "error" };

const TOOL_DETAIL_LIMIT = 60;
function toolLabel(event: Extract<SessionEvent, { type: "tool_call" }>): string {
  const input = event.input;
  if (typeof input !== "object" || input === null) return event.name;
  const field =
    event.name === "Bash" ? "command" : ["Read", "Write", "Edit", "Delete"].includes(event.name) ? "path" : undefined;
  const detail = field && field in input ? Reflect.get(input, field) : undefined;
  return typeof detail === "string"
    ? `${event.name} ${detail.replace(/[\r\n]/g, " ").slice(0, TOOL_DETAIL_LIMIT)}`
    : event.name;
}

/** Streaming presentation only: tool results update their existing call, never add a row. */
export function appendChatEvent(entries: TranscriptEntry[], event: SessionEvent): TranscriptEntry[] {
  switch (event.type) {
    case "text_delta": {
      const last = entries.at(-1);
      if (last?.kind === "text" && last.turnId === event.turnId) {
        return [...entries.slice(0, -1), { ...last, text: last.text + event.text }];
      }
      return [...entries, { kind: "text", turnId: event.turnId, text: event.text }];
    }
    case "thinking_delta":
      return entries.some((entry) => entry.kind === "thinking" && entry.turnId === event.turnId)
        ? entries
        : [...entries, { kind: "thinking", turnId: event.turnId }];
    case "tool_call":
      return [...entries, { kind: "tool", turnId: event.turnId, callId: event.callId, text: toolLabel(event) }];
    case "tool_result":
      return entries.map((entry) =>
        entry.kind === "tool" && entry.turnId === event.turnId && entry.callId === event.callId
          ? { ...entry, status: event.isError ? "error" : "ok" }
          : entry,
      );
    case "turn_end":
      return event.status === "errored" && event.error
        ? [...entries, { kind: "message", text: `${event.error.code}: ${event.error.message}` }]
        : entries;
    default:
      return entries;
  }
}

export function Transcript({ entries }: { entries: readonly TranscriptEntry[] }): ReactElement {
  return (
    <Box flexDirection="column">
      {entries.map((entry, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are append-only; results update calls in place.
        <Text key={index}>
          {entry.kind === "thinking"
            ? "thinking..."
            : entry.kind === "tool" && entry.status
              ? `${entry.text} [${entry.status}]`
              : entry.text}
        </Text>
      ))}
    </Box>
  );
}
