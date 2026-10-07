import { describe, expect, test } from "bun:test";
import { _acpSdkDeps } from "@/agents/acp-sdk";

describe("test preload: sdk backend spawn sentinel (S4b-4 D4-d)", () => {
  test("an unmocked acpBackend throws instead of spawning a real ACP agent", () => {
    expect(() => _acpSdkDeps.acpBackend({ agent: "claude", allowUnsandboxed: true })).toThrow(
      "[test-preload] _acpSdkDeps.acpBackend called without a mock",
    );
  });
});
