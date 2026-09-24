/**
 * US-004 — the awaiting_human native activity maps to an AgentStreamEvent the
 * idle watchdog can see.
 *
 * AC4 pins the mapping in `buildNativeStreamEvent`: an `awaiting_human`
 * activity beat becomes the `agent.awaiting_human` stream event on the same
 * call id as every other beat from the same turn.
 */

import { describe, expect, test } from "bun:test";
import { buildNativeStreamEvent, type NativeStreamEventBase } from "@/agents/native/session/turn-events";

const base: NativeStreamEventBase = {
  callId: "call-004",
  runId: "run-004",
  agentName: "native",
  sessionName: "sess-004",
};

describe("buildNativeStreamEvent — awaiting_human (US-004)", () => {
  test("AC4: maps awaiting_human to kind agent.awaiting_human with the base callId", () => {
    const event = buildNativeStreamEvent(base, { kind: "awaiting_human" }, 1234);

    expect(event.kind).toBe("agent.awaiting_human");
    expect(event.callId).toBe(base.callId);
    expect(event).toEqual({ ...base, kind: "agent.awaiting_human", timestamp: 1234 });
  });
});
