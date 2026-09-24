/**
 * US-002 — turn-signal cancellation inside `runToolBatch`.
 *
 * AC7 / AC8 pin the batch's contract for the new `TurnDeps.signal`: at the
 * top of every batch iteration (before activity, before any dispatch) an
 * already-aborted signal stops the batch — no interaction is invoked, every
 * call this-and-later gets the synthetic "Not run: the turn was cancelled."
 * result, and the batch reports `cancelled: true` so the loop throws the
 * abort reason instead of issuing another round trip. Synthetic answers are
 * written without firing `after_tool`, mirroring the other synthetic exits
 * (spin stop, invalid-call halt).
 *
 * AC1–AC6 and AC9 (the loop-level wording of the same contract, plus the
 * no-signal regression guard) live in `turn-loop-cancel.test.ts`, which goes
 * through `runNativeTurn` so the transcript persistence is under test.
 */

import { describe, expect, test } from "bun:test";
import { ASK_HUMAN_TOOL_NAME } from "@/agents/native/session/ask-human";
import type { TranscriptMessage as NativeTranscriptMessage } from "@/agents/native/session/compaction";
import { createInvalidCallBudget } from "@/agents/native/session/handle-invalid-tool-call";
import { createLoopEventRegistry } from "@/agents/native/session/loop-events";
import { codingToolsToDefinitions } from "@/agents/native/session/tool-mapping";
import { runToolBatch, type ToolBatchArgs } from "@/agents/native/session/turn-tool-batch";
import type { TurnDeps } from "@/agents/native/session/turn-types";
import type { SendTurnOpts } from "@/agents/session-types";
import type { CodingTool } from "@/tools";

const CANCELLED_CONTENT = "Not run: the turn was cancelled.";

const fakeRead: CodingTool = {
  name: "Read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "raw-body" };
  },
};

const call = (id: string, path: string) => ({ id, name: fakeRead.name, input: { path } });

/** A minimal transcript: a user prompt followed by one assistant tool-call message. */
function messagesWith(toolCalls: readonly { id: string; name: string; input: object }[]): NativeTranscriptMessage[] {
  return [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [...toolCalls] },
  ];
}

function batchArgs(over: Partial<ToolBatchArgs> & { deps: TurnDeps; opts: SendTurnOpts }): ToolBatchArgs {
  return {
    messages: messagesWith([call("c1", "a.ts"), call("c2", "b.ts")]),
    toolCalls: [call("c1", "a.ts"), call("c2", "b.ts")],
    tools: codingToolsToDefinitions([fakeRead]),
    codingToolNames: new Set([fakeRead.name, ASK_HUMAN_TOOL_NAME]),
    roundTrips: 0,
    loopEvents: createLoopEventRegistry(),
    invalidCallBudget: createInvalidCallBudget(),
    spinBreaker: undefined,
    maxInteractions: 0,
    spinWarned: false,
    interactionsSoFar: 0,
    ...over,
  };
}

function cancelledOnlyResult(results: readonly NativeTranscriptMessage[]): Array<{
  toolCallId: string;
  content: unknown;
  isError?: boolean;
}> {
  return results
    .filter((m) => m.role === "tool-result")
    .map((m) => ({
      toolCallId: m.toolCallId,
      content: m.content,
      ...(m.isError === undefined ? {} : { isError: m.isError }),
    }));
}

describe("runToolBatch — turn signal cancellation (US-002)", () => {
  test("AC7: an already-aborted batch signal invokes no interactions and synthetically answers every call", async () => {
    const controller = new AbortController();
    controller.abort();
    let interactions = 0;
    const opts: SendTurnOpts = {
      interactionHandler: {
        onInteraction: async () => {
          interactions += 1;
          return { answer: "ok" };
        },
      },
    };
    const deps: TurnDeps = {
      signal: controller.signal,
      complete: async () => {
        throw new Error("complete must not be reached from a cancelled batch");
      },
    };

    const result = await runToolBatch(batchArgs({ deps, opts }));

    // No interaction ran at all.
    expect(interactions).toBe(0);
    expect(result.cancelled).toBe(true);

    // Every call in the batch was answered with the exact cancelled notice.
    const results = cancelledOnlyResult(result.messages);
    expect(new Set(results.map((r) => r.toolCallId))).toEqual(new Set(["c1", "c2"]));
    expect(results.map((r) => r.content)).toEqual([CANCELLED_CONTENT, CANCELLED_CONTENT]);
    expect(results.every((r) => r.isError === true)).toBe(true);
  });

  test("AC7: a batch signal aborted at start answers this-and-later calls from the first iteration", async () => {
    // One call only — the check must fire at the TOP of the first iteration,
    // so the single call is itself answered synthetically and never dispatched.
    const controller = new AbortController();
    controller.abort("cancel now");
    let interactions = 0;
    const opts: SendTurnOpts = {
      interactionHandler: {
        onInteraction: async () => {
          interactions += 1;
          return { answer: "ok" };
        },
      },
    };
    const deps: TurnDeps = {
      signal: controller.signal,
      complete: async () => ({ text: "", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 }),
    };

    const result = await runToolBatch(
      batchArgs({
        deps,
        opts,
        messages: messagesWith([call("c1", "a.ts")]),
        toolCalls: [call("c1", "a.ts")],
      }),
    );

    expect(interactions).toBe(0);
    expect(result.cancelled).toBe(true);
    expect(cancelledOnlyResult(result.messages)).toEqual([
      { toolCallId: "c1", content: CANCELLED_CONTENT, isError: true },
    ]);
  });

  test("AC7: without a signal the batch executes every call and reports cancelled false, as before this feature", async () => {
    let interactions = 0;
    const opts: SendTurnOpts = {
      interactionHandler: {
        onInteraction: async () => {
          interactions += 1;
          return { answer: "ok" };
        },
      },
    };
    const deps: TurnDeps = {
      complete: async () => ({ text: "", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 }),
    };

    const result = await runToolBatch(batchArgs({ deps, opts }));

    expect(interactions).toBe(2);
    expect(result.cancelled).toBe(false);
    expect(cancelledOnlyResult(result.messages).map((r) => r.content)).toEqual(["ok", "ok"]);
  });

  test("AC8: a synthetic cancelled answer fires no registered after_tool handler", async () => {
    const controller = new AbortController();
    controller.abort();
    const registry = createLoopEventRegistry();
    let afterTool = 0;
    registry.register("after_tool", () => {
      afterTool += 1;
      return {};
    });
    const opts: SendTurnOpts = {
      interactionHandler: {
        onInteraction: async () => {
          afterTool += 1_000; // interaction calls are also forbidden here
          return { answer: "ok" };
        },
      },
    };
    const deps: TurnDeps = {
      signal: controller.signal,
      complete: async () => ({ text: "", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 }),
    };

    const result = await runToolBatch(batchArgs({ deps, opts, loopEvents: registry }));

    expect(result.cancelled).toBe(true);
    // The synthetic path pushes results directly, mirroring the spin-stop
    // notice: no tool ran, so no after_tool event describes it.
    expect(afterTool).toBe(0);
  });
});
