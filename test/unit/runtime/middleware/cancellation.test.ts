import { describe, test, expect } from "bun:test";
import { cancellationMiddleware } from "../../../../src/runtime/middleware/cancellation";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { MiddlewareContext } from "../../../../src/runtime/agent-middleware";

function makeCtx(aborted = false): MiddlewareContext {
  const ctrl = new AbortController();
  if (aborted) ctrl.abort();
  return {
    runId: "r-001", agentName: "claude", kind: "run",
    request: null, prompt: null, config: DEFAULT_CONFIG,
    signal: ctrl.signal,
    resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
  };
}

describe("cancellationMiddleware", () => {
  test("before() passes through when signal is not aborted", async () => {
    const mw = cancellationMiddleware();
    await expect(mw.before!(makeCtx(false))).resolves.toBeUndefined();
  });

  test("before() throws NaxError when signal is already aborted", async () => {
    const mw = cancellationMiddleware();
    await expect(mw.before!(makeCtx(true))).rejects.toThrow("Agent call cancelled");
  });

  test("before() passes through when signal is undefined", async () => {
    const mw = cancellationMiddleware();
    const ctx: MiddlewareContext = {
      runId: "r-001", agentName: "claude", kind: "run",
      request: null, prompt: null, config: DEFAULT_CONFIG,
      resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
    };
    await expect(mw.before!(ctx)).resolves.toBeUndefined();
  });

  test("before() throws for kind='complete' with aborted signal", async () => {
    const mw = cancellationMiddleware();
    const ctrl = new AbortController();
    ctrl.abort();
    const ctx: MiddlewareContext = {
      runId: "r-001", agentName: "claude", kind: "complete",
      request: null, prompt: "test", config: DEFAULT_CONFIG,
      signal: ctrl.signal,
      resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
    };
    await expect(mw.before!(ctx)).rejects.toThrow("Agent call cancelled");
  });
});
