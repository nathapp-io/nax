/**
 * SessionManager.runInSession — eager protocolId binding via
 * onSessionEstablished (#591).
 *
 * Invariant: if the runner fires the onSessionEstablished callback before
 * completing (e.g. right after the physical session is opened), the
 * descriptor must carry the protocolIds BEFORE the runner returns. If the
 * run is then interrupted (SIGINT, crash, first-turn failure), the on-disk
 * descriptor still has the correlation needed to resume.
 */

import { describe, expect, test } from "bun:test";
import type { AgentResult, AgentRunOptions } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import { SessionManager } from "../../../src/session/manager";

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

function makeResult(): AgentResult {
  return {
    success: true,
    exitCode: 0,
    output: "ok",
    rateLimited: false,
    durationMs: 100,
    estimatedCost: 0.01,
  };
}

describe("SessionManager.runInSession — onSessionEstablished (#591)", () => {
  test("fires onSessionEstablished and binds handle + protocolIds before runner returns", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });

    // Descriptor starts with null protocolIds.
    expect(mgr.get(d.id)?.protocolIds).toEqual({ recordId: null, sessionId: null });
    expect(mgr.get(d.id)?.handle).toBeUndefined();

    // State before the runner returns — captured inside the runner via
    // the callback, which fires BEFORE completing.
    type Observed = { protocolIds: unknown; handle: unknown };
    let observedDuringRun: Observed | null = null;

    await mgr.runInSession(
      d.id,
      async (opts) => {
        // Simulate adapter firing the callback after ensureAcpSession succeeds.
        opts.onSessionEstablished?.({ recordId: "rec-early", sessionId: "sess-early" }, "nax-early-handle");
        // Capture descriptor state from before the runner returns.
        observedDuringRun = {
          protocolIds: mgr.get(d.id)?.protocolIds,
          handle: mgr.get(d.id)?.handle,
        };
        return makeResult();
      },
      makeOptions(),
    );

    // Eager binding during the runner — this is the whole point of #591.
    if (!observedDuringRun) throw new Error("runner never observed descriptor state");
    const captured: Observed = observedDuringRun;
    expect(captured.protocolIds).toEqual({ recordId: "rec-early", sessionId: "sess-early" });
    expect(captured.handle).toBe("nax-early-handle");
  });

  test("descriptor retains protocolIds even if the runner throws after onSessionEstablished fires", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });

    let caught: unknown;
    try {
      await mgr.runInSession(
        d.id,
        async (opts) => {
          opts.onSessionEstablished?.({ recordId: "rec-crash", sessionId: "sess-crash" }, "nax-crash-handle");
          throw new Error("runner crashed mid-flight");
        },
        makeOptions(),
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    // #591 guarantee: protocolIds were persisted before the throw.
    expect(mgr.get(d.id)?.protocolIds).toEqual({ recordId: "rec-crash", sessionId: "sess-crash" });
    expect(mgr.get(d.id)?.handle).toBe("nax-crash-handle");
    // State still transitions to FAILED.
    expect(mgr.get(d.id)?.state).toBe("FAILED");
  });

  test("chains caller-provided onSessionEstablished after the manager's own", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });

    const callerCalls: Array<{ ids: unknown; name: string }> = [];
    const callerCallback = (ids: unknown, name: string) => {
      callerCalls.push({ ids, name });
    };

    await mgr.runInSession(
      d.id,
      async (opts) => {
        opts.onSessionEstablished?.({ recordId: "rec-1", sessionId: "sess-1" }, "nax-chain");
        return makeResult();
      },
      { ...makeOptions(), onSessionEstablished: callerCallback },
    );

    // Manager bound the handle...
    expect(mgr.get(d.id)?.handle).toBe("nax-chain");
    expect(mgr.get(d.id)?.protocolIds).toEqual({ recordId: "rec-1", sessionId: "sess-1" });
    // ...AND the caller's own callback still fired.
    expect(callerCalls).toHaveLength(1);
    expect(callerCalls[0]).toEqual({
      ids: { recordId: "rec-1", sessionId: "sess-1" },
      name: "nax-chain",
    });
  });

  test("no-op when the runner never fires the callback (legacy adapter path)", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "pre-existing" });

    // Runner returns protocolIds only in the final result — like the
    // pre-#591 adapter path. runInSession's post-run bindHandle should
    // still fire.
    await mgr.runInSession(
      d.id,
      async () => ({ ...makeResult(), protocolIds: { recordId: "rec-late", sessionId: "sess-late" } }),
      makeOptions(),
    );

    expect(mgr.get(d.id)?.protocolIds).toEqual({ recordId: "rec-late", sessionId: "sess-late" });
    // handle was pre-existing so bindHandle at the end uses it.
    expect(mgr.get(d.id)?.handle).toBe("pre-existing");
  });
});
