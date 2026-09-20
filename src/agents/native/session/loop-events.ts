/**
 * The native session's in-process loop event seam (nax#2151, US-002).
 *
 * Typed function registrations, not an extension of `src/hooks/`: those events
 * fire around a story, shell out with a 5s timeout, and cannot carry a
 * rewritten tool result. Two events exist because two have real consumers
 * today — invalid-call repair and the spin breaker on `before_tool`, and the
 * truncation policy on `after_tool`.
 *
 * The dispatcher enforces four rules rather than leaving them to handler
 * authors, because those rules are what let a future event be added without
 * redesigning the seam:
 *
 *  1. Results are partial patches, never mutations. A handler returns only what
 *     it wants changed and the dispatcher merges. No handler receives the
 *     message array.
 *  2. Handlers chain, each seeing the previous handler's output, in
 *     registration order.
 *  3. A throwing handler is logged at warn and skipped — it never fails the
 *     turn for its own defect.
 *  4. No handler may rewrite history. Measured prompt-cache hit rate on the
 *     native path is 96.7%, and Anthropic-style caching is prefix-matched, so
 *     rewriting anything early in the array re-bills every downstream turn at
 *     input rather than cacheRead — roughly 5x more expensive, not cheaper.
 *     `after_tool` is safe by construction: it shapes a result before the
 *     result enters the array.
 */

import type { ToolCall, ToolDefinition } from "@nathapp/nax-ai";
import { getSafeLogger } from "@/logger";
import { errorMessage } from "@/utils/errors";
import type { DenialInfo } from "./tool-result";

export type { BuildToolResultArgs, DenialInfo, ToolResultMessage } from "./tool-result";
export { buildToolResult } from "./tool-result";

/**
 * What an `after_tool` handler may change. Deliberately partial: a handler
 * returns only the fields it wants patched.
 *
 * `denied` is NOT patchable — a refused Write is not a crashed Write (ADR-029
 * s5), and letting a handler flip that erases a distinction the model is meant
 * to act on.
 */
export type AfterToolPatch = {
  content?: string;
  isError?: boolean;
};

export interface AfterToolPayload {
  readonly content: string;
  readonly isError?: boolean;
  /** Surfaced to handlers, never writable by them. */
  readonly denied?: DenialInfo;
}

/**
 * `before_tool` outcomes:
 *
 * - `allow` optionally rewrites the tool's input; later handlers see the
 *   rewrite, and the loop records it in the transcript and invokes the tool
 *   with it.
 * - `nudge` prefixes the eventual result with the handler's text.
 * - `block` answers without invoking the tool. `input` optionally carries the
 *   corrected input the transcript should record, which is how the
 *   invalid-call repair persists the exemplar it refuses to execute.
 * - `terminate` answers every outstanding call in the current batch — the spin
 *   breaker's stop is a batch-level outcome, not a per-call one, and a batch
 *   left with an unanswered `tool_call` is rejected by strict providers.
 */
export type BeforeToolOutcome =
  | { kind: "allow"; input?: Record<string, unknown> }
  | { kind: "nudge"; text: string }
  | { kind: "block"; content: string; isError?: boolean; input?: Record<string, unknown> }
  | { kind: "terminate"; content: string; isError?: boolean };

export type AfterToolHandler = (call: ToolCall, payload: AfterToolPayload) => AfterToolPatch;
export type BeforeToolHandler = (call: ToolCall, tools: readonly ToolDefinition[]) => BeforeToolOutcome;

export interface LoopEventRegistry {
  registerBeforeTool(handler: BeforeToolHandler): void;
  registerAfterTool(handler: AfterToolHandler): void;
  beforeTool(call: ToolCall, tools: readonly ToolDefinition[]): BeforeToolOutcome;
  afterTool(call: ToolCall, payload: AfterToolPayload): AfterToolPatch;
}

/**
 * Registration order is the chain order. `block` and `terminate` are a single
 * decision, not a chained one: they short-circuit, because the outcome is the
 * dispatcher's verdict and a later handler must not be able to veto it.
 */
export function createLoopEventRegistry(): LoopEventRegistry {
  const beforeHandlers: BeforeToolHandler[] = [];
  const afterHandlers: AfterToolHandler[] = [];

  return {
    registerBeforeTool(handler) {
      beforeHandlers.push(handler);
    },

    registerAfterTool(handler) {
      afterHandlers.push(handler);
    },

    beforeTool(call, tools) {
      let input: Record<string, unknown> | undefined;
      let nudgeText: string | undefined;
      for (const handler of beforeHandlers) {
        let outcome: BeforeToolOutcome;
        try {
          // Each handler sees the previous handler's output, so an `allow`
          // rewrite is what the next one judges — and what the loop runs.
          outcome = handler({ ...call, input: input ?? call.input }, tools);
        } catch (err) {
          getSafeLogger()?.warn("native-loop-events", "before_tool handler threw; skipping it", {
            tool: call.name,
            error: errorMessage(err),
          });
          continue;
        }
        if (outcome.kind === "block" || outcome.kind === "terminate") return outcome;
        if (outcome.kind === "nudge") nudgeText = outcome.text;
        else if (outcome.input !== undefined) input = outcome.input;
      }
      if (nudgeText !== undefined) return { kind: "nudge", text: nudgeText };
      return input === undefined ? { kind: "allow" } : { kind: "allow", input };
    },

    afterTool(call, payload) {
      let content = payload.content;
      let isError = payload.isError;
      for (const handler of afterHandlers) {
        let patch: AfterToolPatch;
        try {
          patch = handler(call, {
            ...payload,
            content,
            ...(isError === undefined ? {} : { isError }),
          });
        } catch (err) {
          getSafeLogger()?.warn("native-loop-events", "after_tool handler threw; skipping it", {
            tool: call.name,
            error: errorMessage(err),
          });
          continue;
        }
        // Only the patchable fields are read, so a handler that returns a
        // denied-bearing object (bypassing the type) cannot surface one.
        if (typeof patch.content === "string") content = patch.content;
        if (typeof patch.isError === "boolean") isError = patch.isError;
      }
      return { content, ...(isError === undefined ? {} : { isError }) };
    },
  };
}
