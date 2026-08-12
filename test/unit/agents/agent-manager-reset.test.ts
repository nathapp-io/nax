import { describe, expect, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

describe("AgentManager availability recovery between stories", () => {
  test("transient unavailable state from one story does not bleed into the next", () => {
    const config = {
      ...DEFAULT_CONFIG,
      agent: { default: "claude" },
    } as never;
    const manager = new AgentManager(config);

    manager.markUnavailable("claude", {
      category: "availability",
      outcome: "fail-rate-limit",
      retriable: true,
      message: "story 1 rate limit",
    });

    expect(manager.isUnavailable("claude")).toBe(true);

    manager.resetTransientUnavailable();

    expect(manager.isUnavailable("claude")).toBe(false);
  });

  test.each(["fail-auth", "fail-quota"] as const)("keeps permanent %s failures unavailable", (outcome) => {
    const manager = new AgentManager({ ...DEFAULT_CONFIG, agent: { default: "claude" } } as never);
    manager.markUnavailable("claude", {
      category: "availability",
      outcome,
      retriable: false,
      message: "permanent failure",
    });

    manager.resetTransientUnavailable();

    expect(manager.isUnavailable("claude")).toBe(true);
  });
});
