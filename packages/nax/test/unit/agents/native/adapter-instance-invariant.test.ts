import { describe, expect, test } from "bun:test";
import { NATIVE_AGENT } from "@nathapp/nax-agent";
import { assertDefined, makeNaxConfig } from "@test/helpers";
import { createAgentRegistry } from "@/agents/registry";

describe("native adapter instance invariant (S3 spec 5.2)", () => {
  test("one registry hands out one native adapter for every lookup", async () => {
    const registry = createAgentRegistry(makeNaxConfig());
    const first = registry.getAgent(NATIVE_AGENT);
    const second = registry.getAgent(NATIVE_AGENT);
    const installed = (await registry.getInstalledAgents()).find((a) => a.name === NATIVE_AGENT);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    // Both must be present for the invariant to hold; assertDefined narrows for
    // tsc without an `if` guard that would let this leg silently no-op.
    assertDefined(first, "first native adapter");
    assertDefined(installed, "installed native adapter");
    expect(installed).toBe(first);
  });
});
