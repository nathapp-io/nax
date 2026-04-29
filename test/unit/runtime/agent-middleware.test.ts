import { describe, test, expect } from "bun:test";
import { MiddlewareChain, type AgentMiddleware, type MiddlewareContext } from "../../../src/runtime/agent-middleware";
import { DEFAULT_CONFIG } from "../../../src/config";

function makeCtx(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    runId: "r-001",
    agentName: "claude",
    kind: "run",
    request: null,
    config: DEFAULT_CONFIG,
    resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
    ...overrides,
  };
}

describe("MiddlewareChain", () => {
  test("empty() — runBefore is a no-op", async () => {
    await expect(MiddlewareChain.empty().runBefore(makeCtx())).resolves.toBeUndefined();
  });

  test("calls before hooks in order", async () => {
    const calls: string[] = [];
    const a: AgentMiddleware = { name: "a", before: async () => { calls.push("a"); } };
    const b: AgentMiddleware = { name: "b", before: async () => { calls.push("b"); } };
    await MiddlewareChain.from([a, b]).runBefore(makeCtx());
    expect(calls).toEqual(["a", "b"]);
  });

  test("calls after hooks in order with result + durationMs", async () => {
    const calls: Array<[string, unknown, number]> = [];
    const a: AgentMiddleware = { name: "a", after: async (_, r, d) => { calls.push(["a", r, d]); } };
    const b: AgentMiddleware = { name: "b", after: async (_, r, d) => { calls.push(["b", r, d]); } };
    await MiddlewareChain.from([a, b]).runAfter(makeCtx(), { success: true }, 42);
    expect(calls).toEqual([["a", { success: true }, 42], ["b", { success: true }, 42]]);
  });

  test("calls onError hooks in order with err + durationMs", async () => {
    const calls: string[] = [];
    const err = new Error("boom");
    const a: AgentMiddleware = { name: "a", onError: async (_, e) => { calls.push(String(e)); } };
    await MiddlewareChain.from([a]).runOnError(makeCtx(), err, 10);
    expect(calls).toEqual(["Error: boom"]);
  });

  test("skips middleware with no hook for the phase", async () => {
    const mw: AgentMiddleware = { name: "noop" };
    await expect(MiddlewareChain.from([mw]).runBefore(makeCtx())).resolves.toBeUndefined();
    await expect(MiddlewareChain.from([mw]).runAfter(makeCtx(), null, 0)).resolves.toBeUndefined();
    await expect(MiddlewareChain.from([mw]).runOnError(makeCtx(), new Error(), 0)).resolves.toBeUndefined();
  });

  test("passes MiddlewareContext through to each hook", async () => {
    const seen: string[] = [];
    const mw: AgentMiddleware = { name: "spy", before: async (ctx) => { seen.push(ctx.agentName); } };
    await MiddlewareChain.from([mw]).runBefore(makeCtx({ agentName: "codex" }));
    expect(seen).toEqual(["codex"]);
  });
});
