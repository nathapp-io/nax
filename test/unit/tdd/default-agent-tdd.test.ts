import { describe, expect, test } from "bun:test";
import { resolveDefaultAgent } from "@/agents/utils";
import { DEFAULT_CONFIG } from "@/config/defaults";

describe("resolveDefaultAgent in tdd context", () => {
  test("returns agent.default when present", () => {
    const c = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, default: "gemini" } };
    expect(resolveDefaultAgent(c as never)).toBe("gemini");
  });
});
