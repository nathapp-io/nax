import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { resolveDefaultAgent } from "@/agents";
import { pickSelector } from "@/config";

describe("resolveDefaultAgent in acceptance context", () => {
  test("resolves correctly", () => {
    const config = makeNaxConfig({ agent: { default: "claude" } });
    expect(resolveDefaultAgent(pickSelector("agent", "agent").select(config))).toBe("claude");
  });
});
