import { describe, expect, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

describe("AgentManager.reset — called between stories", () => {
  test("unavailable state from one story does not bleed into the next", () => {
    const config = {
      ...DEFAULT_CONFIG,
      autoMode: { defaultAgent: "claude" },
    } as never;
    const manager = new AgentManager(config);

    manager.markUnavailable("claude", {
      category: "availability",
      outcome: "fail-auth",
      retriable: false,
      message: "story 1 auth failure",
    });

    expect(manager.isUnavailable("claude")).toBe(true);

    manager.reset();

    expect(manager.isUnavailable("claude")).toBe(false);
  });
});
