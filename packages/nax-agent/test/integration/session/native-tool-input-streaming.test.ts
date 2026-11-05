/**
 * US-003: a native send() surfaces the growth of a streamed tool call's
 * arguments as count-only tool_input_delta events, before the tool_call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type AgentSession, createAgentSession, type EmbedderTool } from "@nathapp/nax-agent";
import type { ProtocolEvent } from "@nathapp/nax-ai";
import {
  collect,
  installScriptedProvider,
  resetScriptedProvider,
  sessionOptions,
  textRound,
} from "#test/helpers/agent-session";

const sessions: AgentSession[] = [];
afterEach(async () => {
  try {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  } finally {
    resetScriptedProvider();
  }
});

const probe: EmbedderTool = {
  name: "probe",
  description: "a probe",
  inputSchema: { type: "object", properties: { step: { type: "number" } }, required: ["step"] },
  approval: "never",
  async run() {
    return { content: "ok" };
  },
};

const RAW = ['{"st', '{"step":', '{"step": 1}'];

const streamedCall: ProtocolEvent[] = [
  ...RAW.map((rawInput): ProtocolEvent => ({ type: "tool-call-partial", id: "t1", name: "probe", rawInput })),
  { type: "tool-call", call: { id: "t1", name: "probe", input: { step: 1 } } },
  { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
  { type: "done", stopReason: "tool_use" },
];

async function run() {
  const provider = installScriptedProvider();
  provider.push(streamedCall, textRound("done"));
  const session = await createAgentSession(sessionOptions({ tools: [probe] }));
  sessions.push(session);
  return collect(session.send("hi"));
}

describe("native tool-input streaming", () => {
  test("AC-5: tool_input_delta events carry callId, name and round, before the tool_call", async () => {
    const events = await run();
    const deltas = events.flatMap((e, i) => (e.type === "tool_input_delta" ? [{ e, i }] : []));
    const callIndex = events.findIndex((e) => e.type === "tool_call");
    expect(deltas.length).toBeGreaterThan(0);
    for (const { e, i } of deltas) {
      expect(e).toMatchObject({ callId: "t1", name: "probe", round: 1 });
      expect(i).toBeLessThan(callIndex);
      expect("text" in e).toBe(false);
    }
  });

  test("AC-6: the chars of one call's deltas sum to the last partial's length", async () => {
    const events = await run();
    const total = events.reduce((n, e) => (e.type === "tool_input_delta" ? n + e.chars : n), 0);
    expect(total).toBe(RAW[2]?.length);
  });
});
