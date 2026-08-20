import { describe, expect, test } from "bun:test";
import { AgentManager } from "@/agents";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { createAgentRegistry } from "@/agents/registry";

describe("Runner → AgentManager wiring", () => {
  test("AgentManager constructed from config + registry", () => {
    const registry = createAgentRegistry(DEFAULT_CONFIG);
    const manager = new AgentManager(DEFAULT_CONFIG, registry);
    expect(manager.getDefault()).toBe(DEFAULT_CONFIG.agent?.default ?? "claude");
  });
});
