import { describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import { withAgentCallModel } from "@/chat/agent-call-model";
import type { SubagentModelLabel } from "@/chat/subagent-model";
import type { SubagentRuns } from "@/chat/subagent-runs";

type ModelFor = SubagentRuns["modelFor"];

function call(name: string, input: unknown): Extract<SessionEvent, { type: "tool_call" }> {
  return {
    sessionId: "s",
    turnId: "t",
    at: "2026-10-01T00:00:00.000Z",
    metadata: { keep: "me" },
    type: "tool_call",
    callId: "c1",
    name,
    input,
  };
}

/** What `modelFor` returns: the model together with the label naming where it came from. */
function resolved(model: string, label: SubagentModelLabel): { model: string; label: SubagentModelLabel } {
  return { model, label };
}

function run(event: SessionEvent, modelFor: ModelFor): SessionEvent[] {
  const seen: SessionEvent[] = [];
  withAgentCallModel((e) => seen.push(e), modelFor)(event);
  return seen;
}

describe("withAgentCallModel", () => {
  // US-003 AC-15: the model and the label that names its source land together, so the
  // Agent card can say "[model · source]" without re-resolving anything.
  test("AC-15 stamps metadata.subagentModel and metadata.subagentModelSource, keeping every other field", () => {
    const event = call("nax-agents__run", { agent: "reviewer", task: "t" });
    const seen = run(event, () => resolved("openai/gpt-x", "agent file"));
    expect(seen).toEqual([
      {
        ...event,
        metadata: { keep: "me", subagentModel: "openai/gpt-x", subagentModelSource: "agent file" },
      },
    ]);
  });

  test("passes the input's model override to modelFor", () => {
    const modelFor: ModelFor = mock(() => resolved("m", "inherited"));
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
    const modelFor: ModelFor = mock(() => resolved("x", "inherited"));
    const seen = run(event, modelFor);
    expect(seen[0]).toBe(event);
    expect(modelFor).not.toHaveBeenCalled();
  });

  test("forwards unchanged when input.agent is not a string", () => {
    const event = call("nax-agents__run", { agent: 7, task: "t" });
    const modelFor: ModelFor = mock(() => resolved("x", "inherited"));
    const seen = run(event, modelFor);
    assertDefined(seen[0], "event");
    expect(seen[0]).toBe(event);
    expect(modelFor).not.toHaveBeenCalled();
  });

  // An absent agent with a model is a general-agent run: there is no name to resolve,
  // so the model is passed as the override and the name is undefined.
  test("AC-16 an absent agent passes the model to modelFor as the undefined name's override", () => {
    const modelFor: ModelFor = mock(() => resolved("p/x", "override"));
    run(call("nax-agents__run", { task: "t", model: "p/x" }), modelFor);
    expect(modelFor).toHaveBeenCalledWith(undefined, "p/x");
  });

  test("AC-17 an absent agent and model forwards the event unchanged", () => {
    const event = call("nax-agents__run", { task: "t" });
    const seen = run(event, () => resolved("x", "inherited"));
    expect(seen[0]).toBe(event);
  });

  test("AC-18 an absent agent and model does not call modelFor", () => {
    const modelFor: ModelFor = mock(() => resolved("x", "inherited"));
    run(call("nax-agents__run", { task: "t" }), modelFor);
    expect(modelFor).not.toHaveBeenCalled();
  });

  test("AC-19 a non-string model with no agent forwards the event unchanged", () => {
    const event = call("nax-agents__run", { task: "t", model: 7 });
    const seen = run(event, () => resolved("x", "inherited"));
    expect(seen[0]).toBe(event);
  });

  test("AC-20 a non-string model with no agent does not call modelFor", () => {
    const modelFor: ModelFor = mock(() => resolved("x", "inherited"));
    run(call("nax-agents__run", { task: "t", model: 7 }), modelFor);
    expect(modelFor).not.toHaveBeenCalled();
  });
});
