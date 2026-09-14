/**
 * Detect an invalid tool-call input at the transport boundary (nax#2047).
 *
 * The model returned RunCommand calls with `values:""` 69 times in a row —
 * the empty string produced no rejected keys, the loop never named "values"
 * as the wrong type, so the spin breaker never saw the repetition as
 * repetition. This module is the gate the loop was missing: validate the
 * call against the tool's JSON Schema before any handler runs. On
 * violation, rewrite the last assistant message's `toolCalls` entry to a
 * schema-conforming exemplar and append a tool-result that names the
 * property and the corrected input, so the next round trip sees what the
 * tool would have accepted.
 *
 * Returns `undefined` when the call is valid, or when the tool is not in
 * the local catalogue (no schema → no validation, success path). The
 * success path costs one function call and no allocation.
 *
 * Invariants:
 * - Never mutates `messages` or the last assistant message. The returned
 *   array is a fresh value, the returned assistant is a new object, the
 *   new `toolCalls` array is a new array.
 * - Thinking blocks survive byte-for-byte (ADR-028 §8 — Anthropic needs the
 *   exact thinking block back to continue a thinking conversation).
 * - Composes onto the LAST assistant message, not the last array entry —
 *   after iteration N of a multi-call assistant message, iteration N+1 sees
 *   a tool-result for iteration N at the tail. Locating the last assistant
 *   is what makes "two invalid calls in one assistant message" rewrite
 *   both, with the second composing onto the first.
 */

import type { ToolCall, ToolDefinition } from "@nathapp/nax-ai";
import type { TranscriptMessage as NativeTranscriptMessage } from "./compaction";
import { exemplarFor } from "./tool-input-exemplar";
import { validateToolInput } from "./tool-input-validation";

export interface HandledInvalid {
  readonly messages: NativeTranscriptMessage[];
}

export function handleInvalidToolCall(
  call: ToolCall,
  tools: readonly ToolDefinition[],
  messages: readonly NativeTranscriptMessage[],
): HandledInvalid | undefined {
  const tool = tools.find((t) => t.name === call.name);
  if (tool === undefined) return undefined;

  const violation = validateToolInput(tool.inputSchema, call.input);
  if (violation === undefined) return undefined;

  const exemplar = exemplarFor(tool.inputSchema, call.input as Record<string, unknown>, violation);

  // Locate the LAST assistant message — not the last array entry. After
  // iteration N of a multi-call assistant message, the loop has already
  // appended a tool-result for iteration N, so the tail is a tool-result,
  // not the assistant. Iteration N+1 must still compose onto the assistant
  // we already rewrote at iteration N.
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }
  if (lastAssistantIndex < 0) return undefined;

  const lastAssistant = messages[lastAssistantIndex];
  if (lastAssistant === undefined || lastAssistant.role !== "assistant") return undefined;

  const originalToolCalls = lastAssistant.toolCalls ?? [];
  const newToolCalls = originalToolCalls.map((tc) => (tc.id === call.id ? { ...tc, input: exemplar } : tc));

  const newAssistant: NativeTranscriptMessage = {
    role: "assistant",
    content: lastAssistant.content,
    toolCalls: newToolCalls,
    ...(lastAssistant.thinking !== undefined ? { thinking: lastAssistant.thinking } : {}),
  };

  const errorText =
    `invalid tool call: property "${violation.property}" expected ${violation.expected}, ` +
    `got ${violation.actual}. ` +
    `Corrected input written to the transcript as ${JSON.stringify(exemplar)}.`;

  const errorResult: NativeTranscriptMessage = {
    role: "tool-result",
    toolCallId: call.id,
    content: errorText,
    isError: true,
  };

  const newMessages: NativeTranscriptMessage[] = [
    ...messages.slice(0, lastAssistantIndex),
    newAssistant,
    ...messages.slice(lastAssistantIndex + 1),
    errorResult,
  ];

  return { messages: newMessages };
}
