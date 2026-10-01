import { describe, expect, test } from "bun:test";
import { makeSessionManager, makeTestContext } from "@test/helpers";
import { cleanupSessionOnFailure } from "@/execution/lifecycle/post-run-session-cleanup";

describe("cleanupSessionOnFailure", () => {
  test.each([
    ["the session manager is absent", makeTestContext({ sessionManager: undefined, sessionId: "session-1" })],
    ["the session id is absent", makeTestContext({ sessionManager: makeSessionManager(), sessionId: undefined })],
  ])("does not invoke cleanup when %s", async (_condition, ctx) => {
    let calls = 0;

    await cleanupSessionOnFailure(ctx, async () => {
      calls += 1;
    });

    expect(calls).toBe(0);
  });

  test("forwards the wrapper-owned session and agent resolver to cleanup", async () => {
    const sessionManager = makeSessionManager();
    const agentGetFn = (_name: string) => undefined;
    const ctx = makeTestContext({ sessionManager, sessionId: "session-1", agentGetFn });
    const calls: Array<{ sessionId: string; agentGetFn: typeof ctx.agentGetFn }> = [];

    await cleanupSessionOnFailure(ctx, async (receivedManager, sessionId, receivedAgentGetFn) => {
      expect(receivedManager).toBe(sessionManager);
      calls.push({ sessionId, agentGetFn: receivedAgentGetFn });
    });

    expect(calls).toEqual([{ sessionId: "session-1", agentGetFn }]);
  });
});
