import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { _agentManagerDeps, AgentManager } from "@/agents/manager";
import type { AdapterFailure } from "@/context/engine";

const failure = (outcome: AdapterFailure["outcome"]): AdapterFailure => ({
  category: "availability",
  outcome,
  retriable: true,
  message: "",
});

const config = () =>
  makeNaxConfig({
    agent: {
      fallback: {
        enabled: true,
        map: { claude: ["codex", "gemini"] },
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: true,
      },
    },
  });

/** Swaps the module-level clock for the duration of one test. */
function withClock<T>(now: () => number, fn: () => T): T {
  const original = _agentManagerDeps.now;
  _agentManagerDeps.now = now;
  try {
    return fn();
  } finally {
    _agentManagerDeps.now = original;
  }
}

describe("AgentManager availability is a cooldown, not a retirement", () => {
  test("a rate-limited agent becomes available again once its cooldown expires", () => {
    let now = 1_000;
    withClock(
      () => now,
      () => {
        const manager = new AgentManager(config());
        manager.markUnavailable("codex", failure("fail-rate-limit"));

        expect(manager.isUnavailable("codex")).toBe(true);
        now += 61_000;
        expect(manager.isUnavailable("codex")).toBe(false);
      },
    );
  });

  test("a fail-auth agent stays unavailable no matter how far the clock advances", () => {
    let now = 1_000;
    withClock(
      () => now,
      () => {
        const manager = new AgentManager(config());
        manager.markUnavailable("codex", failure("fail-auth"));

        now += 3_600_000;
        expect(manager.isUnavailable("codex")).toBe(true);
      },
    );
  });

  test("a timed-out agent is never marked unavailable at all", () => {
    const manager = new AgentManager(config());
    manager.markUnavailable("codex", failure("fail-timeout"));
    expect(manager.isUnavailable("codex")).toBe(false);
  });
});

describe("AgentManager.nextCandidate explicit exclusion", () => {
  test("skips the excluded agent and returns the next one", () => {
    const manager = new AgentManager(config());
    expect(manager.nextCandidate("claude", 0, "codex")).toEqual({ agent: "gemini" });
  });

  test("returns null when the excluded agent was the only candidate left", () => {
    const manager = new AgentManager(config());
    manager.markUnavailable("gemini", failure("fail-auth"));
    expect(manager.nextCandidate("claude", 0, "codex")).toBeNull();
  });

  test("without an exclude argument it returns what it returns today", () => {
    const manager = new AgentManager(config());
    expect(manager.nextCandidate("claude", 0)).toEqual({ agent: "codex" });
  });
});
