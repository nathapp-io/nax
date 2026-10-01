import { describe, expect, test } from "bun:test";
import { resolveDefaultAgent } from "@/agents";
import { DEFAULT_CONFIG } from "@/config/defaults";

import { agentConfigSelector } from "@/config/selectors";

describe("resolveDefaultAgent — execution lifecycle", () => {
  test("resolves from canonical config.agent.default", () => {
    const config = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, default: "codex" } };
    expect(resolveDefaultAgent(agentConfigSelector.select(config))).toBe("codex");
  });
});
