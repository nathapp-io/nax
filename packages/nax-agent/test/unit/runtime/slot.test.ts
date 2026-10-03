import { afterEach, describe, expect, test } from "bun:test";
import { type AgentRuntime, getAgentRuntime, nodeRuntime, setAgentRuntime } from "#src/runtime/index";

const fake: AgentRuntime = {
  ...nodeRuntime,
  spawn: () => {
    throw new Error("fake runtime");
  },
};

describe("agent runtime slot", () => {
  afterEach(() => setAgentRuntime(null));

  test("serves the Node runtime when nothing is installed", () => {
    expect(getAgentRuntime()).toBe(nodeRuntime);
  });

  test("serves the installed runtime", () => {
    setAgentRuntime(fake);
    expect(getAgentRuntime()).toBe(fake);
  });

  test("installing null restores the Node default", () => {
    setAgentRuntime(fake);
    setAgentRuntime(null);
    expect(getAgentRuntime()).toBe(nodeRuntime);
  });
});
