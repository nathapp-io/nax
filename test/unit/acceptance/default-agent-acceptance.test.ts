import { describe, expect, test } from "bun:test";
import { resolveDefaultAgent } from "../../../src/agents";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

describe("resolveDefaultAgent in acceptance context", () => {
  test("resolves correctly", () => {
    expect(
      resolveDefaultAgent({
        ...DEFAULT_CONFIG,
        agent: { ...DEFAULT_CONFIG.agent, default: "claude" },
      } as never)
    ).toBe("claude");
  });
});
