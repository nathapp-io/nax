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
 * The per-turn budget (Task 4) lives in `createInvalidCallBudget()` — three
 * identical invalid calls (same tool, same `stableStringify`'d input) end the
 * turn with `{kind: "stopped"}` and NO tool-result, matching the existing spin
 * breaker's stop branch ("a result nobody reads only grows the transcript").
 * The counter is per-key, cumulative across interleaved valid calls, and
 * lives in the factory's closure. The low-level `handleInvalidToolCall`
 * exposes the same per-call decision for direct callers (tests, future
 * extraction) and is what the factory uses internally.
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
import { byCodePoint } from "@/utils/sort";
import type { TranscriptMessage as NativeTranscriptMessage } from "./compaction";
import { exemplarFor } from "./tool-input-exemplar";
import { validateToolInput } from "./tool-input-validation";

/** Three identical invalid calls in a turn ends it (Task 4). */
export const INVALID_CALL_BUDGET_THRESHOLD = 3;

export type HandledInvalid =
  | { readonly kind: "rewritten"; readonly messages: NativeTranscriptMessage[] }
  | { readonly kind: "stopped" };

export function handleInvalidToolCall(
  call: ToolCall,
  tools: readonly ToolDefinition[],
  messages: readonly NativeTranscriptMessage[],
  counters: Map<string, number>,
): HandledInvalid | undefined {
  const tool = tools.find((t) => t.name === call.name);
  if (tool === undefined) return undefined;

  const violation = validateToolInput(tool.inputSchema, call.input);
  if (violation === undefined) return undefined;

  // Per-key counter: tool name + stableStringify(input). Mutated in place
  // so the next iteration sees the updated count without us having to
  // thread the new map back through.
  const counterKey = `${call.name}\u0000${stableStringify(call.input)}`;
  const nextCount = (counters.get(counterKey) ?? 0) + 1;
  counters.set(counterKey, nextCount);
  if (nextCount >= INVALID_CALL_BUDGET_THRESHOLD) return { kind: "stopped" };

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

  return { kind: "rewritten", messages: newMessages };
}

/**
 * Per-turn budget for repeated invalid tool calls (nax#2047, Task 4).
 *
 * The spin breaker's 50-call budget is for REPEATED *valid-shape* calls; a
 * malformed shape is a stronger signal — the model will keep sending the
 * same wrong shape for as long as it ignores the error result. This budget
 * hard-stops a turn after three identical invalid calls (same tool, same
 * `stableStringify`'d input) so the transcript never grows past the second
 * error result.
 *
 * Per-key, cumulative across interleaved valid calls: a valid call does
 * not reset the counter, and the same key returning later in the same turn
 * keeps accumulating. Different keys do not stop each other — three distinct
 * invalid calls (the model is exploring) are not a budget violation.
 *
 * On exceed, the factory's `observe()` returns `{kind: "stopped"}` and
 * `exceeded` flips to `true`. The caller checks `exceeded` after the tool
 * loop to set the `TurnResult.invalidCallBudgetExceeded` flag, mirroring
 * `spinStopped`'s reporting pattern.
 */
export interface InvalidCallBudget {
  /** Whether the budget was tripped on any call so far. Read after the loop. */
  readonly exceeded: boolean;
  observe(
    call: ToolCall,
    tools: readonly ToolDefinition[],
    messages: readonly NativeTranscriptMessage[],
  ): HandledInvalid | undefined;
}

export function createInvalidCallBudget(): InvalidCallBudget {
  const counters = new Map<string, number>();
  let exceeded = false;
  return {
    get exceeded(): boolean {
      return exceeded;
    },
    observe(call, tools, messages) {
      const result = handleInvalidToolCall(call, tools, messages, counters);
      if (result?.kind === "stopped") exceeded = true;
      return result;
    },
  };
}

/**
 * Deterministic serializer independent of property insertion order, so
 * `{a:1,b:2}` and `{b:2,a:1}` collide on the same counter key. Locally
 * scoped on purpose — `src/runtime/spin-breaker` has its own private copy
 * of the same algorithm, and exporting it from there would touch a file
 * Task 5 owns. The two implementations are deliberately small and
 * identical so a future extraction is a one-line move.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort((a, b) => byCodePoint(a[0], b[0]));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
}
