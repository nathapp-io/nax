import { describe, expect, test } from "bun:test";
import { createMockAgentManager } from "@test/helpers";

describe("PipelineContext agentManager propagation", () => {
  test("createMockAgentManager returns IAgentManager with getDefault()", () => {
    const mgr = createMockAgentManager("codex");
    expect(mgr.getDefault()).toBe("codex");
  });
});
