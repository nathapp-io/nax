/**
 * Reproducer for #523 — fallback state divergence across orphan AgentManagers.
 *
 * Before Wave 1: routing created its own AgentManager, execution created a separate one.
 * If routing marked an agent unavailable (e.g. 401), execution's fresh instance didn't
 * know — fallback state diverged. NaxRuntime fixes this by owning a single AgentManager
 * shared by both phases.
 */
import { describe, expect, test } from "bun:test";
import { makeTestRuntime } from "../../helpers";

describe("#523 — shared AgentManager across routing and execution via NaxRuntime", () => {
  test("markUnavailable on runtime.agentManager is visible to all consumers of the same runtime", () => {
    const rt = makeTestRuntime();
    const manager = rt.agentManager;

    // Simulate routing phase marking the primary agent unavailable (e.g. 401)
    manager.markUnavailable("claude", {
      category: "availability",
      outcome: "fail-auth",
      retriable: false,
      message: "401 from routing LLM call",
    });

    // Execution phase — same runtime, same manager reference — sees the unavailability
    expect(manager.isUnavailable("claude")).toBe(true);
  });

  test("two separate runtimes have independent AgentManager state", () => {
    const rt1 = makeTestRuntime();
    const rt2 = makeTestRuntime();

    rt1.agentManager.markUnavailable("claude", {
      category: "availability",
      outcome: "fail-auth",
      retriable: false,
      message: "401 on run 1",
    });

    // Different runtime — should not see rt1's unavailability
    expect(rt1.agentManager.isUnavailable("claude")).toBe(true);
    expect(rt2.agentManager.isUnavailable("claude")).toBe(false);
  });

  test("runtime.agentManager reference is stable across the runtime lifetime", () => {
    const rt = makeTestRuntime();
    const ref1 = rt.agentManager;
    const ref2 = rt.agentManager;
    expect(ref1).toBe(ref2);
  });
});
