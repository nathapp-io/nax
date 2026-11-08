import { describe, expect, test } from "bun:test";
import { resolveDefaultAgent } from "@/agents";
import { pickSelector } from "@/config";
import { DEFAULT_CONFIG } from "@/config/defaults";

describe("resolveDefaultAgent — execution lifecycle", () => {
  test("resolves from canonical config.agent.default", () => {
    const config = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, default: "codex" } };
    expect(resolveDefaultAgent(pickSelector("agent", "agent").select(config))).toBe("codex");
  });
});
