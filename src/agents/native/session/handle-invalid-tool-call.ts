/**
 * Detect an invalid tool-call input at the transport boundary (nax#2047).
 *
 * The model returned RunCommand calls with `values:""` 69 times in a row —
 * the empty string produced no rejected keys, the loop never named "values"
 * as the wrong type, so the spin breaker never saw the repetition as
 * repetition. This module is the gate the loop was missing: validate the
 * call against the tool's JSON Schema before any handler runs. On violation,
 * name the property and offer a schema-conforming exemplar so the next round
 * trip sees what the tool would have accepted.
 *
 * Where the exemplar goes (nax#2200): #2047 wrote it over the model's call in
 * the assistant message, so the malformed value would not persist as a
 * few-shot example. That kept the purpose but attributed a call the model never
 * made — `refs: ["<FILL IN: refs>"]` — to the assistant. The recorded call is
 * now the model's own input with ONLY the rejected property removed: the
 * malformed value still never persists, nothing fabricated is attributed to
 * the model, and the exemplar lives in the tool-result's error text, where it
 * is plainly guidance from the harness.
 *
 * Since nax#2151 this decision is produced by a built-in `before_tool`
 * handler (`loop-handlers.ts`) instead of an inline branch of the loop: the
 * repair is a tool-call decision — answer without invoking — which is exactly
 * what the seam's `block` outcome is for. What stays here is the decision and
 * its per-turn budget; the transcript rewrite is the loop's, because that is
 * where the message array lives.
 *
 * Returns `undefined` when the call is valid, or when the tool is not in the
 * local catalogue (no schema → no validation, success path). The success path
 * costs one function call and no allocation.
 *
 * The per-turn budget (Task 4) lives in `createInvalidCallBudget()` — three
 * identical invalid calls (same tool, same `stableStringify`'d input) end the
 * turn with `{kind: "stopped"}` and NO tool-result, matching the spin
 * breaker's stop branch ("a result nobody reads only grows the transcript").
 * The counter is per-key, cumulative across interleaved valid calls, and lives
 * in the factory's closure.
 */

import type { ToolCall, ToolDefinition } from "@nathapp/nax-ai";
import type { InvalidToolCallDetail } from "@/agents/session-types";
import { byCodePoint } from "@/utils/sort";
import type { TranscriptMessage as NativeTranscriptMessage } from "./compaction";
import { exemplarFor } from "./tool-input-exemplar";
import { stripNullOptionals, type ToolInputViolation, validateToolInput } from "./tool-input-validation";

/** Three identical invalid calls in a turn ends it (Task 4). */
export const INVALID_CALL_BUDGET_THRESHOLD = 3;

export type InvalidCallOutcome =
  /**
   * Answer the call with `content` instead of running it. `input` is what the
   * transcript records for the call: the model's own input minus the rejected
   * property (nax#2200), never a fabricated exemplar.
   */
  | { readonly kind: "repair"; readonly input: Record<string, unknown>; readonly content: string }
  /** The per-key budget is spent: end the turn with no answer at all. */
  | { readonly kind: "stopped"; readonly detail: InvalidToolCallDetail };

export function decideInvalidToolCall(
  call: ToolCall,
  tools: readonly ToolDefinition[],
  counters: Map<string, number>,
): InvalidCallOutcome | undefined {
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
  if (nextCount >= INVALID_CALL_BUDGET_THRESHOLD) {
    const { property, expected, actual } = violation;
    return { kind: "stopped", detail: { tool: call.name, property, expected, actual } };
  }

  const original = call.input as Record<string, unknown>;
  const exemplar = exemplarFor(tool.inputSchema, original, violation);
  const recorded = withoutProperty(original, violation.property);
  return { kind: "repair", input: recorded, content: invalidCallMessage(violation, exemplar, recorded !== original) };
}

/**
 * The call's input with its `null`-valued optional properties removed, or
 * `undefined` when the tool is not in the catalogue or nothing was removed
 * (nax#2200). The validator already reads such a `null` as absent; this is
 * what makes the tool's handler see the same thing.
 */
export function normalizeNullOptionals(
  call: ToolCall,
  tools: readonly ToolDefinition[],
): Record<string, unknown> | undefined {
  const tool = tools.find((t) => t.name === call.name);
  if (tool === undefined) return undefined;
  return stripNullOptionals(tool.inputSchema, call.input);
}

/** `input` without `property`; the same object when the property is not there. */
function withoutProperty(input: Record<string, unknown>, property: string): Record<string, unknown> {
  if (property === "" || !(property in input)) return input;
  const { [property]: _rejected, ...rest } = input;
  return rest;
}

/**
 * Replace one `toolCalls` entry's input on the LAST assistant message.
 *
 * Composes onto the last assistant message rather than the last array entry:
 * after iteration N of a multi-call assistant message, iteration N+1 sees a
 * tool-result for iteration N at the tail, and a naive implementation would
 * rewrite only the last of two invalid calls.
 *
 * Never mutates: the returned array and the rewritten message are fresh values,
 * and thinking blocks survive byte-for-byte (ADR-028 §8 — Anthropic needs the
 * exact thinking block back to continue a thinking conversation).
 */
export function rewriteToolCallInput(
  messages: readonly NativeTranscriptMessage[],
  callId: string,
  input: Record<string, unknown>,
): NativeTranscriptMessage[] {
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }
  const lastAssistant = messages[lastAssistantIndex];
  if (lastAssistant === undefined || lastAssistant.role !== "assistant") return [...messages];

  const toolCalls = (lastAssistant.toolCalls ?? []).map((tc) => (tc.id === callId ? { ...tc, input } : tc));
  return [
    ...messages.slice(0, lastAssistantIndex),
    {
      role: "assistant",
      content: lastAssistant.content,
      toolCalls,
      ...(lastAssistant.thinking !== undefined ? { thinking: lastAssistant.thinking } : {}),
    },
    ...messages.slice(lastAssistantIndex + 1),
  ];
}

function invalidCallMessage(
  violation: ToolInputViolation,
  exemplar: Record<string, unknown>,
  removedFromRecord: boolean,
): string {
  return (
    `invalid tool call: property "${violation.property}" expected ${violation.expected}, ` +
    `got ${violation.actual}. The call was not executed. ` +
    (removedFromRecord ? `The rejected "${violation.property}" value was removed from the recorded call. ` : "") +
    `An input of the expected shape looks like ${JSON.stringify(exemplar)} — ` +
    "replace any <FILL IN> placeholder with a real value, and omit an optional property you have no value for."
  );
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
 * On exceed, `observe()` returns `{kind: "stopped"}` and `exceeded` flips to
 * `true`. The caller checks `exceeded` after the dispatch to break the batch
 * with no tool-result and to set `TurnResult.invalidCallBudgetExceeded`,
 * mirroring `spinStopped`'s reporting pattern.
 */
export interface InvalidCallBudget {
  /** Whether the budget was tripped on any call so far. Read after the dispatch. */
  readonly exceeded: boolean;
  /**
   * The call that tripped the budget — set together with `exceeded`, so the
   * halt can be logged and classified by what was rejected (nax#2200).
   */
  readonly halt: InvalidToolCallDetail | undefined;
  observe(call: ToolCall, tools: readonly ToolDefinition[]): InvalidCallOutcome | undefined;
}

export function createInvalidCallBudget(): InvalidCallBudget {
  const counters = new Map<string, number>();
  let halt: InvalidToolCallDetail | undefined;
  return {
    get exceeded(): boolean {
      return halt !== undefined;
    },
    get halt(): InvalidToolCallDetail | undefined {
      return halt;
    },
    observe(call, tools) {
      const outcome = decideInvalidToolCall(call, tools, counters);
      if (outcome?.kind === "stopped" && halt === undefined) halt = outcome.detail;
      return outcome;
    },
  };
}

/**
 * Deterministic serializer independent of property insertion order, so
 * `{a:1,b:2}` and `{b:2,a:1}` collide on the same counter key. Locally
 * scoped on purpose — `src/runtime/spin-breaker` has its own private copy
 * of the same algorithm. The two implementations are deliberately small and
 * identical so a future extraction is a one-line move.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort((a, b) => byCodePoint(a[0], b[0]));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
}
