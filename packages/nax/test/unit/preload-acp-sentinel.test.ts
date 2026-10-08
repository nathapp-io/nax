import { describe, expect, test } from "bun:test";
import { _acpDeps } from "@/agents/acp";

describe("test preload: sdk backend spawn sentinel (S4b-4 D4-d)", () => {
  test("an unmocked acpBackend throws instead of spawning a real ACP agent", () => {
    expect(() => _acpDeps.acpBackend({ agent: "claude", allowUnsandboxed: true })).toThrow(
      "[test-preload] _acpDeps.acpBackend called without a mock",
    );
  });
});
