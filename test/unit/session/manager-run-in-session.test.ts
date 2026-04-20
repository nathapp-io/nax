/**
 * SessionManager.runInSession — per-session lifecycle primitive.
 *
 * Contract:
 *   - transitions CREATED → RUNNING before the runner fires (idempotent —
 *     RESUMING state is left alone)
 *   - binds protocolIds from the runner's return value
 *   - transitions RUNNING → COMPLETED on success, RUNNING → FAILED on failure
 *   - on thrown error: marks session FAILED, re-raises
 */

import { describe, expect, test } from "bun:test";
import { SessionManager } from "../../../src/session/manager";
import type { AgentResult, AgentRunOptions } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";

function makeOptions(): AgentRunOptions {
  return {
    prompt: "test",
    workdir: "/tmp/x",
    modelTier: "fast",
    modelDef: { provider: "anthropic", model: "claude-haiku", env: {} },
    timeoutSeconds: 30,
    config: {} as NaxConfig,
  };
}

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    exitCode: 0,
    output: "ok",
    rateLimited: false,
    durationMs: 100,
    estimatedCost: 0.01,
    ...overrides,
  };
}

describe("SessionManager.runInSession", () => {
  test("transitions CREATED → RUNNING → COMPLETED on success", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "nax-test" });

    const observed: string[] = [];
    const result = await mgr.runInSession(
      d.id,
      async () => {
        observed.push(mgr.get(d.id)?.state ?? "?");
        return makeResult();
      },
      makeOptions(),
    );

    expect(observed).toEqual(["RUNNING"]);
    expect(mgr.get(d.id)?.state).toBe("COMPLETED");
    expect(result.success).toBe(true);
  });

  test("transitions to FAILED when runner returns success=false", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "nax-test" });

    await mgr.runInSession(d.id, async () => makeResult({ success: false }), makeOptions());

    expect(mgr.get(d.id)?.state).toBe("FAILED");
  });

  test("transitions to FAILED and re-throws when runner throws", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "nax-test" });

    const err = new Error("runner boom");
    let caught: unknown;
    try {
      await mgr.runInSession(
        d.id,
        async () => {
          throw err;
        },
        makeOptions(),
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(err);
    expect(mgr.get(d.id)?.state).toBe("FAILED");
  });

  test("binds protocolIds from runner result onto the descriptor", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "nax-test" });

    await mgr.runInSession(
      d.id,
      async () => makeResult({ protocolIds: { recordId: "rec-1", sessionId: "sess-1" } }),
      makeOptions(),
    );

    expect(mgr.get(d.id)?.protocolIds).toEqual({ recordId: "rec-1", sessionId: "sess-1" });
  });

  test("throws SESSION_NOT_FOUND for unknown id", async () => {
    const mgr = new SessionManager();

    let caught: unknown;
    try {
      await mgr.runInSession("sess-nonexistent", async () => makeResult(), makeOptions());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain("sess-nonexistent");
  });

  test("leaves non-CREATED sessions alone (does not force RUNNING)", async () => {
    // RESUMING-state sessions should not be force-transitioned through RUNNING.
    // Only CREATED → RUNNING is automatic.
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "nax-test" });
    mgr.transition(d.id, "RUNNING");
    mgr.transition(d.id, "PAUSED");
    mgr.transition(d.id, "RESUMING");
    // RESUMING is not CREATED — runInSession should not try to re-enter RUNNING
    // via the auto-transition logic. The runner still executes and the final
    // transition happens if the session is RUNNING by end of run — which it
    // won't be here. So the session state won't advance to COMPLETED.

    const result = await mgr.runInSession(d.id, async () => makeResult(), makeOptions());
    expect(result.success).toBe(true);
    // State should still be RESUMING — auto-transition only fires from CREATED.
    expect(mgr.get(d.id)?.state).toBe("RESUMING");
  });

  test("propagates tokenUsage through the returned result unchanged", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "nax-test" });

    const result = await mgr.runInSession(
      d.id,
      async () =>
        makeResult({
          tokenUsage: { inputTokens: 100, outputTokens: 50, cache_read_input_tokens: 10 },
        }),
      makeOptions(),
    );

    expect(result.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50, cache_read_input_tokens: 10 });
  });
});
