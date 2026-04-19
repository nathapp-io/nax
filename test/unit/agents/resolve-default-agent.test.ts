import { describe, expect, test } from "bun:test";
import { resolveDefaultAgent } from "../../../src/agents/utils";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

function cfg(overrides: Record<string, unknown> = {}): NaxConfig {
  return { ...DEFAULT_CONFIG, ...overrides } as NaxConfig;
}

describe("resolveDefaultAgent", () => {
  test("returns config.agent.default when set", () => {
    const c = cfg({ agent: { ...DEFAULT_CONFIG.agent, default: "codex" } });
    expect(resolveDefaultAgent(c)).toBe("codex");
  });

  test("falls back to autoMode.defaultAgent when agent.default absent", () => {
    const c = cfg({ agent: { ...DEFAULT_CONFIG.agent, default: undefined } });
    expect(resolveDefaultAgent(c)).toBe(DEFAULT_CONFIG.autoMode.defaultAgent);
  });

  test("prefers canonical over legacy when both set", () => {
    const c = cfg({
      agent: { ...DEFAULT_CONFIG.agent, default: "gemini" },
      autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
    });
    expect(resolveDefaultAgent(c)).toBe("gemini");
  });
});
