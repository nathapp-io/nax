/**
 * S3-3 (spec 5.4): tool_call / tool_result from the batch. A tool_call goes out
 * once a call will be answered by a tool or by a before_tool block, with the
 * input the transcript records; each is answered by exactly one tool_result.
 * ask_human and the synthetic answers (terminate, cancel) emit nothing.
 */
import { describe, expect, test } from "bun:test";
import { ASK_HUMAN_TOOL_NAME } from "#src/native/session/ask-human";
import type { TranscriptMessage } from "#src/native/session/compaction";
import { createInvalidCallBudget } from "#src/native/session/handle-invalid-tool-call";
import { createLoopEventRegistry } from "#src/native/session/loop-events/index";
import { createNativeSessionState } from "#src/native/session/session";
import { codingToolsToDefinitions } from "#src/native/session/tool-mapping";
import { createTurnEventEmitter } from "#src/native/session/turn-event-emitter";
import { runToolBatch, type ToolBatchArgs } from "#src/native/session/turn-tool-batch";
import type { TurnDeps } from "#src/native/session/turn-types";
import type { SendTurnOpts } from "#src/session/session-types";
import type { TurnEvent } from "#src/session/turn-event";
import type { CodingTool } from "#src/tools/index";

const sessionState = createNativeSessionState();
const deps: TurnDeps = {
  sessionState,
  complete: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 }),
};

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

function args(events: TurnEvent[], over: Partial<ToolBatchArgs> & { opts: SendTurnOpts }): ToolBatchArgs {
  const toolCalls = over.toolCalls ?? [call("c1", "a.ts"), call("c2", "b.ts")];
  const messages: TranscriptMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [...toolCalls] },
  ];
  return {
    messages,
    toolCalls,
    tools: codingToolsToDefinitions([fakeRead]),
    codingToolNames: new Set([fakeRead.name]),
    roundTrips: 1,
    deps,
    loopEvents: createLoopEventRegistry(),
    invalidCallBudget: createInvalidCallBudget(),
    spinBreaker: undefined,
    maxInteractions: 0,
    spinWarned: false,
    interactionsSoFar: 0,
    turnEvents: createTurnEventEmitter((e) => void events.push(e)),
    ...over,
  };
}

const answering = (answer: string): SendTurnOpts => ({
  interactionHandler: { onInteraction: async () => ({ answer }) },
});

describe("runToolBatch tool events (S3-3)", () => {
  test("each executed call: tool_call before it runs, then its tool_result", async () => {
    const events: TurnEvent[] = [];
    const order: string[] = [];
    const opts: SendTurnOpts = {
      interactionHandler: {
        onInteraction: async (req) => {
          order.push(`run:${events.length}`);
          const input = req.kind === "coding-tool" ? req.input : undefined;
          return { answer: `body of ${String(input?.path)}` };
        },
      },
    };
    await runToolBatch(args(events, { opts }));
    expect(order).toEqual(["run:1", "run:3"]);
    expect(events).toEqual([
      { type: "tool_call", callId: "c1", name: "Read", input: { path: "a.ts" } },
      { type: "tool_result", callId: "c1", isError: false, preview: "body of a.ts" },
      { type: "tool_call", callId: "c2", name: "Read", input: { path: "b.ts" } },
      { type: "tool_result", callId: "c2", isError: false, preview: "body of b.ts" },
    ]);
  });

  test("the reported input is the before_tool rewrite the transcript records", async () => {
    const events: TurnEvent[] = [];
    const loopEvents = createLoopEventRegistry();
    loopEvents.register("before_tool", async () => ({ kind: "allow", input: { path: "fixed.ts" } }));
    await runToolBatch(args(events, { opts: answering("ok"), toolCalls: [call("c1", "a.ts")], loopEvents }));
    expect(events[0]).toEqual({ type: "tool_call", callId: "c1", name: "Read", input: { path: "fixed.ts" } });
  });

  test("a before_tool block is a call answered on the tool's behalf", async () => {
    const events: TurnEvent[] = [];
    const loopEvents = createLoopEventRegistry();
    loopEvents.register("before_tool", async () => ({ kind: "block", content: "blocked: bad input", isError: true }));
    await runToolBatch(args(events, { opts: answering("never"), toolCalls: [call("c1", "a.ts")], loopEvents }));
    expect(events).toEqual([
      { type: "tool_call", callId: "c1", name: "Read", input: { path: "a.ts" } },
      { type: "tool_result", callId: "c1", isError: true, preview: "blocked: bad input" },
    ]);
  });

  test("a tool that throws is reported as an error result", async () => {
    const events: TurnEvent[] = [];
    const opts: SendTurnOpts = {
      interactionHandler: {
        onInteraction: async () => {
          throw new Error("disk on fire");
        },
      },
    };
    await runToolBatch(args(events, { opts, toolCalls: [call("c1", "a.ts")] }));
    expect(events).toEqual([
      { type: "tool_call", callId: "c1", name: "Read", input: { path: "a.ts" } },
      { type: "tool_result", callId: "c1", isError: true, preview: "disk on fire" },
    ]);
  });

  test("calls answered without running emit nothing: terminate and cancel", async () => {
    const terminated: TurnEvent[] = [];
    const terminating = createLoopEventRegistry();
    terminating.register("before_tool", async () => ({ kind: "terminate", content: "spin", isError: true }));
    await runToolBatch(args(terminated, { opts: answering("never"), loopEvents: terminating }));
    expect(terminated).toEqual([]);

    const cancelled: TurnEvent[] = [];
    const controller = new AbortController();
    controller.abort("stop");
    await runToolBatch(args(cancelled, { opts: answering("never"), deps: { ...deps, signal: controller.signal } }));
    expect(cancelled).toEqual([]);
  });

  test("ask_human emits no tool events", async () => {
    const events: TurnEvent[] = [];
    await runToolBatch(
      args(events, {
        opts: answering("yes"),
        maxInteractions: 1,
        toolCalls: [{ id: "q1", name: ASK_HUMAN_TOOL_NAME, input: { text: "proceed?" } }],
      }),
    );
    expect(events).toEqual([]);
  });
});
