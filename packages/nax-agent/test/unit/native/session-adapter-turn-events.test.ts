/**
 * S3-3: onTurnEvent end to end through NativeSessionAdapter.sendTurn, and the
 * sink is invisible to nax: with no sink, a collecting sink, a throwing sink or
 * an async sink that rejects, the TurnResult, the saved transcript and the
 * stream-bus activity are identical (spec 8: behaviour-neutral pins).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentStreamEvent,
  CodingTool,
  SendTurnOpts,
  SessionModel,
  TurnEvent,
  TurnEventSink,
  TurnResult,
} from "@nathapp/nax-agent";
import { _clientDeps, _resetNativeClient, loadTranscript } from "@nathapp/nax-agent/internal";
import type { Client, ProtocolEvent, ResolvedModel } from "@nathapp/nax-ai";
import { NativeSessionAdapter } from "#src/native/session-adapter";

const REAL_BUILD = _clientDeps.build;
afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

const model: ResolvedModel = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
};
const MODEL_DEF: SessionModel = { provider: "unknown", model: "openai/gpt-5.4-mini" };

const fakeRead: CodingTool = {
  name: "Read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "never run: the interaction handler answers" };
  },
};

const ROUND_1: ProtocolEvent[] = [
  { type: "text-delta", text: "Let me look" },
  { type: "tool-call", call: { id: "c1", name: "Read", input: { path: "a.ts" } } },
  { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
  { type: "done", stopReason: "tool_use" },
];
const ROUND_2: ProtocolEvent[] = [
  { type: "text-delta", text: "done" },
  { type: "usage", usage: { inputTokens: 6, outputTokens: 1 } },
  { type: "done", stopReason: "stop" },
];

function scriptedClient(): Client {
  let calls = 0;
  return {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => model.pricing,
    stream() {
      calls += 1;
      const events = calls === 1 ? ROUND_1 : ROUND_2;
      return (async function* replay() {
        yield* events;
      })();
    },
    complete: async () => {
      throw new Error("round trips must stream");
    },
    validate: () => {},
  };
}

interface Run {
  readonly result: TurnResult;
  readonly transcript: unknown;
  readonly activity: unknown[];
}

async function runTurn(onTurnEvent?: TurnEventSink): Promise<Run> {
  _resetNativeClient();
  _clientDeps.build = async () => scriptedClient();
  const adapter = new NativeSessionAdapter();
  const dir = await mkdtemp(join(tmpdir(), "nax-adapter-turn-events-"));
  const activity: AgentStreamEvent[] = [];
  const handle = await adapter.openSession("turn-events", {
    agentName: "native",
    workdir: dir,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: MODEL_DEF,
    timeoutSeconds: 60,
    transcriptDir: dir,
    onStreamActivity: (event) => void activity.push(event),
  });
  const opts: SendTurnOpts = {
    // Coding-tool calls reach the handler as kind "coding-tool"; its answer is the tool result.
    interactionHandler: { onInteraction: async () => ({ answer: "contents" }) },
    codingTools: [fakeRead],
    ...(onTurnEvent !== undefined ? { onTurnEvent } : {}),
  };
  const result = await adapter.sendTurn(handle, "read a.ts", opts);
  return {
    result,
    transcript: await loadTranscript(dir, handle.id),
    activity: activity.map(({ callId: _c, timestamp: _t, ...rest }) => rest),
  };
}

describe("NativeSessionAdapter.sendTurn onTurnEvent (S3-3)", () => {
  test("streams the turn's events in order", async () => {
    const events: TurnEvent[] = [];
    const { result } = await runTurn((e) => void events.push(e));
    expect(events).toEqual([
      { type: "text_delta", round: 1, text: "Let me look" },
      { type: "usage", round: 1, inputTokens: 4, outputTokens: 2, costUsd: expect.any(Number) },
      { type: "tool_call", callId: "c1", name: "Read", input: { path: "a.ts" } },
      { type: "tool_result", callId: "c1", isError: false, preview: "contents" },
      { type: "text_delta", round: 2, text: "done" },
      { type: "usage", round: 2, inputTokens: 6, outputTokens: 1, costUsd: expect.any(Number) },
    ]);
    expect(result.output).toBe("done");
  });

  test("the sink is invisible to nax: no sink, collecting, throwing and rejecting sinks give the same turn", async () => {
    const throwing: TurnEventSink = () => {
      throw new Error("sink exploded");
    };
    const rejecting: TurnEventSink = async () => {
      throw new Error("async sink exploded");
    };
    const baseline = await runTurn();
    for (const sink of [(_e: TurnEvent) => {}, throwing, rejecting]) {
      expect(await runTurn(sink)).toEqual(baseline);
    }
  });
});
