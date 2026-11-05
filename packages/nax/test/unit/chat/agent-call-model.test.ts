import { describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import { withAgentCallModel } from "@/chat/agent-call-model";

function call(name: string, input: unknown): Extract<SessionEvent, { type: "tool_call" }> {
  return { sessionId: "s", turnId: "t", at: "2026-10-01T00:00:00.000Z", metadata: { keep: "me" }, type: "tool_call", callId: "c1", name, input };
}

function run(event: SessionEvent, modelFor: (agent: string, override?: string) => string | undefined) {
  const seen: SessionEvent[] = [];
  withAgentCallModel((e) => seen.push(e), modelFor)(event);
  return seen;
}

describe("withAgentCallModel", () => {
  test("adds metadata.subagentModel and keeps every other field", () => {
    const event = call("nax-agents__run", { agent: "reviewer", task: "t" });
    const seen = run(event, () => "openai/gpt-x");
    expect(seen).toEqual([{ ...event, metadata: { keep: "me", subagentModel: "openai/gpt-x" } }]);
  });

  test("passes the input's model override to modelFor", () => {
    const modelFor = mock((_agent: string, _override?: string) => "m");
    run(call("nax-agents__run", { agent: "reviewer", task: "t", model: "p/x" }), modelFor);
    expect(modelFor).toHaveBeenCalledWith("reviewer", "p/x");
  });

  test("forwards unchanged when modelFor returns undefined", () => {
    const event = call("nax-agents__run", { agent: "reviewer", task: "t" });
    const seen = run(event, () => undefined);
    expect(seen[0]).toBe(event);
  });

  test("forwards a Read call unchanged without calling modelFor", () => {
    const event = call("Read", { agent: "reviewer" });
    const modelFor = mock(() => "x");
    const seen = run(event, modelFor);
    expect(seen[0]).toBe(event);
    expect(modelFor).not.toHaveBeenCalled();
  });

  test("forwards unchanged when input.agent is not a string", () => {
    const event = call("nax-agents__run", { agent: 7, task: "t" });
    const modelFor = mock(() => "x");
    const seen = run(event, modelFor);
    assertDefined(seen[0], "event");
    expect(seen[0]).toBe(event);
    expect(modelFor).not.toHaveBeenCalled();
  });
});
