import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { resolveDefaultAgent } from "@/agents";
import { agentConfigSelector } from "@/config/selectors";

describe("resolveDefaultAgent in acceptance context", () => {
  test("resolves correctly", () => {
    const config = makeNaxConfig({ agent: { default: "claude" } });
    expect(resolveDefaultAgent(agentConfigSelector.select(config))).toBe("claude");
  });
});
