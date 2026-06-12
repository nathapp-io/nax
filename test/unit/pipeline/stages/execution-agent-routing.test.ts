import { describe, expect, test } from "bun:test";
import { resolveExecutionAgent } from "@/pipeline/stages/execution-helpers";

const fakeAdapter = (name: string) => ({ name }) as never;

describe("resolveExecutionAgent", () => {
  test("uses the routed agent when its adapter resolves", () => {
    const result = resolveExecutionAgent({
      routedAgent: "opencode",
      defaultAgent: "claude",
      getAgent: (n: string) => (n === "opencode" ? fakeAdapter("opencode") : undefined),
    });
    expect(result.agentName).toBe("opencode");
    expect(result.degraded).toBe(false);
    expect(result.agent).toBeDefined();
  });

  test("degrades to the default agent when the routed agent is unresolvable", () => {
    const result = resolveExecutionAgent({
      routedAgent: "ghost",
      defaultAgent: "claude",
      getAgent: (n: string) => (n === "claude" ? fakeAdapter("claude") : undefined),
    });
    expect(result.agentName).toBe("claude");
    expect(result.degraded).toBe(true);
    expect(result.agent).toBeDefined();
  });

  test("uses the default agent when no routed agent is set", () => {
    const result = resolveExecutionAgent({
      routedAgent: undefined,
      defaultAgent: "claude",
      getAgent: (n: string) => (n === "claude" ? fakeAdapter("claude") : undefined),
    });
    expect(result.agentName).toBe("claude");
    expect(result.degraded).toBe(false);
  });

  test("returns undefined adapter (degraded) when neither resolves", () => {
    const result = resolveExecutionAgent({
      routedAgent: "ghost",
      defaultAgent: "claude",
      getAgent: () => undefined,
    });
    expect(result.agentName).toBe("claude");
    expect(result.agent).toBeUndefined();
    expect(result.degraded).toBe(true);
  });
});
