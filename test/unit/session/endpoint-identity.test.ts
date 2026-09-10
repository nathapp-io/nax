import { describe, expect, test } from "bun:test";
import type { SessionHandle } from "@/agents/session-types";
import type { ModelDef } from "@/config/schema-types";
import { decideReuse, sameEndpoint } from "@/session/endpoint-identity";
import type { SessionDescriptor } from "@/session/types";

const model = (id: string, provider = "p"): ModelDef => ({ provider, model: id });

const handle = (agentName: string, modelDef: ModelDef): SessionHandle => ({ id: "nax-x", agentName, modelDef });

const desc = (state: SessionDescriptor["state"]): SessionDescriptor => ({
  id: "sess-1",
  role: "implementer",
  state,
  agent: "native",
  workdir: "/w",
  protocolIds: { recordId: null, sessionId: null },
  completedStages: [],
  createdAt: "2026-09-10T00:00:00.000Z",
  lastActivityAt: "2026-09-10T00:00:00.000Z",
});

describe("sameEndpoint()", () => {
  test("provider and model both equal", () => {
    expect(sameEndpoint(model("m", "a"), model("m", "a"))).toBe(true);
  });

  test("different model id", () => {
    expect(sameEndpoint(model("m1"), model("m2"))).toBe(false);
  });

  test("different provider", () => {
    expect(sameEndpoint(model("m", "a"), model("m", "b"))).toBe(false);
  });

  test("metadata is not identity", () => {
    expect(sameEndpoint({ provider: "a", model: "m", contextWindow: 1 }, { provider: "a", model: "m" })).toBe(true);
  });

  test("an unrecorded endpoint never matches a recorded one", () => {
    expect(sameEndpoint(undefined, model("m"))).toBe(false);
  });
});

describe("decideReuse()", () => {
  test("no live handle -> reopen", () => {
    expect(decideReuse(undefined, undefined, { agentName: "native", modelDef: model("m") })).toBe("reopen");
  });

  test("terminal descriptor -> reopen (adapter session already closed)", () => {
    const live = handle("native", model("m"));
    expect(decideReuse(live, desc("COMPLETED"), { agentName: "native", modelDef: model("m") })).toBe("reopen");
  });

  test("same agent, same endpoint -> reuse", () => {
    const live = handle("native", model("m"));
    expect(decideReuse(live, desc("RUNNING"), { agentName: "native", modelDef: model("m") })).toBe("reuse");
  });

  test("same agent, different endpoint -> close-then-reopen", () => {
    const live = handle("native", model("minimax/MiniMax-M3"));
    const requested = { agentName: "native", modelDef: model("opencode-go/deepseek-v4-flash[high]") };
    expect(decideReuse(live, desc("RUNNING"), requested)).toBe("close-then-reopen");
  });

  test("different agent -> close-then-reopen (no orphaned acpx process)", () => {
    const live = handle("claude", model("sonnet"));
    expect(decideReuse(live, desc("RUNNING"), { agentName: "native", modelDef: model("m") })).toBe("close-then-reopen");
  });
});
