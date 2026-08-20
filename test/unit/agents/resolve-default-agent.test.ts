// test/unit/agents/resolve-default-agent.test.ts
import { describe, expect, test } from "bun:test";
import { resolveDefaultAgent } from "@/agents/utils";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config/defaults";

function cfg(overrides: Record<string, unknown> = {}): NaxConfig {
  return { ...DEFAULT_CONFIG, ...overrides } as NaxConfig;
}

describe("resolveDefaultAgent", () => {
  test("returns config.agent.default when set", () => {
    const c = cfg({ agent: { ...DEFAULT_CONFIG.agent, default: "codex" } });
    expect(resolveDefaultAgent(c)).toBe("codex");
  });

  test("returns DEFAULT_CONFIG.agent.default when agent block absent", () => {
    const c = cfg({ agent: undefined });
    expect(resolveDefaultAgent(c)).toBe("claude");
  });
});
