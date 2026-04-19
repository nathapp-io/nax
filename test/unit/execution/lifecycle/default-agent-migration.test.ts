import { describe, expect, test } from "bun:test";
import { resolveDefaultAgent } from "../../../../src/agents";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";

describe("resolveDefaultAgent — execution lifecycle", () => {
  test("resolves from canonical config.agent.default", () => {
    const config = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, default: "codex" } };
    expect(resolveDefaultAgent(config as never)).toBe("codex");
  });
});
