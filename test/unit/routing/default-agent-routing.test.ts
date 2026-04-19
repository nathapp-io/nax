import { describe, expect, test } from "bun:test";
import { resolveDefaultAgent } from "../../../src/agents/utils";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

describe("resolveDefaultAgent in routing context", () => {
  test("resolves from config", () => {
    expect(resolveDefaultAgent(DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.agent?.default ?? "claude");
  });
});
