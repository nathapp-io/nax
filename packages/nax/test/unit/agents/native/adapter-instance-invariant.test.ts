import { describe, expect, test } from "bun:test";
import { NATIVE_AGENT } from "@nathapp/nax-agent";
import { makeNaxConfig } from "@test/helpers";
import { createAgentRegistry } from "@/agents/registry";

describe("native adapter instance invariant (S3 spec 5.2)", () => {
  test("one registry hands out one native adapter for every lookup", async () => {
    const registry = createAgentRegistry(makeNaxConfig());
    const first = registry.getAgent(NATIVE_AGENT);
    const second = registry.getAgent(NATIVE_AGENT);
    const installed = (await registry.getInstalledAgents()).find((a) => a.name === NATIVE_AGENT);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    if (installed !== undefined && first !== undefined) expect(installed).toBe(first);
  });
});
