/**
 * Integration test: wrapAdapterAsManager must not be publicly exported.
 *
 * ADR-020 Wave 2 privatized wrapAdapterAsManager. Production code and tests
 * must use createRuntime(...).agentManager or the test-only fakeAgentManager.
 */

import { describe, expect, test } from "bun:test";

describe("ADR-020: wrapAdapterAsManager is forbidden", () => {
  test("is not exported from src/agents/utils", async () => {
    const mod = await import("../../../src/agents/utils");
    expect("wrapAdapterAsManager" in mod).toBe(false);
  });

  test("fakeAgentManager is available from test helpers", async () => {
    const { fakeAgentManager } = await import("../../helpers/fake-agent-manager");
    expect(typeof fakeAgentManager).toBe("function");
  });
});
