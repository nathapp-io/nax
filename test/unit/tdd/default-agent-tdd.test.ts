import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { resolveDefaultAgent } from "@/agents/utils";
import { agentConfigSelector } from "@/config/selectors";

describe("resolveDefaultAgent in tdd context", () => {
  test("returns agent.default when present", () => {
    const config = makeNaxConfig({ agent: { default: "gemini" } });
    expect(resolveDefaultAgent(agentConfigSelector.select(config))).toBe("gemini");
  });
});
